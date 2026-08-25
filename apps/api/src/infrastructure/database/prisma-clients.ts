import type { PrismaClient } from '@prisma/client';

import { tenantScopeExtension } from './tenant-scope.extension';

/**
 * Les **deux seules portes** vers PostgreSQL par Prisma, et le fichier unique
 * qui les nomme.
 *
 * Le scoping automatique ne vaut que s'il n'existe aucun chemin qui le
 * contourne sans le dire. Ce fichier est donc l'unique endroit où le client non
 * scopé est exposé : `grep -rn PRISMA_UNSCOPED apps/api/src` rend la liste
 * complète des dérogations, et cette liste doit rester courte et relisible
 * (tenant-isolation §3).
 *
 * `PrismaService` — le client brut — n'est délibérément **pas exporté** par
 * `DatabaseModule`. Un repository qui l'injecterait obtiendrait un accès non
 * scopé sans qu'aucun nom ne le signale, ce qui est exactement le mode de
 * défaillance que ce ticket supprime. Il reste un provider interne, propriétaire
 * du cycle de vie de la connexion.
 */

/**
 * Le client **scopé** — celui que tout repository injecte, et le seul dont
 * l'usage n'a rien à justifier.
 *
 * ```ts
 * constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}
 * ```
 */
export const PRISMA = Symbol('PRISMA_SCOPED');

/**
 * Le client **non scopé** — l'échappatoire, réservée aux traitements
 * légitimement inter-tenants : création d'un établissement (aucun tenant courant
 * n'existe encore), balayage planifié des rappels J-1, agrégats internes de
 * la plateforme.
 *
 * Trois obligations à chaque usage, sans exception :
 *
 * 1. le nommer `prismaUnscoped` au site d'injection — le nom doit sauter aux
 *    yeux en revue ;
 * 2. un commentaire qui dit **pourquoi** le scoping ne s'applique pas ici ;
 * 3. un filtre par tenant écrit à la main dès que le traitement en vise un.
 *
 * ```ts
 * // Balayage inter-tenant : les rappels J-1 de tous les établissements sont
 * // planifiés par le même déclencheur, hors de toute requête HTTP.
 * constructor(@Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient) {}
 * ```
 */
export const PRISMA_UNSCOPED = Symbol('PRISMA_UNSCOPED');

/**
 * Applique l'extension de scoping à un client existant.
 *
 * `$extends` ne construit **pas** une seconde connexion : le client étendu
 * partage le moteur et le pool de son client de base. Les deux portes coûtent
 * donc une connexion, pas deux — et `onModuleDestroy` sur `PrismaService` les
 * ferme toutes les deux.
 */
// Le type de retour est **inféré** et non annoté : `$extends` produit un type
// structurel que Prisma calcule depuis l'extension elle-même, et que réécrire à
// la main reviendrait à le réécrire faux. `ScopedPrismaClient` le nomme juste
// après — annoter ici rendrait la paire circulaire.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function createScopedPrismaClient(base: PrismaClient) {
  return base.$extends(tenantScopeExtension);
}

/** Le client scopé, tel que `$extends` le type — jamais un `PrismaClient` nu. */
export type ScopedPrismaClient = ReturnType<typeof createScopedPrismaClient>;

/** Le client non scopé. Le type est nu : c'est le propos. */
export type UnscopedPrismaClient = PrismaClient;
