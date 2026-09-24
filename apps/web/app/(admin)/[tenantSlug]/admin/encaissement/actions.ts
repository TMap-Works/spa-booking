'use server';

/**
 * Les actions de l'encaissement au comptoir (#59, reprises par #835).
 *
 * Même doctrine que le reste du back-office : le navigateur n'atteint l'API que
 * par ici, les jetons vivent dans les cookies `httpOnly` de `session.ts` et n'en
 * ressortent pas, et une action rend toujours un résultat plutôt qu'une
 * exception.
 *
 * ## Ce qui a disparu de ce fichier — ADR 0015
 *
 * `openCardPaymentAction` ouvrait une intention Stripe pour monter le formulaire
 * de carte dans la page du salon. Elle n'existe plus, et c'est le premier
 * critère de #835 : au comptoir, la carte passe par le **TPE autonome** de la
 * banque du salon. L'application ne lui parle pas, n'appelle aucun prestataire
 * et n'enregistre que l'issue que le caissier déclare — moyen, montant,
 * opérateur, horodatage, et le numéro du ticket du terminal s'il l'a relevé.
 *
 * `settleInCashAction` a disparu pour une autre raison : elle composait le
 * ticket **et** le réglait, d'un seul geste et pour tout le reste dû. Le
 * règlement mixte n'a pas de geste unique auquel se raccrocher — un ticket de
 * 78,00 € réglé par 50,00 € d'espèces puis 28,00 € au terminal, c'est deux
 * gestes sur une seule pièce —, et les deux temps sont désormais séparés :
 * {@link openCheckoutTicketAction} compose, {@link settleTicketAction} règle,
 * autant de fois qu'il le faut.
 *
 * ## Les refus de ces actions parlent la langue de l'appelant (#850)
 *
 * Les seuls messages écrits ici — une cible illisible — viennent du catalogue
 * `admin-checkout`, lu par `getTranslations` : une action serveur s'exécute dans
 * le contexte de la requête, donc dans la langue que le visiteur a obtenue. Les
 * autres refus viennent de l'API, et c'est `checkoutFailureMessage` qui les
 * nomme, sur leur **code**.
 */

import {
  settleSaleRequestSchema,
  slugSchema,
  uuidSchema,
  type SaleReceipt,
  type SaleSettlement,
  type SettleSaleRequest,
} from '@spa/shared';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { createSale, fetchAppointmentSales, fetchSaleReceipt, settleSale } from '@/lib/api-client';
import type { SaleSummary } from '@/lib/admin/payment-contract';

import { failure, invalid, type AdminActionResult } from '../action-result';
import { adminActionAccess } from '../session';

/**
 * Valide les deux entrées communes aux actions de rendez-vous.
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
 * Le ticket de caisse d'un rendez-vous — retrouvé s'il existe, composé sinon.
 *
 * ## Pourquoi on cherche avant de composer
 *
 * Parce que `sales.appointment_id` n'est pas unique, et qu'un second appel
 * composerait un second ticket. Le cas n'est pas théorique : c'est exactement ce
 * qu'un rafraîchissement au milieu d'un règlement mixte produirait — le reste dû
 * du premier ticket resterait en l'air, et la journée de caisse porterait deux
 * pièces pour une prestation. La lecture est donc la première chose que fait
 * cette action, et le ticket **non soldé** l'emporte : c'est celui qu'on est en
 * train de régler.
 *
 * ## Le prix relu, et l'écart qu'il faut connaître
 *
 * `POST /v1/sales` relit le prix de la prestation **au catalogue**, là où
 * `POST /v1/payments/cash` composait le ticket du rendez-vous au prix figé à la
 * réservation. Aucune route ne sait aujourd'hui composer ce ticket-là sans le
 * régler du même geste, et en ouvrir une relève
 * d'`apps/api/src/modules/payments`, hors de l'empreinte de #835 — une issue de
 * suivi la porte. En attendant, un tarif changé entre la réservation et le
 * comptoir se lit sur le ticket, et l'écran affiche le total **du ticket** comme
 * autorité, à côté du montant dû du rendez-vous : l'opérateur voit les deux
 * avant de confirmer, et annonce celui de la pièce.
 *
 * ## Ce que le corps ne porte pas
 *
 * Aucun montant. La demande porte une nature, un identifiant de prestation et
 * une quantité ; les quatre montants du ticket sont composés par le serveur et
 * vérifiés par une contrainte de la base (payments-stripe §4 et §5).
 */
