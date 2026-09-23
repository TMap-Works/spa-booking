'use server';

/**
 * Les actions serveur du tunnel — la seule voie par laquelle le navigateur
 * atteint l'API.
 *
 * Aucun `fetch` vers l'API depuis un Client Component : le client HTTP lit
 * `API_URL`, qui n'existe que côté serveur (voir l'en-tête de
 * `lib/api-client.ts`). Le navigateur ne parle donc qu'à son propre domaine.
 *
 * ## Pourquoi ces actions rendent un résultat et ne lèvent pas
 *
 * Une exception traversant la frontière d'une action serveur est **masquée** en
 * production : Next remplace son message par un identifiant opaque, ce qui est
 * la bonne politique — un message d'erreur serveur n'a rien à faire dans un
 * navigateur. Mais le tunnel a besoin de distinguer un créneau perdu (409, cas
 * normal sous concurrence) d'une panne. Le code d'erreur du contrat est donc
 * transporté explicitement, dans une valeur sérialisable.
 *
 * ## La validation est refaite ici
 *
 * Le formulaire valide pour le confort, cette frontière valide pour la
 * correction : rien ne garantit qu'un appel d'action vienne du formulaire.
 * L'API revalidera de son côté — le front valide pour le confort, le back pour
 * la sécurité, jamais l'un sans l'autre (skill web-frontend §4).
 *
 * Elle **normalise** au passage : ce qui part vers l'API est la sortie
 * transformée du schéma — instant ramené en UTC, adresse canonisée, téléphone
 * en E.164 — et non le corps reçu du navigateur.
 *
 * ## La langue (#846)
 *
 * Les messages de refus **écrits ici** s'affichent tels quels dans le tunnel :
 * ils viennent donc du catalogue, par `getTranslations` — une action serveur
 * est asynchrone, et le crochet n'y a pas cours.
 *
 * Le message d'une `ApiClientError`, lui, reste celui de l'API : il traverse
 * cette frontière sans être réécrit, comme avant. Ce n'est pas un oubli mais la
 * frontière du ticket — la langue des réponses de l'API relève de l'API. Rien
 * de ce que le tunnel **décide** ne s'appuie dessus : le tri se fait sur le
 * `code`, et les trois codes qui deviennent une phrase à l'écran ont chacun la
 * leur (`SLOT_NO_LONGER_AVAILABLE`, `UNAUTHORIZED`,
 * `CLIENT_EMAIL_NOT_BOOKABLE` — voir `booking-tunnel.tsx` et `summary-step.tsx`).
 *
 * ## L'annulation n'est plus une action de ce tunnel (#1201)
 *
 * `cancelAppointmentAction` vivait ici, et elle ne pouvait plus aboutir : la
 * route de l'API exige depuis #1135 le jeton de la **cliente du rendez-vous**,
 * et une action serveur appelée depuis `/{slug}/reservation` n'en reçoit
 * aucun — les deux cookies de session sont posés sur `/{slug}/compte`
 * (`compte/session.ts`), et le navigateur ne les joint qu'aux requêtes de ce
 * chemin-là. Le lien d'annulation de l'écran de confirmation vise donc une
 * adresse de l'espace client, qui en reçoit la session :
 * `compte/rendez-vous/{id}/annulation`. Voir `cancellation-request.ts`, qui
 * porte l'arbitrage.
 *
 * Ce qui reste ici est ce que le tunnel fait **sans jeton** : lire des créneaux
 * et poser une réservation.
 */

import {
  ERROR_CODES,
  availabilityQuerySchema,
  bookGuestAppointmentRequestSchemaFor,
  slugSchema,
  type AvailabilityResponse,
  type BookedAppointment,
} from '@spa/shared';
import { getTranslations } from 'next-intl/server';

import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError, bookGuestAppointment, fetchAvailability } from '@/lib/api-client';

import { loadSalonTenant } from '../salon-data';

