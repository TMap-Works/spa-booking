import { ApiClientError, fetchPublicTenant } from './api-client';

/**
 * Ce qu'un écran sait d'un salon avant toute session : son nom, ou la raison
 * pour laquelle il ne le sait pas (#927).
 *
 * ## Trois issues, et pas deux
 *
 * « Ce salon n'existe pas » et « l'API ne répond pas » appellent deux réponses
 * différentes. La première se dit sur le champ qui a porté l'adresse, ou par un
 * 404 ; la seconde ne doit rien casser — un écran de connexion reste utilisable
 * sans le nom du salon au-dessus de son formulaire, et la page d'accueil reste
 * lisible sans le raccourci vers le dernier salon consulté.
 *
 * Ce n'est **pas** une lecture de session, et elle ne décide d'aucun droit :
 * la vitrine publique est ce qu'un visiteur anonyme peut lire de n'importe quel
 * salon (`public-tenant.controller.ts`). Le rail du back-office garde sa propre
 * décision, écrite une seule fois dans `loadAdminShell` (#760).
 */
export type SalonIdentity =
  | { readonly status: 'found'; readonly slug: string; readonly name: string }
  | { readonly status: 'unknown' }
  | { readonly status: 'unavailable' };

export async function readSalonIdentity(tenantSlug: string): Promise<SalonIdentity> {
  try {
    const tenant = await fetchPublicTenant(tenantSlug);

    return { status: 'found', slug: tenant.slug, name: tenant.name };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return { status: 'unknown' };
    }

    return { status: 'unavailable' };
  }
}
