import { Inject, Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * Invalidation du cache de disponibilité (#33, critère 4).
 *
 * ## Le problème, en une phrase
 *
 * Le calcul de créneaux est mis en cache avec un TTL court (booking-engine §3).
 * Un cache périmé qui montre un créneau déjà pris est **acceptable** : la
 * contrainte d'exclusion rattrape à la réservation. Un cache qui montre un
 * créneau pendant un congé ne se rattrape pas — le client réserve, la
 * réservation passe, et personne ne l'attend au salon. Toute écriture sur les
 * indisponibilités doit donc chasser le cache du tenant, sans attendre le TTL.
 *
 * ## Pourquoi le tenant entier, et pas le seul praticien
 *
 * La clé de cache est `avail:{tenantId}:{serviceId}:{staffId}:{date}`. Le
 * praticien y est le **quatrième** segment : aucun préfixe ne le désigne, et
 * l'atteindre demanderait de balayer la totalité de l'espace de clés pour ne
 * garder que celles qui le mentionnent — plus coûteux que de tout jeter. Le
 * cache se reconstruit en une requête et vit soixante secondes ; une
 * granularité plus fine coûterait plus cher que ce qu'elle économise.
 *
 * Le préfixe **commence** par le tenant, ce qui garantit qu'une invalidation
 * d'un établissement ne peut pas toucher le cache d'un autre
 * (tenant-isolation §5).
 *
 * ## Pourquoi un port, et pas Redis directement
 *
 * `CacheConnection` n'expose aujourd'hui que `ping()` : le cache de
 * disponibilité n'existe pas encore, c'est le calcul de créneaux (#34) qui
 * l'écrira, et c'est lui qui saura quelles commandes Redis il lui faut. Poser
 * ici l'adaptateur Redis reviendrait à décider à sa place de la forme du cache
 * qu'il n'a pas encore.
 *
 * Ce que ce ticket doit garantir, en revanche, c'est que **le chemin d'écriture
 * appelle l'invalidation** — le point qui s'oublie, et qui ne se rattrape pas
 * une fois le calcul de créneaux écrit ailleurs. Le port sépare les deux : la
 * règle « toute écriture invalide » est ici, vérifiée par les tests unitaires du
 * service, et le jour où #34 pose son adaptateur Redis, il remplace une ligne de
 * `AvailabilityModule` sans toucher à une seule écriture.
 */

/** Jeton d'injection de l'entrepôt de cache — voir `AvailabilityCacheStore`. */
export const AVAILABILITY_CACHE_STORE = Symbol('AVAILABILITY_CACHE_STORE');

/**
 * Ce que l'invalidation attend d'un cache : savoir jeter tout ce qui commence
 * par un préfixe. Volontairement réduit à cela — un port qui exposerait `get` et
 * `set` préempterait la forme du cache que #34 décidera.
 */
export interface AvailabilityCacheStore {
  evictByPrefix(prefix: string): Promise<void>;
}

/** Racine de l'espace de clés du calcul de créneaux (booking-engine §3). */
export const AVAILABILITY_CACHE_NAMESPACE = 'avail';

/**
 * Préfixe de toutes les clés de disponibilité d'un établissement.
 *
 * Le deux-points final n'est pas décoratif : sans lui, le préfixe du tenant
 * `abc` couvrirait aussi les clés du tenant `abcd`, et l'écriture de l'un
 * chasserait le cache de l'autre. La collision serait silencieuse et
 * intermittente — exactement le genre de défaut qu'on ne diagnostique pas.
 */
export function tenantAvailabilityKeyPrefix(tenantId: string): string {
  return `${AVAILABILITY_CACHE_NAMESPACE}:${tenantId}:`;
}

/**
 * Chasse le cache de disponibilité de l'établissement **courant**.
 *
 * Le tenant vient du contexte de requête, jamais d'un argument : un appelant qui
 * pourrait le choisir pourrait invalider — donc sonder l'existence du — cache
 * d'un autre établissement (tenant-isolation §2).
 */
@Injectable()
export class AvailabilityCacheService {
  public constructor(
    @Inject(AVAILABILITY_CACHE_STORE) private readonly store: AvailabilityCacheStore,
    private readonly tenants: TenantContextService,
  ) {}

  public async invalidateCurrentTenant(): Promise<void> {
    await this.store.evictByPrefix(tenantAvailabilityKeyPrefix(this.tenants.requireTenantId()));
  }
}

/**
 * L'entrepôt tant qu'aucun cache de disponibilité n'est écrit (#34).
 *
 * Il ne feint rien : il n'y a **aujourd'hui aucune clé `avail:*` en Redis**,
 * puisque rien ne calcule encore de créneaux. Jeter un espace de clés vide est
 * exactement le bon comportement, et le journaliser en `debug` rend l'appel
 * observable — c'est ainsi qu'on vérifie que le chemin d'écriture passe bien par
 * là, sans dépendre d'un cache qui n'existe pas.
 *
 * Sa substitution par un adaptateur Redis est un changement de provider dans
 * `AvailabilityModule`, et rien d'autre.
 */
@Injectable()
export class UnwiredAvailabilityCacheStore implements AvailabilityCacheStore {
  public constructor(private readonly logger: StructuredLogger) {}

  public evictByPrefix(prefix: string): Promise<void> {
    this.logger.debug(
      `Invalidation du cache de disponibilité « ${prefix}* » — aucun entrepôt branché (#34).`,
      UnwiredAvailabilityCacheStore.name,
    );

    return Promise.resolve();
  }
}
