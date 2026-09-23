import { bookedAppointmentSchema, ERROR_CODES, type BookedAppointment } from '@spa/shared';
import { z } from 'zod';

import { cancellationPath } from '../../../paths';

/**
 * L'appel d'annulation **depuis le navigateur**, et le seul module que l'écran
 * de confirmation du tunnel importe de l'espace client (#1201).
 *
 * ## Pourquoi un `fetch` et non une action serveur
 *
 * Une action serveur est servie sur l'URL de la page qui l'appelle. L'écran de
 * confirmation vit sur `/{slug}/reservation`, et les cookies de session sont
 * bornés à `/{slug}/compte` : le navigateur ne les joindrait pas, et la route de
 * l'API — gardée depuis #1135 — rendrait 401. Viser une adresse **de l'espace
 * client** est ce qui fait voyager la session, et c'est déjà la raison d'être de
 * `compte/flux/route.ts`. Voir `cancellationPath`.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il n'autorise rien et ne juge rien : le jeton est lu côté serveur, dans la
 * route, et la propriété du rendez-vous est tranchée par l'API — en 404, jamais
 * en 403 rendu tel quel (`compte/actions.ts`). Ici, on poste un identifiant et
 * on relit une réponse.
 */

/**
 * Ce que l'écran reçoit — la forme des actions serveur du tunnel et de l'espace
 * client, pour qu'un appelant n'ait pas deux façons de lire un refus.
 */
export type CancellationOutcome =
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
 * Annule le rendez-vous désigné, au nom de la cliente connectée.
 *
 * `fallbackMessage` est la phrase à servir quand la réponse n'en porte aucune
 * d'affichable — réseau coupé, passerelle qui rend du HTML. Elle est passée par
 * l'écran, qui a son catalogue traduit sous la main : ce module ne parle aucune
 * langue, et en importer une le rendrait dépendant de la surface qui l'appelle.
 */
export async function requestCancellation(
  tenantSlug: string,
  appointmentId: string,
  fallbackMessage: string,
): Promise<CancellationOutcome> {
  let payload: unknown;

  try {
    const response = await fetch(cancellationPath(tenantSlug, appointmentId), {
      method: 'POST',
      headers: { accept: 'application/json' },
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
