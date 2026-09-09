import type { INestApplication } from '@nestjs/common';

import { ReportExportConfig } from '../src/modules/reporting/export/report-export.config';
import { REPORT_EXPORT_STORAGE } from '../src/modules/reporting/export/report-export.storage';
import { ReportingRepository } from '../src/modules/reporting/reporting.repository';
import { FakeReportExportStorage } from '../src/modules/reporting/__tests__/report-export.doubles';
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
 * D'où l'absence de `tenantSlug` ici, comme chez `crm.harness.ts` : les routes
 * de rapport se désignent par un jeton, aucune par un slug d'URL. Un agrégat
 * d'exploitation n'a pas de surface anonyme — le chiffre d'affaires d'un salon
 * ne se lit pas en connaissant son slug.
 *
 * ## L'entrepôt d'exports est substitué lui aussi (#563)
 *
 * `REPORT_EXPORT_STORAGE` est remplacé par un entrepôt en mémoire, et
 * `ReportExportConfig` par une configuration qui se déclare branchée. Sans les
 * deux, la route d'export répondrait 503 en test — ce qui est le bon défaut en
 * production, et ne prouverait rien ici.
 *
 * Les objets déposés restent **inspectables** par `storage` : c'est ce qui
 * permet à la suite d'isolation de vérifier la forme de la clé, et non seulement
 * le code de statut de la réponse.
 */

export interface ReportingHarness {
  app: INestApplication;
  repository: FakeReportingRepository;
  /** L'entrepôt d'exports en mémoire — les clés déposées s'y relisent. */
  storage: FakeReportExportStorage;
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
  const storage = new FakeReportExportStorage();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: ReportingRepository, useValue: repository },
      { provide: REPORT_EXPORT_STORAGE, useValue: storage },
      // Un bucket nommé mais jamais joint : c'est l'entrepôt substitué qui
      // répond. Ce que cette configuration décide réellement ici est la **durée
      // de vie** signée, que la suite d'intégration vérifie.
      {
        provide: ReportExportConfig,
        useValue: new ReportExportConfig({ REPORT_EXPORT_BUCKET: 'spa-test-reporting-exports' }),
      },
    ],
  });

  // Les deux établissements existent : sans fuseau, tout rapport répondrait 404
  // et les suites prouveraient la mauvaise chose. Des fuseaux **différents**,
  // pour qu'une confusion d'établissement se voie dans la réponse elle-même.
  // Des slugs différents aussi, pour la même raison — c'est le slug qui nomme le
  // fichier d'export.
  repository.seedTenant(harness.a.id, 'Europe/Paris', 'maison-lotus');
  repository.seedTenant(harness.b.id, 'Pacific/Tahiti', 'lagon-bleu');

  return {
    app: harness.app,
    repository,
    storage,
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
