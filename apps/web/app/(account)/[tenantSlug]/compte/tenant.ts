import type { PublicTenant } from '@spa/shared';
import { cache } from 'react';

import { fetchPublicTenant } from '@/lib/api-client';

/**
 * L'établissement de l'espace client, résolu **une fois par rendu**.
 *
 * Le layout en a besoin pour son titre, chaque page pour le fuseau dans lequel
 * elle affiche les heures. Sans mémoïsation, la même vitrine serait lue deux ou
 * trois fois par navigation — le client HTTP est en `no-store`, précisément
 * parce que les créneaux ne se mettent pas en cache.
 *
 * `cache` de React borne la mémoïsation à **une passe de rendu** : deux
 * visiteuses ne partagent jamais la réponse, et une modification de la fiche du
 * salon est visible à la navigation suivante. C'est la portée qu'il faut ici —
 * un cache de plus longue durée ferait afficher un fuseau périmé, donc des
 * heures fausses.
 */
export const accountTenant = cache(
  async (tenantSlug: string): Promise<PublicTenant> => fetchPublicTenant(tenantSlug),
);
