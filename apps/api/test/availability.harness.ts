import type { INestApplication } from '@nestjs/common';

import { AVAILABILITY_CACHE_STORE } from '../src/modules/availability/availability-cache';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { StaffTimeOffRepository } from '../src/modules/availability/staff-time-off.repository';
import { FakeAvailabilityRepository } from '../src/modules/availability/__tests__/availability.doubles';
import { FakeStaffTimeOffRepository } from '../src/modules/availability/__tests__/staff-time-off.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { MemoryAvailabilityCacheStore } from './availability-endpoint.harness';
import { createTenantHarness, type TenantFixture, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `availability` pour ses suites d'intégration et
 * d'isolation (#32, étendu aux absences par #303).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27),
 * comme `catalog.harness.ts` : deux établissements, l'application réellement
 * câblée par `configureApp`, des jetons signés par le vrai `TokenService`. Il ne
 * reste ici que ce qui est propre à la disponibilité — la substitution des deux
 * dépôts du module par leurs doubles en mémoire, et le fuseau de chacun des deux
 * établissements.
 *
 * ## Deux fuseaux différents, délibérément
 *
 * `Europe/Paris` change d'heure deux fois par an ;
 * `Indian/Antananarivo` — le fuseau d'exploitation cité par le CDC — n'en change
 * jamais. Deux établissements dans le même fuseau laisseraient passer une
 * confusion de tenant sur toute conversion : les deux réponses seraient
 * identiques. Ici, une heure murale lue avec le fuseau du voisin se voit.
 *
 * Le module n'a **aucune surface publique** sur ces routes-là : elles se
 * désignent toutes par un jeton, et il n'y a donc rien à résoudre par slug
 * d'URL. C'est ce qui distingue ce harnais de celui du catalogue, qui expose les
 * deux.
 *
 * ## Les huit routes de back-office, un seul harnais
 *
 * #32 servait les horaires récurrents et les jours de fermeture, qui ne
 * s'appuient que sur `AvailabilityRepository` ; #33 a ajouté les quatre routes
 * des absences, qui s'appuient sur `StaffTimeOffRepository` et sur le cache.
 * Les deux jeux de routes partagent l'établissement, les jetons et le fuseau :
 * un second harnais n'aurait dupliqué que cela, pour diverger au premier
 * ajustement. `StaffTimeOffRepository` est donc substitué ici aussi, et les
 * suites qui n'en font rien n'en paient qu'une instance vide.
 *
 * ## L'entrepôt de cache est en mémoire, et c'est nécessaire
 *
 * `AVAILABILITY_CACHE_STORE` est lié à `RedisAvailabilityCacheStore` depuis #35,
 * et **toutes** les écritures d'agenda du module l'appellent. Le laisser tel
 * quel ferait ouvrir une connexion Redis — avec son minuteur de réessai — à
 * chaque suite qui écrit un horaire ou une absence, pour un entrepôt dont le
 * comportement a déjà ses propres suites. L'entrepôt en mémoire rend ces
 * écritures déterministes **et** permet d'asserter que le cache du tenant a bien
 * été chassé, ce qui est la propriété qui s'oublie (`availability-cache.ts`).
 *
 * C'est `MemoryAvailabilityCacheStore` d'`availability-endpoint.harness.ts` qui
 * est réutilisé, plutôt qu'une seconde implémentation du même port : deux
 * entrepôts en mémoire divergeraient sur ce qu'ils considèrent comme un préfixe.
 */

/** Fuseau de l'établissement de l'appelant — celui qui change d'heure. */
export const TENANT_TIMEZONE = 'Europe/Paris';

/** Fuseau de l'établissement voisin — sans heure d'été, et à un autre offset. */
export const OTHER_TENANT_TIMEZONE = 'Indian/Antananarivo';

export interface AvailabilityHarness {
  app: INestApplication;
  repository: FakeAvailabilityRepository;
  /** Le dépôt des absences — c'est lui qui porte la clé composite `(tenant, staff)`. */
  timeOff: FakeStaffTimeOffRepository;
  /** L'entrepôt de cache, pour asserter qu'une écriture a bien chassé le tenant. */
  cache: MemoryAvailabilityCacheStore;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  a: TenantFixture;
  /** L'établissement voisin, pour les scénarios de traversée. */
  b: TenantFixture;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenant?: TenantFixture): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenant?: TenantFixture): Promise<string>;
  close(): Promise<void>;
}

export async function createAvailabilityHarness(): Promise<AvailabilityHarness> {
  const repository = new FakeAvailabilityRepository();
  const timeOff = new FakeStaffTimeOffRepository();
  const cache = new MemoryAvailabilityCacheStore();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: AvailabilityRepository, useValue: repository },
      { provide: StaffTimeOffRepository, useValue: timeOff },
      { provide: AVAILABILITY_CACHE_STORE, useValue: cache },
    ],
  });

  // Les deux établissements existent **avec leur fuseau** : sans ligne
  // `tenants`, le service répond 404 — ce qui est le comportement voulu pour un
  // jeton signé sur une portée disparue, et exactement ce qu'un test qui a
  // oublié de semer ne doit pas confondre avec une fuite refermée.
  repository.seedTenant({ id: harness.a.id, timezone: TENANT_TIMEZONE });
  repository.seedTenant({ id: harness.b.id, timezone: OTHER_TENANT_TIMEZONE });

  return {
    app: harness.app,
    repository,
    timeOff,
    cache,
    a: harness.a,
    b: harness.b,
    tokenFor: (role, tenant) => harness.tokenFor(role, tenant),
    bearer: (role, tenant) => harness.bearer(role, tenant),
    close: () => harness.close(),
  };
}