export type ActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Le refus, tel que l'écran le recevra.
 *
 * `fallback` est la phrase à servir quand l'erreur n'en porte pas d'affichable
 * — elle est traduite par l'appelant, qui a le traducteur de la requête sous la
 * main (#846). La passer plutôt que de la lire ici garde cette fonction
 * synchrone, et l'appel à `getTranslations` au seul endroit où la requête est
 * déjà attendue.
 */
function failure(error: unknown, fallback: string): { ok: false; code: string; message: string } {
  if (error instanceof ApiClientError) {
    return { ok: false, code: error.code, message: error.message };
  }

  return {
    ok: false,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: fallback,
  };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
function invalid(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

export async function loadAvailabilityAction(
  tenantSlug: string,
  query: unknown,
): Promise<ActionResult<AvailabilityResponse>> {
  const t = await getTranslations('booking');
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = availabilityQuerySchema.safeParse(query);

  if (!slug.success || !parsed.success) {
    return invalid(t('tunnel.actions.availabilityIncomplete'));
  }

  try {
    return { ok: true, data: await fetchAvailability(slug.data, parsed.data) };
  } catch (error) {
    return failure(error, t('tunnel.actions.unexpectedError'));
  }
}

/**
 * Compose et envoie la demande de réservation.
 *
 * ## Pourquoi l'établissement est chargé ici (#1028)
 *
 * Parce que c'est cette frontière-ci qui **normalise** le téléphone : ce qui
 * part vers l'API est `parsed.data`, la sortie transformée du schéma, et non le
 * corps reçu du navigateur. Depuis que la règle du téléphone admet un numéro
 * national complété par le pays de l'établissement, valider avec la variante
 * sans pays refuserait ici « 06 12 34 56 78 » que l'API accepte — et le refus
 * arriverait **après** la soumission, en bloc au récapitulatif, pour un numéro
 * que le champ venait d'accepter (web-frontend §4).
 *
 * Le pays est lu du salon et non reçu en argument : une action serveur ne tient
 * pour vrai rien de ce que le navigateur lui donne, et un pays fourni par
 * l'appelant reviendrait à laisser choisir son indicatif par défaut. C'est la
 * même colonne que le pipe de l'API consulte — `tenants.country_code`, publiée
 * dans l'adresse de la vitrine.
 *
 * Le coût est un `GET /public/{slug}` de plus, une fois par réservation
 * confirmée, sur un chargement déjà mémoïsé par requête (`salon-data.ts`). Le
 * payer ici est ce qui garde une seule écriture de la règle : la deviner
 * localement en ferait une seconde, qui divergerait au premier durcissement.
 *
 * ## Réserver exige un compte (2026-09-22)
 *
 * Le tunnel arrête la visiteuse sans compte avant ses coordonnées
 * (`AccountGateStep`), et cette frontière-ci refuse à son tour quand le cookie
 * de présence manque. Ce n'est pas un doublon : l'écran a été rendu avec la
 * présence **du chargement**, et une déconnexion survenue depuis — un autre
 * onglet, une session échue — ne se voit qu'ici. Le refus porte `UNAUTHORIZED`,
 * que le récapitulatif traduit en retour à l'écran de connexion.
 *
 * Ce contrôle borne le parcours du navigateur, pas l'API : le cookie de
 * présence sert à afficher et n'autorise rien (`lib/account-presence.ts`), et
 * `POST /public/{slug}/appointments` accepte encore une réservation sans
 * jeton. Fermer cette route-là est un changement de contrat de l'API.
 */
export async function bookAppointmentAction(
  tenantSlug: string,
  request: unknown,
): Promise<ActionResult<BookedAppointment>> {
  const t = await getTranslations('booking');
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid(t('tunnel.actions.bookingIncomplete'));
  }

  if ((await readAccountPresence()) === null) {
    return {
      ok: false,
      code: ERROR_CODES.UNAUTHORIZED,
      message: t('tunnel.actions.signInRequired'),
    };
  }

  try {
    const tenant = await loadSalonTenant(slug.data);
    const parsed = bookGuestAppointmentRequestSchemaFor(tenant.address?.country ?? null).safeParse(
      request,
    );

    if (!parsed.success) {
      return invalid(t('tunnel.actions.bookingIncomplete'));
    }

    return { ok: true, data: await bookGuestAppointment(slug.data, parsed.data) };
  } catch (error) {
    return failure(error, t('tunnel.actions.unexpectedError'));
  }
}