export async function openCheckoutTicketAction(
  tenantSlug: string,
  appointmentId: string,
  serviceId: string,
): Promise<AdminActionResult<SaleSummary>> {
  const target = checkTarget(tenantSlug, appointmentId);
  const service = uuidSchema.safeParse(serviceId);

  if (target === null || !service.success) {
    return invalid((await getTranslations('admin-checkout'))('failure.unknownTarget'));
  }

  const access = await adminActionAccess(target.slug);

  if (!access.ok) {
    return access;
  }

  const { accessToken } = access;

  try {
    const existing = await fetchAppointmentSales(accessToken, target.appointmentId);
    // Le ticket encore ouvert d'abord ; à défaut le plus récent, qui dira de
    // lui-même qu'il est soldé (`remaining` à zéro) plutôt que d'en composer un
    // second sur une prestation déjà payée.
    const reusable = existing.find((sale) => sale.settledAt === null) ?? existing[0];

    if (reusable !== undefined) {
      return { ok: true, data: reusable };
    }

    return {
      ok: true,
      data: await createSale(accessToken, {
        appointmentId: target.appointmentId,
        lines: [{ kind: 'SERVICE', serviceId: service.data, quantity: 1 }],
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Inscrit **un** règlement sur un ticket — en totalité ou en partie.
 *
 * Aucun appel à un prestataire sur ce chemin, quel que soit le moyen : les
 * espèces n'en ont jamais eu, et la carte passe par le TPE de la banque du
 * salon, que l'application ne pilote pas (ADR 0015). Ce que l'action rend est
 * l'enveloppe de règlement — l'encaissement inscrit, le total, ce qui est réglé,
 * ce qu'il reste dû et la monnaie à rendre —, c'est-à-dire tout ce dont l'écran
 * a besoin pour dire si la cliente doit encore quelque chose.
 *
 * ## La clé d'idempotence vient de l'appelant, et c'est obligatoire
 *
 * La route n'est pas rejouable par construction : deux règlements de 25,00 € sur
 * le même ticket sont deux gestes distincts, et rien côté serveur ne les
 * distingue d'une double soumission. L'écran engendre donc une clé **par
 * geste** — au montage, pas au clic —, ce qui fait d'un double clic une
 * soumission rejouée plutôt qu'un second encaissement.
 *
 * ## Le corps est revalidé ici
 *
 * `settleSaleRequestSchema` est `.strict()` : il refuse ce qu'il ne connaît pas,
 * à commencer par un champ de carte glissé dans le corps. Le revalider côté
 * action n'est pas une redite du `ValidationPipe` de l'API — c'est ce qui
 * empêche notre propre serveur Next de relayer vers l'API un corps que personne
 * n'a regardé.
 */
export async function settleTicketAction(
  tenantSlug: string,
  saleId: string,
  request: SettleSaleRequest,
  idempotencyKey: string,
): Promise<AdminActionResult<SaleSettlement>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const sale = uuidSchema.safeParse(saleId);
  // Le corps, et non seulement la cible : une action serveur est un point
  // d'entrée **public** de notre front, et rien ne garantit qu'un appel vienne
  // de l'écran. Sans cette ligne, `apps/web` relayait vers l'API un corps que
  // personne n'avait regardé — exactement ce que l'en-tête ci-dessus annonce.
  const body = settleSaleRequestSchema.safeParse(request);
  // Les bornes de l'API (`common/validation/idempotency-key.ts`) : 8 à 128
  // caractères. La forme est libre — c'est l'appelant qui choisit sa clé — mais
  // elle voyage dans un en-tête HTTP, et un caractère hors de cet alphabet y
  // serait refusé par le transport avant même d'atteindre l'API.
  const key = z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/)
    .safeParse(idempotencyKey);

  if (!slug.success || !sale.success || !body.success || !key.success) {
    return invalid((await getTranslations('admin-checkout'))('failure.unknownTarget'));
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  try {
    return {
      ok: true,
      data: await settleSale(access.accessToken, sale.data, body.data, key.data),
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Le ticket de caisse d'une vente, tel que le comptoir l'affiche et l'imprime.
 *
 * C'est la pièce que l'API compose (`GET /sales/{id}/receipt`, #818) : l'écran
 * ne recalcule ni taxe ni total, il met en page ce qu'on lui rend — et c'est
 * elle qui porte **tous** les règlements du ticket, dans l'ordre où ils ont été
 * pris (quatrième critère de #835).
 */
export async function loadReceiptAction(
  tenantSlug: string,
  saleId: string,
): Promise<AdminActionResult<SaleReceipt>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const sale = uuidSchema.safeParse(saleId);

  if (!slug.success || !sale.success) {
    return invalid((await getTranslations('admin-checkout'))('failure.unknownReceiptTarget'));
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  try {
    return { ok: true, data: await fetchSaleReceipt(access.accessToken, sale.data) };
  } catch (error) {
    return failure(error);
  }
}
