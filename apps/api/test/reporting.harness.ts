import type { INestApplication } from '@nestjs/common';

import { ReportingRepository } from '../src/modules/reporting/reporting.repository';
import {
  FakeReportingRepository,
  type StoredAppointment,
  type StoredPayment,
} from '../src/modules/reporting/__tests__/reporting.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `reporting` pour ses suites d'intégration et d'isolation
 * (#74).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que ce qui est
 * propre au reporting — la substitution de `ReportingRepository` par son double
 * en mémoire.
 *
 * Ce double reproduit les propriétés qui comptent : le filtrage par le **vrai**
 * contexte de tenant — celui que l'extension Prisma consulte et que le SQL brut
 * du module écrit à la main —, la fenêtre semi-ouverte, et le tri des statuts
 * d'encaissement qui font recette. Une garde qui n'ouvrirait pas la portée, ou
 * qui l'ouvrirait sur le mauvais établissement, fait donc rougir les suites.
 *
 * `IdentityRepository` est substitué par le harnais partagé, et il l'est ici
 * aussi : le module `reporting` ne l'interroge jamais, mais
 * `TenantScopeMiddleware` si — c'est par lui qu'un slug d'URL devient un
 * établissement, sur les routes publiques des autres modules que cette
 * application monte quand même.
 *
 * ## Le module n'a aucune surface publique
 *
 * D'où l'absence de `tenantSlug` ici, comme chez `crm.harness.ts` : les trois
 * routes de rapport se désignent par un jeton, aucune par un slug d'URL. Un
 * agrégat d'exploitation n'a pas de surface anonyme — le chiffre d'affaires d'un
 * salon ne se lit pas en connaissant son slug.
 */

export interface ReportingHarness {
  app: INestApplication;
  repository: FakeReportingRepository;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Sème un encaissement chez l'un des deux établissements. */
  seedPayment(payment: StoredPayment): void;
  /** Sème un rendez-vous chez l'un des deux établissements. */
  seedAppointment(appointment: StoredAppointment): void;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createReportingHarness(): Promise<ReportingHarness> {
  const repository = new FakeReportingRepository();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: ReportingRepository, useValue: repository }],
  });

  // Les deux établissements existent : sans fuseau, tout rapport répondrait 404
  // et les suites prouveraient la mauvaise chose. Des fuseaux **différents**,
  // pour qu'une confusion d'établissement se voie dans la réponse elle-même.
  repository.seedTenant(harness.a.id, 'Europe/Paris');
  repository.seedTenant(harness.b.id, 'Pacific/Tahiti');

  return {
    app: harness.app,
    repository,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    seedPayment: (payment) => {
      repository.seedPayment(payment);
    },
    seedAppointment: (appointment) => {
      repository.seedAppointment(appointment);
    },
    tokenFor: (role, forTenant) => harness.tokenFor(role, forTenant),
    bearer: (role, forTenant) => harness.bearer(role, forTenant),
    close: () => harness.close(),
  };
}
