import { Inject, Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { AvailabilitySlotView, AvailabilityView } from './availability.types';

/**
 * Cache de disponibilité — clé, durée de vie et invalidation (#33 puis #35).
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
 * ## Ce que #35 ajoute au port posé par #33
 *
 * #33 n'avait besoin que de **jeter** : le cache n'existait pas encore, et un
 * port qui aurait exposé `get`/`set` aurait préempté la forme que le calcul de
 * créneaux déciderait. Cette forme est décidée ici, et le port l'accueille :
 * `readMany` et `writeMany`, en **lots**, parce qu'une interrogation porte sur
 * une plage de dates et non sur une journée — un aller-retour Redis par journée
 * mangerait le budget de 300 ms que ce cache existe pour tenir.
 *
 * ## Une journée par clé, et le fuseau dans la valeur
 *
 * La clé est `avail:{tenantId}:{serviceId}:{staffId}:{date}`, celle que fixe
 * booking-engine §3. La granularité de la journée n'est pas un détail : une
 * cliente qui fait glisser son calendrier d'un jour réutilise alors toutes les
 * journées déjà connues, là où une clé portant la plage entière aurait forcé un
 * recalcul complet à chaque pas.
 *
 * La valeur porte le **fuseau** en plus des créneaux. Sans lui, servir une
 * réponse entièrement issue du cache obligerait à relire `tenants` pour la seule
 * colonne `timezone` — une requête sur le chemin le plus chaud de l'API, qui
 * annulerait une bonne part du gain.
 *
 * ## Pourquoi le tenant entier à l'invalidation, et pas le seul praticien
 *
 * Le praticien est le **quatrième** segment de la clé : aucun préfixe ne le
 * désigne, et l'atteindre demanderait de balayer la totalité de l'espace de
 * clés pour ne garder que celles qui le mentionnent — plus coûteux que de tout
 * jeter. Le cache se reconstruit en une requête et vit soixante secondes ; une
 * granularité plus fine coûterait plus cher que ce qu'elle économise.
 *
 * Le préfixe **commence** par le tenant, ce qui garantit qu'une invalidation
 * d'un établissement ne peut pas toucher le cache d'un autre
 * (tenant-isolation §5).
 *
 * ## Qui lit ce cache, et qui ne le lit jamais
 *
 * Seul le chemin de **lecture** — `AvailabilityQueryService`, derrière
 * `GET /api/v1/availability`. Le chemin d'**écriture** de `appointments`
 * interroge `AvailabilityService` directement, sans passer par ici : c'est ce
 * qui rend vrai, par construction et non par vigilance, le cinquième critère de
 * #35 — « un cache périmé ne peut jamais provoquer une double réservation ».
 */

/** Jeton d'injection de l'entrepôt de cache — voir `AvailabilityCacheStore`. */
export const AVAILABILITY_CACHE_STORE = Symbol('AVAILABILITY_CACHE_STORE');

/** Une clé et sa valeur sérialisée, telles que l'entrepôt les écrit. */
export interface AvailabilityCacheEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Ce que le cache de disponibilité attend d'un entrepôt.
 *
 * Les trois opérations sont **en lots** ou par préfixe : aucune ne porte sur une
 * clé isolée, parce qu'aucun appelant n'en manipule une seule.
 *
 * Aucune ne rejette sur panne de l'entrepôt : un cache injoignable est un cache
 * vide, jamais une requête en échec. C'est l'implémentation qui porte cette
 * garantie — voir `RedisAvailabilityCacheStore` — parce qu'elle seule sait ce
 * qu'est une panne de son support.
 */
export interface AvailabilityCacheStore {
  /** Jette toutes les clés commençant par ce préfixe. */
  evictByPrefix(prefix: string): Promise<void>;
  /** Les valeurs des clés demandées, **dans l'ordre** ; `null` pour une absente. */
  readMany(keys: readonly string[]): Promise<readonly (string | null)[]>;
  /** Écrit chaque entrée avec la même durée de vie, en secondes. */
  writeMany(entries: readonly AvailabilityCacheEntry[], ttlSeconds: number): Promise<void>;
}

/** Racine de l'espace de clés du calcul de créneaux (booking-engine §3). */
export const AVAILABILITY_CACHE_NAMESPACE = 'avail';

/**
 * Durée de vie d'une journée en cache, en secondes — le TTL court du CDC.
 *
 * Soixante secondes est le chiffre de booking-engine §3, et l'arbitrage qu'il
 * porte est asymétrique : un créneau montré alors qu'il vient d'être pris coûte
 * un 409 et un reclic ; un créneau **masqué** alors qu'il est libre coûte une
 * vente. C'est pourquoi la borne est basse, et pourquoi elle est doublée d'une
 * invalidation explicite à chaque écriture plutôt que laissée seule.
 */
export const AVAILABILITY_CACHE_TTL_SECONDS = 60;

/**
 * Le segment qui remplace le praticien quand la cliente n'en désigne aucun.
 *
 * `any` ne peut pas entrer en collision avec un identifiant : les praticiens
 * sont des UUID, et le DTO refuse tout ce qui n'en est pas un. Sans ce segment,
 * la clé « tous praticiens » et celle d'un praticien nommé se confondraient, et
 * la première servirait les créneaux de la seconde — une réponse amputée, donc
 * des créneaux libres masqués.
 */
export const ANY_STAFF_KEY_SEGMENT = 'any';

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
 * La clé d'une journée de disponibilité — `avail:{tenant}:{service}:{staff}:{date}`.
 *
 * Le tenant est en tête, et c'est la seule position qui rende l'invalidation par
 * préfixe possible sans balayage (tenant-isolation §5).
 */
export function availabilityDayKey(
  tenantId: string,
  serviceId: string,
  staffId: string | undefined,
  date: string,
): string {
  return `${tenantAvailabilityKeyPrefix(tenantId)}${serviceId}:${staffId ?? ANY_STAFF_KEY_SEGMENT}:${date}`;
}

/** Ce qui identifie une interrogation, une fois le tenant retiré. */
export interface AvailabilityCacheQuery {
  readonly serviceId: string;
  readonly staffId?: string;
}

/**
 * La valeur d'une journée en cache.
 *
 * Le fuseau y est répété journée après journée, ce qui est un gaspillage assumé
 * de quelques octets : il évite une lecture de `tenants` sur le chemin servi
 * entièrement depuis le cache, et il rend chaque entrée **autonome** — une
 * journée relue est interprétable sans rien d'autre qu'elle-même.
 */
interface CachedDay {
  readonly timezone: string;
  readonly slots: readonly AvailabilitySlotView[];
}

/**
 * Lecture, écriture et invalidation du cache de l'établissement **courant**.
 *
 * Le tenant vient du contexte de requête, jamais d'un argument : un appelant qui
 * pourrait le choisir pourrait lire — ou invalider, donc sonder l'existence du —
 * cache d'un autre établissement (tenant-isolation §2).
 */
@Injectable()
export class AvailabilityCacheService {
  public constructor(
    @Inject(AVAILABILITY_CACHE_STORE) private readonly store: AvailabilityCacheStore,
    private readonly tenants: TenantContextService,
  ) {}

  /**
   * La réponse complète si **toutes** les journées demandées sont en cache,
   * `null` sinon.
   *
   * Tout ou rien, délibérément. Servir un mélange de journées cachées et de
   * journées recalculées demanderait de recalculer une sous-plage — donc de
   * découper la requête, donc de multiplier les allers-retours en base pour
   * économiser un calcul qui en tient déjà six. Le manque d'une seule journée
   * fait recalculer la plage entière, qui est ensuite écrite en entier : le pas
   * suivant du calendrier retombe alors sur un cache complet.
   *
   * Une entrée illisible — valeur tronquée, forme d'une version antérieure —
   * compte pour absente. Un cache n'est pas une source de vérité : ce qu'on n'en
   * comprend pas se recalcule, jamais ne fait échouer la requête.
   */
  public async readRange(
    query: AvailabilityCacheQuery,
    dates: readonly string[],
  ): Promise<AvailabilityView | null> {
    if (dates.length === 0) {
      return null;
    }

    const tenantId = this.tenants.requireTenantId();
    const values = await this.store.readMany(
      dates.map((date) => availabilityDayKey(tenantId, query.serviceId, query.staffId, date)),
    );

    if (values.length !== dates.length) {
      return null;
    }

    const days: { date: string; slots: readonly AvailabilitySlotView[] }[] = [];
    let timezone: string | null = null;

    for (const [index, value] of values.entries()) {
      const cached = parseCachedDay(value);

      if (cached === null) {
        return null;
      }

      // Un fuseau qui change en cours de plage ne peut venir que d'entrées
      // écrites de part et d'autre d'un changement de réglage. Les mélanger
      // rendrait un découpage en journées qui n'est celui d'aucun calendrier.
      if (timezone !== null && cached.timezone !== timezone) {
        return null;
      }

      timezone = cached.timezone;
      days.push({ date: dates[index] as string, slots: cached.slots });
    }

    if (timezone === null) {
      return null;
    }

    return { serviceId: query.serviceId, timezone, days };
  }

  /**
   * Écrit chaque journée de la réponse, avec le TTL court du CDC.
   *
   * La réponse est écrite telle qu'elle vient d'être calculée, y compris ses
   * journées vides : une journée sans créneau est une information, et l'omettre
   * ferait manquer le cache à chaque interrogation d'un salon fermé ce jour-là.
   */
  public async writeRange(query: AvailabilityCacheQuery, view: AvailabilityView): Promise<void> {
    if (view.days.length === 0) {
      return;
    }

    const tenantId = this.tenants.requireTenantId();

    await this.store.writeMany(
      view.days.map((day) => ({
        key: availabilityDayKey(tenantId, query.serviceId, query.staffId, day.date),
        value: JSON.stringify({ timezone: view.timezone, slots: day.slots } satisfies CachedDay),
      })),
      AVAILABILITY_CACHE_TTL_SECONDS,
    );
  }

  /** Chasse le cache de disponibilité de l'établissement **courant**. */
  public async invalidateCurrentTenant(): Promise<void> {
    await this.store.evictByPrefix(tenantAvailabilityKeyPrefix(this.tenants.requireTenantId()));
  }
}

/**
 * Une journée relue, ou `null` si elle n'est pas exploitable.
 *
 * La relecture est **défensive de bout en bout** : ce qui sort d'un cache
 * partagé n'a pas la garantie d'avoir été écrit par la version de code qui le
 * lit. Un déploiement qui change la forme d'un créneau croise nécessairement,
 * quelques secondes durant, des entrées de l'ancienne forme — et rendre ces
 * entrées-là au client servirait des créneaux qu'aucun schéma ne décrit.
 */
function parseCachedDay(value: string | null): CachedDay | null {
  if (value === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const candidate = parsed as { timezone?: unknown; slots?: unknown };

  if (typeof candidate.timezone !== 'string' || !Array.isArray(candidate.slots)) {
    return null;
  }

  const slots: AvailabilitySlotView[] = [];

  for (const slot of candidate.slots) {
    if (!isCachedSlot(slot)) {
      return null;
    }
    slots.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, staffId: slot.staffId });
  }

  return { timezone: candidate.timezone, slots };
}

