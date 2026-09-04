import type { INestApplication } from '@nestjs/common';

import { CrmRepository } from '../src/modules/crm/crm.repository';
import { FakeCrmRepository } from '../src/modules/crm/__tests__/crm.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `crm` pour ses suites d'intégration et d'isolation (#56).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que ce qui est
 * propre au fichier client — la substitution de `CrmRepository` par son double
 * en mémoire.
 *
 * Ce double reproduit les propriétés qui comptent : le filtrage par le **vrai**
 * contexte de tenant — celui que l'extension Prisma consulte —, le filtre de
 * rôle qui rend un compte du personnel invisible, et le refus d'opérer hors
 * portée. Une garde qui n'ouvrirait pas la portée, ou qui l'ouvrirait sur le
 * mauvais établissement, fait donc rougir les suites.
 *
 * `IdentityRepository` est substitué par le harnais partagé, et il l'est ici
 * aussi : le module `crm` ne l'interroge jamais, mais `TenantScopeMiddleware`
 * si — c'est par lui qu'un slug d'URL devient un établissement, sur les routes
 * publiques des autres modules que cette application monte quand même.
 *
 * ## Le module n'a aucune surface publique
 *
 * D'où l'absence de `tenantSlug` ici, contrairement à `catalog.harness.ts` :
 * toutes les routes du fichier client se désignent par un jeton, aucune par un
 * slug d'URL. C'est la propriété la plus importante du module — il ne contient
 * que des données personnelles — et le harnais la reflète plutôt que d'offrir
 * une porte que rien n'emprunte.
 */

export interface CrmHarness {
  app: INestApplication;
  repository: FakeCrmRepository;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createCrmHarness(): Promise<CrmHarness> {
  const repository = new FakeCrmRepository();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: CrmRepository, useValue: repository }],
  });

  return {
    app: harness.app,
    repository,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    tokenFor: (role, forTenant) => harness.tokenFor(role, forTenant),
    bearer: (role, forTenant) => harness.bearer(role, forTenant),
    close: () => harness.close(),
  };
}
