import {
  bookedAppointmentSchema,
  ERROR_CODES,
  type BookedAppointment,
  type BookGuestAppointmentRequest,
} from '@spa/shared';
import { z } from 'zod';

// L'adresse vient du module de chemins de l'espace client — le seul endroit du
// front qui sache comment elle s'écrit. Même importation, pour la même raison,
// que celle de `confirmation-step.tsx` : `paths.ts` est bâti pour être lu par un
// Client Component, il ne dépend de rien du serveur (voir son en-tête).
import { bookingRequestPath } from '@/app/(account)/[tenantSlug]/compte/paths';

/**
 * L'appel de réservation **depuis le navigateur** (#1207).
 *
 * ## Pourquoi un `fetch` et non l'action serveur d'avant
 *
 * Une action serveur est postée sur l'URL de la page qui l'appelle. Le tunnel
 * vit sur `/{slug}/reservation`, et les deux cookies de session sont posés sur
 * `/{slug}/compte` (`(account)/…/compte/session.ts`) : le navigateur ne les
 * joint donc à **aucune** requête du tunnel, fût-elle celle d'une cliente
 * connectée. `bookAppointmentAction` appelait en conséquence
 * `POST /public/{slug}/appointments` sans en-tête `Authorization`, et cette
 * route exigera le jeton de la cliente avec #1136 : 401, et le parcours critique
 * au rouge à l'étape « Confirmation » — ce qu'on a vu sur la PR #1206. La garde
 * n'est pas encore sur `develop` ; ce ticket la précède, pour que le tunnel
 * traverse son merge sans casser.
 *
 * Ce qui manquait n'était pas un paramètre, c'était une **adresse d'où la
 * session part**. `compte/reservation/route.ts` en est une, pour la raison
 * exacte qui met déjà sous `/{slug}/compte` l'annulation appelée du tunnel
 * (#1201) et le flux temps réel de la cliente.
 *
 * Élargir la portée des cookies au salon entier était l'autre issue, et elle
 * reste fermée : les jetons déjà posés sur le chemin étroit survivraient à la
 * déconnexion, et le navigateur enverrait les deux homonymes — le plus
 * spécifique d'abord, donc le périmé (`lib/account-presence.ts`).
 *
 * ## Pourquoi le chemin n'est pas écrit ici
 *
 * Toute la correction de ce ticket tient à une chose : que l'adresse postée soit
 * **dans la portée des cookies de session**. La réécrire ici en ferait une
 * seconde source de vérité, qui ne suivrait pas le renommage du segment
 * `compte` — et le tunnel reposterait hors de portée, sans `Authorization`,
 * c'est-à-dire exactement le 401 que #1207 corrige. Elle vient donc de
 * `compte/paths.ts`, comme `cancellationPath` pour l'annulation et
 * `accountFeedPath` pour le flux : ce module-là est le seul endroit du front qui
 * sache comment les adresses de l'espace client s'écrivent, et il est bâti pour
 * qu'un Client Component puisse le lire.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il n'autorise rien et ne juge rien : le jeton est lu côté serveur, dans la
 * route, et jamais par le navigateur. Ici, on poste une demande et on relit une
 * réponse.
 */

/**
 * Ce que l'écran reçoit — la forme des actions serveur du tunnel et de l'espace
 * client, pour qu'un appelant n'ait pas deux façons de lire un refus.
 */
export type BookingOutcome =
  | { readonly ok: true; readonly data: BookedAppointment }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * La réponse de la route, relue sans confiance.
 *
 * Même règle que le client d'API : une réponse hors contrat échoue à la
 * frontière plutôt que trois composants plus loin sur un `undefined`. Elle
 * traverse ici le réseau comme n'importe quelle autre — un proxy d'entreprise,
 * une page d'erreur de passerelle ou un déploiement à moitié fait peuvent rendre
 * tout autre chose qu'un JSON de cette forme.
 */
const outcomeSchema = z.union([
  z.object({ ok: z.literal(true), data: bookedAppointmentSchema }),
  z.object({ ok: z.literal(false), code: z.string().min(1), message: z.string().min(1) }),
]);

/**
 * Pose la réservation, au nom de la cliente connectée.
 *
 * `fallbackMessage` est la phrase à servir quand la réponse n'en porte aucune
 * d'affichable — réseau coupé, passerelle qui rend du HTML. Elle est passée par
 * l'écran, qui a son catalogue traduit sous la main : ce module ne parle aucune
 * langue, et en importer une le rendrait dépendant de la surface qui l'appelle.
 */
export async function requestBooking(
  tenantSlug: string,
  body: BookGuestAppointmentRequest,
  fallbackMessage: string,
): Promise<BookingOutcome> {
  let payload: unknown;

  try {
    const response = await fetch(bookingRequestPath(tenantSlug), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // `same-origin` est le défaut, et l'écrire est le propos : c'est le
      // navigateur qui joint les cookies de session, et il ne le fait que parce
      // que cette adresse est celle de l'espace client.
      credentials: 'same-origin',
    });

    payload = await response.json();
  } catch {
    return { ok: false, code: ERROR_CODES.SERVICE_UNAVAILABLE, message: fallbackMessage };
  }

  const parsed = outcomeSchema.safeParse(payload);

  return parsed.success
    ? parsed.data
    : { ok: false, code: ERROR_CODES.INTERNAL_ERROR, message: fallbackMessage };
}