/** Les trois champs d'un créneau, tous présents et tous des chaînes. */
function isCachedSlot(value: unknown): value is AvailabilitySlotView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const slot = value as { startsAt?: unknown; endsAt?: unknown; staffId?: unknown };

  return (
    typeof slot.startsAt === 'string' &&
    typeof slot.endsAt === 'string' &&
    typeof slot.staffId === 'string'
  );
}

/**
 * L'entrepôt qui ne stocke rien — le mode dégradé, et le double des tests.
 *
 * Il ne feint rien : toute lecture rend un défaut de cache, toute écriture est
 * perdue, et le journal `debug` rend l'appel observable. C'est exactement le
 * comportement attendu d'un cache absent — l'endpoint recalcule à chaque
 * requête, ce qui est plus lent mais jamais faux.
 *
 * Il reste utile après #35 pour deux usages : les harnais de test, qui n'ont pas
 * à dépendre d'un Redis joignable pour prouver le comportement d'un endpoint, et
 * le repli d'un déploiement sans cache configuré.
 */
@Injectable()
export class UnwiredAvailabilityCacheStore implements AvailabilityCacheStore {
  public constructor(private readonly logger: StructuredLogger) {}

  public evictByPrefix(prefix: string): Promise<void> {
    this.logger.debug(
      `Invalidation du cache de disponibilité « ${prefix}* » — aucun entrepôt branché.`,
      UnwiredAvailabilityCacheStore.name,
    );

    return Promise.resolve();
  }

  public readMany(keys: readonly string[]): Promise<readonly (string | null)[]> {
    return Promise.resolve(keys.map(() => null));
  }

  public writeMany(): Promise<void> {
    return Promise.resolve();
  }
}
