import { Inject, Injectable } from '@nestjs/common';

import {
  PRISMA_UNSCOPED,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';

/**
 * Les deux requêtes du relevé de fuseaux persistés (#604).
 *
 * Un fichier à part d'`identity.repository.ts`, pour la raison qui a valu à
 * `reminder-sweep.repository.ts` d'être séparé de `notifications.repository.ts` :
 * c'est **ici** que le module injecte une seconde fois le client non scopé, et
 * `prisma-clients.ts` demande que chaque dérogation se voie. Un fichier dont le
 * nom annonce le traitement rend la relecture de
 * `grep -rn PRISMA_UNSCOPED apps/api/src` immédiate.
 *
 * La séparation n'est pas seulement documentaire. `IdentityRepository` est le
 * dépôt que servent les routes — `/api/v1/tenant`, `/api/v1/users`. Poser sur
 * cette classe un `updateMany` inter-tenant mettrait une écriture non scopée à
 * une complétion automatique de chaque gestionnaire de requête, et le jour où
 * quelqu'un l'appellerait depuis un contrôleur, rien ne le signalerait. Ici,
 * l'unique consommateur est `TenantTimezoneAuditService`, qui ne s'exécute pas
 * dans une requête HTTP.
 *
 * ## Pourquoi le client non scopé, et jusqu'où
 *
 * Le balayage a lieu à l'amorçage du module, hors de toute requête : il n'y a
 * pas de tenant courant, et le client scopé lèverait `MissingTenantContextError`
 * (tenant-isolation §3). C'est l'usage que `prisma-clients.ts` nomme —
 * « agrégats internes de la plateforme ».
 *
 * La dérogation s'arrête à **trois colonnes de `tenants`** : l'identifiant, le
 * slug et le fuseau. Aucune donnée métier — ni rendez-vous, ni cliente, ni
 * compte — ne passe par cette porte, et il n'existe donc pas de fuite
 * inter-tenant possible par oubli d'un `where`. `tenants` est par ailleurs la
 * seule table du schéma sans `tenant_id` : elle *est* le tenant.
 */

/** Une ligne `tenants` telle que l'audit la lit — trois colonnes, pas une de plus. */
export interface TenantTimeZoneRow {
  id: string;
  slug: string;
  timezone: string;
}

@Injectable()
export class TenantTimezoneAuditRepository {
  public constructor(
    // Balayage inter-tenant : le relevé des fuseaux invalides porte sur tous les
    // établissements à la fois, à l'amorçage du module et donc hors de toute
    // requête HTTP — l'usage que `prisma-clients.ts` nomme explicitement. La
    // dérogation s'arrête à `tenants.id`, `tenants.slug` et `tenants.timezone`.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /**
   * Les fuseaux de tous les établissements, ordonnés par slug.
   *
   * Pas de pagination : `tenants` porte une ligne par établissement, et le
   * relevé lit trois colonnes courtes. Le jour où le nombre d'établissements
   * rendrait ce balayage coûteux, c'est le traitement entier qui changera de
   * forme — une tâche planifiée plutôt qu'un amorçage —, pas ce `findMany`.
   *
   * Le tri est là pour la lecture des journaux : deux démarrages successifs
   * rendent les mêmes lignes dans le même ordre, ce qui rend deux relevés
   * comparables.
   */
  public async listTimeZones(): Promise<TenantTimeZoneRow[]> {
    return this.prismaUnscoped.tenant.findMany({
      select: { id: true, slug: true, timezone: true },
      orderBy: { slug: 'asc' },
    });
  }

  /**
   * Remplace le fuseau d'un établissement, **à condition** qu'il porte toujours
   * la valeur relevée.
   *
   * `updateMany` avec `timezone` dans le `where`, et non `update` sur la seule
   * clé primaire : c'est ce qui rend la réparation sûre entre le relevé et
   * l'écriture. Deux tâches ECS démarrent en même temps à chaque déploiement et
   * balaient la même table ; sans cette condition, la seconde réécrirait un
   * fuseau que la première a déjà réparé — ou, pire, écraserait la valeur
   * correcte qu'un gérant vient de saisir entre les deux.
   *
   * Le compte de lignes est donc la propriété utile : `1` la réparation a eu
   * lieu, `0` quelqu'un d'autre est passé avant — ou l'établissement a disparu.
   * Ni l'un ni l'autre n'est une erreur.
   */
  public async replaceTimeZone(
    tenantId: string,
    expected: string,
    fallback: string,
  ): Promise<boolean> {
    const { count } = await this.prismaUnscoped.tenant.updateMany({
      where: { id: tenantId, timezone: expected },
      data: { timezone: fallback },
    });

    return count === 1;
  }
}
