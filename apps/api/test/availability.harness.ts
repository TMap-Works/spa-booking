import type { INestApplication } from '@nestjs/common';

import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { FakeAvailabilityRepository } from '../src/modules/availability/__tests__/availability.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { createTenantHarness, type TenantFixture, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `availability` pour ses suites d'intégration et
 * d'isolation (#32).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27),
 * comme `catalog.harness.ts` : deux établissements, l'application réellement
 * câblée par `configureApp`, des jetons signés par le vrai `TokenService`. Il ne
 * reste ici que ce qui est propre à la disponibilité — la substitution
 * d'`AvailabilityRepository` par son double en mémoire, et le fuseau de chacun
 * des deux établissements.
 *
 * ## Deux fuseaux différents, délibérément
 *
 * `Europe/Paris` change d'heure deux fois par an ;
 * `Indian/Antananarivo` — le fuseau d'exploitation cité par le CDC — n'en change
 * jamais. Deux établissements dans le même fuseau laisseraient passer une
 * confusion de tenant sur toute conversion : les deux réponses seraient
 * identiques. Ici, une heure murale lue avec le fuseau du voisin se voit.
 *
 * Le module n'a **aucune surface publique** : ses quatre routes se désignent
 * toutes par un jeton, et il n'y a donc rien à résoudre par slug d'URL. C'est ce
 * qui distingue ce harnais de celui du catalogue, qui expose les deux.
 */

/** Fuseau de l'établissement de l'appelant — celui qui change d'heure. */
export const TENANT_TIMEZONE = 'Europe/Paris';

/** Fuseau de l'établissement voisin — sans heure d'été, et à un autre offset. */
export const OTHER_TENANT_TIMEZONE = 'Indian/Antananarivo';

export interface AvailabilityHarness {
  app: INestApplication;
  repository: FakeAvailabilityRepository;
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

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: AvailabilityRepository, useValue: repository }],
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
    a: harness.a,
    b: harness.b,
    tokenFor: (role, tenant) => harness.tokenFor(role, tenant),
    bearer: (role, tenant) => harness.bearer(role, tenant),
    close: () => harness.close(),
  };
}
