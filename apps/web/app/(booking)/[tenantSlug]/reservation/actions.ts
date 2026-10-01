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
 * ## La phrase d'un refus vient du contrat, et le catalogue est l'exception — #1391
 *
 * C'est la décision que ce ticket avait à prendre avant d'écrire une ligne, parce
 * que ce module n'emploie ni `admin/action-result.ts` ni `refusalMessage` : il a
 * son propre fabricant de refus, et il écrivait la phrase de **chacun** depuis son
 * catalogue. La règle est désormais celle des autres modules d'actions d'`apps/web`,
 * ceux que `WEB_ACTION_ERROR_CODES` nomme :
 *
 * > la phrase d'un refus est `errorMessage(code, locale)` du contrat partagé ; le
 * > catalogue de la surface ne l'écrit que là où cette surface dit **mieux** que le
 * > contrat.
 *
 * Ce n'est pas une règle nouvelle, c'est celle que `lib/refusal.ts` encode depuis
 * #1327 — `refusalMessage(refusal, locale, own)`, où `own` est l'exception et
 * `errorMessage` le repli. Ce module la rejoint du côté qui la fabrique, là où
 * l'écran l'appliquait déjà du côté qui l'affiche.
 *
 * Les deux refus que cette action oppose d'elle-même tombent donc de part et
 * d'autre, et c'est le partage qui compte :
 *
 * | Refus | Phrase | Pourquoi |
 * |---|---|---|
 * | `VALIDATION_ERROR` — la requête de créneaux | catalogue, `tunnel.actions.availabilityIncomplete` | le contrat ne sait pas dire **de quelle** demande il s'agissait ; l'écran, oui |
 * | `TENANT_NOT_FOUND` — l'établissement illisible | contrat, par {@link unknownTenant} | « Cet établissement est introuvable. » est exactement ce qu'il y a à dire, et le contrat le dit dans les deux langues |
 *
 * **La surface est publique, et cela a été instruit plutôt que supposé.** Une
 * vitrine est indexable et sondable, et « cet établissement est introuvable » y est
 * une phrase qu'un visiteur non authentifié peut lire à volonté. Elle ne renseigne
 * pourtant personne : l'action ne demande **rien** à l'API pour la rendre, elle
 * constate que le segment d'URL n'a pas la forme d'une adresse de salon
 * (`slugSchema`). Aucun oracle d'existence, donc, et rien de ce que
 * `tenant-isolation` §4 interdit — la frontière d'établissement reste gardée par
 * l'API et par elle seule, qui confond en `NOT_FOUND` la ressource absente et celle
 * du voisin (`tenant-scope.middleware.ts`). L'instruction complète est en tête de
 * `WEB_ACTION_ERROR_CODES` (`packages/shared/src/errors/error-codes.ts`).
 *
 * Et **aucun écran n'a changé d'une ligne**, ce qui est le résultat qui compte :
 * `slot-step.tsx` lit déjà le refus par `refusalMessage`, dont le repli est le
 * contrat, et il ne nomme en propre que `VALIDATION_ERROR`. Un code distinct suffit
 * donc à lui faire dire la phrase qui nomme l'établissement, dans la langue de son
 * rendu — comme aux dix-neuf écrans de #1375.
 *
 * ## La langue (#846, #1298)
 *
 * Les messages de refus **écrits ici** s'affichent tels quels dans le tunnel :
 * celui qui vient du catalogue le lit donc par `getTranslations` — une action
 * serveur est asynchrone, et le crochet n'y a pas cours. Lequel vient du catalogue
 * et lequel du contrat est l'objet de la section ci-dessus.
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

/**
 * Refus faute d'établissement : le slug de l'URL n'en désigne aucun — #1391.
 *
 * Le jumeau local d'`unknownTenant()` du back-office
 * (`app/(admin)/[tenantSlug]/admin/action-result.ts`) et de celui de l'espace
 * client : ce module a son propre fabricant de refus, pour la raison dite en
 * tête — son `ActionResult` n'a pas de `details`, puisque rien ici ne lit celui
 * du corps d'erreur de l'API. La décision et ses raisons sont écrites là-bas et
 * dans `WEB_ACTION_ERROR_CODES` ; il n'y avait rien à rejuger, sinon **d'où la
 * phrase vient sur cette surface-ci**, et c'est l'objet de la section « La phrase
 * d'un refus vient du contrat » en tête de ce module.
 *
 * Synchrone et la langue en paramètre, comme {@link failure} et pour la même
 * raison : les appels à `next-intl/server` restent au seul endroit où la requête
 * est déjà attendue. Son appelant la lit sur place, et **seulement quand il
 * refuse** — le chargement qui aboutit n'interroge pas la requête pour une phrase
 * dont il n'a pas l'usage.
 */
function unknownTenant(locale: Locale): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
  };
}

export async function loadAvailabilityAction(
  tenantSlug: string,
  query: unknown,
): Promise<ActionResult<AvailabilityResponse>> {
  const slug = slugSchema.safeParse(tenantSlug);

  // Le slug se juge **seul et en premier** (#1391). Il partageait le `if` de la
  // charge utile, si bien que le refus rendu dépendait de l'ordre des tests d'un
  // `||` — et qu'un segment d'URL qui ne mène nulle part se disait « La demande
  // de disponibilités est incomplète. ». L'ordre est celui des modules repris avant
  // celui-ci, et pour la même raison : une adresse sans établissement rend la
  // requête sans objet, et reprocher sa plage de dates envoie chercher une faute
  // qu'on n'a pas commise.
  if (!slug.success) {
    return unknownTenant(await getLocale());
  }

  const t = await getTranslations('booking');
  const parsed = availabilityQuerySchema.safeParse(query);

  if (!parsed.success) {
    return invalid(t('tunnel.actions.availabilityIncomplete'));
  }

  try {
    return { ok: true, data: await fetchAvailability(slug.data, parsed.data) };
  } catch (error) {
    return failure(error, t('tunnel.actions.unexpectedError'), await getLocale());
  }
}

