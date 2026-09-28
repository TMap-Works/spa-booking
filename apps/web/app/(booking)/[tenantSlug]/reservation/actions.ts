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
 * ## La langue (#846, #1298)
 *
 * Les messages de refus **écrits ici** s'affichent tels quels dans le tunnel :
 * ils viennent donc du catalogue, par `getTranslations` — une action serveur
 * est asynchrone, et le crochet n'y a pas cours.
 *
 * Le message d'une `ApiClientError` était celui de l'API : il traversait cette
 * frontière sans être réécrit. La frontière du ticket d'alors le justifiait — la
 * langue des réponses de l'API relève de l'API —, mais l'API n'a pas de langue
 * de requête : ses `DomainError` sont écrites **en français**, une fois, pour le
 * journal et le diagnostic. Or ce message-là s'affiche : `slot-step.tsx` en fait
 * l'encart rouge sous le calendrier au premier refus de chargement — une limite
 * de débit, une fenêtre trop large. Un tunnel anglais y repassait au français,
 * au pire moment.
 *
 * La phrase vient donc de `errorMessage(code, locale)` du contrat partagé, comme
 * le back-office depuis #1234 et l'espace client depuis #847 : la table bilingue
 * adossée à `ERROR_CODES`, où un code que la table ne connaît pas — les
 * `HTTP_<statut>` que le filtre d'exception de l'API fabrique — retombe sur la
 * phrase générique d'`INTERNAL_ERROR`. Rien de ce que le tunnel **décide** ne
 * s'appuie dessus : le tri se fait sur le `code`, et les deux codes qui
 * deviennent une phrase à l'écran ont chacun la leur
 * (`SLOT_NO_LONGER_AVAILABLE`, `UNAUTHORIZED` — voir `booking-tunnel.tsx` et
 * `summary-step.tsx`). Il y en avait un troisième jusqu'à #1222 :
 * `CLIENT_EMAIL_NOT_BOOKABLE` est parti avec le champ `client` de la demande,
 * qu'aucune route n'émet plus.
 *
 * ## Ni l'annulation (#1201) ni la réservation (#1207) ne sont plus des actions
 *
 * `cancelAppointmentAction` puis `bookAppointmentAction` ont vécu ici, et
 * aucune des deux ne pouvait plus aboutir : leurs routes exigent le jeton de la
 * cliente — #1135 pour l'annulation et le report, #1136 pour la prise de
 * rendez-vous —, et une action serveur appelée depuis `/{slug}/reservation`
 * n'en reçoit aucun. Les deux cookies de session sont posés sur `/{slug}/compte`
 * (`compte/session.ts`), et le navigateur ne les joint qu'aux requêtes de ce
 * chemin-là. Les deux gestes visent donc une adresse de l'espace client, qui en
 * reçoit la session : `compte/rendez-vous/{id}/annulation` et
 * `compte/reservation`. Voir `cancellation-request.ts` et `booking-request.ts`,
 * qui portent l'arbitrage.
 *
 * Ce qui reste ici est ce que le tunnel fait **sans jeton**, et il n'y a plus
 * qu'une chose : lire des créneaux.
 */

import {
  ERROR_CODES,
  availabilityQuerySchema,
  errorMessage,
  slugSchema,
  type AvailabilityResponse,
  type Locale,
} from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiClientError, fetchAvailability } from '@/lib/api-client';

export type ActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Le refus, tel que l'écran le recevra.
 *
 * `fallback` est la phrase à servir quand l'erreur n'a pas de code du tout — ce
 * qui n'est pas une `ApiClientError` : une panne de rendu, un `TypeError`. Elle
 * est traduite par l'appelant, qui a le traducteur de la requête sous la main
 * (#846), et le tunnel la dit mieux que la phrase générique du contrat : elle
 * nomme ce que la visiteuse cherchait.
 *
 * `locale` sert l'autre branche, celle d'un refus que l'API a nommé : sa phrase
 * est celle de son `code` dans la table bilingue du contrat (#1298), jamais le
 * `message` du corps d'erreur. Les deux sont passés plutôt que lus ici, ce qui
 * garde cette fonction synchrone et les appels à `next-intl/server` au seul
 * endroit où la requête est déjà attendue.
 */
function failure(
  error: unknown,
  fallback: string,
  locale: Locale,
): { ok: false; code: string; message: string } {
  if (error instanceof ApiClientError) {
    return { ok: false, code: error.code, message: errorMessage(error.code, locale) };
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
    return failure(error, t('tunnel.actions.unexpectedError'), await getLocale());
  }
}

