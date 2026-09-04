import type { INestApplication } from '@nestjs/common';

import { ServicesService } from '../src/modules/catalog/services.service';
import { PosRepository } from '../src/modules/payments/pos.repository';
import { FakePosRepository, FakeServicesService } from '../src/modules/payments/__tests__/pos.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du POS pour ses suites d'intégration et d'isolation (#60).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que ce qui est
 * propre à la caisse — deux substitutions, chacune pour une raison distincte :
 *
 * 1. `PosRepository` → son double en mémoire, qui reproduit le **scoping par
 *    tenant** de l'extension Prisma, le défaut fermé, et l'unicité
 *    `(tenantId, sku)`. C'est cette première propriété que les suites de fuite
 *    exercent ; un double qui l'ignorerait ferait verdir exactement ce qu'on
 *    cherche.
 * 2. `ServicesService` → un double du **service** du catalogue, et non de son
 *    dépôt. C'est bien `ServicesService.byId` que `SalesService` appelle
 *    (api-module §3), et c'est donc sa frontière — 404 hors de l'établissement
 *    courant — qu'il faut reproduire.
 *
 * `IdentityRepository` est substitué par le harnais partagé : le POS ne
 * l'interroge jamais, mais `TenantScopeMiddleware` si — c'est par lui qu'un slug
 * d'URL devient un établissement, sur les routes publiques que cette
 * application monte quand même.
 *
 * ## Le POS n'a aucune surface publique
 *
 * D'où l'absence de `tenantSlug` ici, contrairement à `payments.harness.ts` :
 * les cinq routes du POS se désignent par un jeton, aucune par un slug d'URL.
 * C'est délibéré — un ticket de caisse est une pièce comptable du salon, et son
 * rayon une donnée commerciale ; ni l'un ni l'autre n'a de raison d'avoir une
 * porte anonyme.
 */

export interface PosHarness {
  app: INestApplication;
  /** Le dépôt en mémoire — c'est par lui que les suites sèment articles et rendez-vous. */
  repository: FakePosRepository;
  /** Le catalogue en mémoire — c'est par lui que les suites sèment des prestations. */
  catalog: FakeServicesService;
  /** L'établissement de l'appelant. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenantId?: string): Promise<string>;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

export interface PosHarnessOptions {
  /** Taux de taxe des deux établissements, en points de base. `0` par défaut. */
  readonly taxRateBps?: number;
  /** Devise des deux établissements. `EUR` par défaut. */
  readonly currency?: string;
}

export async function createPosHarness(options: PosHarnessOptions = {}): Promise<PosHarness> {
  const repository = new FakePosRepository();
  const catalog = new FakeServicesService();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: PosRepository, useValue: repository },
      { provide: ServicesService, useValue: catalog },
    ],
  });

  // Les deux établissements sont paramétrés à l'identique : ce qui distingue les
  // scénarios de traversée doit être la portée, jamais une devise ou un taux qui
  // rendrait le refus explicable autrement.
  for (const tenantId of [harness.a.id, harness.b.id]) {
    repository.seedTenant({
      tenantId,
      defaultCurrency: options.currency ?? 'EUR',
      taxRateBps: options.taxRateBps ?? 0,
    });
  }

  return {
    app: harness.app,
    repository,
    catalog,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    tokenFor: (role, forTenant) => harness.tokenFor(role, forTenant),
    bearer: (role, forTenant) => harness.bearer(role, forTenant),
    server: harness.server,
    close: () => harness.close(),
  };
}
