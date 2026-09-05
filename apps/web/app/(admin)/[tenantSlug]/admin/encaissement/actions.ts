'use server';

/**
 * Les deux actions de l'encaissement au comptoir (#59).
 *
 * Même doctrine que le reste du back-office : le navigateur n'atteint l'API que
 * par ici, les jetons vivent dans les cookies `httpOnly` de `session.ts` et n'en
 * ressortent pas, et une action rend toujours un résultat plutôt qu'une
 * exception.
 *
 * ## Ce que `openCardPaymentAction` rend, et pourquoi ce ne sont pas des jetons
 *
 * Elle rend un `clientSecret` et une clé **publiable**. La règle « aucune action
 * ne rend un jeton » vise les jetons de session, qui ouvrent tout l'espace de
 * leur porteur ; ces deux valeurs-là n'ouvrent rien de tel :
 *
 * - `clientSecret` est un laissez-passer à usage unique lié à **une** intention,
 *   qui n'autorise que sa confirmation. C'est le mécanisme même de Stripe
 *   Elements : sans lui, aucun paiement par carte n'est possible dans un
 *   navigateur ;
 * - `publishableKey` est publiable par définition (payments-stripe §7). La clé
 *   secrète, elle, ne quitte jamais le serveur d'API.
 *
 * ## Pourquoi les deux actions exigent une session, même celle qui appelle une
 * route publique
 *
 * `POST /public/{slug}/payments/intents` n'est pas gardée — on réserve sans
 * compte, donc on paie sans compte. Mais une action serveur est un **point
 * d'entrée public de notre front** : exportée sans garde, elle ferait de
 * `apps/web` un relais anonyme vers cette route, sortant par l'adresse du
 * serveur Next et consommant pour tout le monde le quota de dix ouvertures par
 * minute et par adresse. Le jeton de comptoir n'ajoute donc pas une autorisation
 * que l'API exigerait : il empêche notre propre serveur de servir d'amplificateur.
 */

import { slugSchema, uuidSchema } from '@spa/shared';

import { openAppointmentPaymentIntent, settleAppointmentInCash } from '@/lib/api-client';
import type { AppointmentPaymentIntent, PaymentTransaction } from '@/lib/admin/payment-contract';

import { expired, failure, invalid, type AdminActionResult } from '../action-result';
import { readAdminAccessToken } from '../session';

/**
 * Valide les deux entrées communes aux deux actions.
 *
 * `tenantSlug` et `appointmentId` arrivent du navigateur : rien ne garantit
 * qu'un appel d'action vienne de l'écran. Ils sont donc revalidés ici, comme
 * partout ailleurs — le front valide pour le confort, l'API pour la sécurité, et
 * l'action pour les deux (web-frontend §4).
 */
function checkTarget(
  tenantSlug: string,
  appointmentId: string,
): { readonly slug: string; readonly appointmentId: string } | null {
  const slug = slugSchema.safeParse(tenantSlug);
  const target = uuidSchema.safeParse(appointmentId);

  return slug.success && target.success
    ? { slug: slug.data, appointmentId: target.data }
    : null;
}

/**
 * Ouvre le paiement par carte d'un rendez-vous.
 *
 * **Idempotente côté API** : appelée deux fois pour le même rendez-vous, elle
 * rend deux fois la même intention. Un double clic ou un onglet rouvert ne
 * produit jamais deux débits — c'est la contrainte d'unicité en base et la clé
 * d'idempotence Stripe qui le tiennent, pas une vérification d'écran.
 *
 * Elle **ne confirme rien**. Elle rend de quoi payer ; la confirmation est
 * l'affaire du webhook signé, reçu côté serveur. Ne jamais faire passer un
 * rendez-vous en règlement abouti sur la seule réponse du navigateur
 * (payments-stripe §2).
 */
export async function openCardPaymentAction(
  tenantSlug: string,
  appointmentId: string,
): Promise<AdminActionResult<AppointmentPaymentIntent>> {
  const target = checkTarget(tenantSlug, appointmentId);

  if (target === null) {
    return invalid('Rendez-vous ou établissement inconnu.');
  }

  if ((await readAdminAccessToken()) === null) {
    return expired();
  }

  try {
    return {
      ok: true,
      data: await openAppointmentPaymentIntent(target.slug, target.appointmentId),
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Règle un rendez-vous en espèces.
 *
 * Aucun appel au prestataire sur ce chemin, et aucun montant envoyé : le prix
 * est celui figé à la réservation, relu en base, et l'opérateur vient du jeton
 * vérifié. Ce que l'action rend est l'encaissement **inscrit** — statut, montant
 * et instant de capture —, donc de quoi imprimer un reçu qui fait foi.
 */
export async function settleInCashAction(
  tenantSlug: string,
  appointmentId: string,
): Promise<AdminActionResult<PaymentTransaction>> {
  const target = checkTarget(tenantSlug, appointmentId);

  if (target === null) {
    return invalid('Rendez-vous ou établissement inconnu.');
  }

  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    return { ok: true, data: await settleAppointmentInCash(accessToken, target.appointmentId) };
  } catch (error) {
    return failure(error);
  }
}
