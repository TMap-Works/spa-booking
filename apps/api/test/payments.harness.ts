import type { INestApplication } from '@nestjs/common';

import { PaymentsRepository } from '../src/modules/payments/payments.repository';
import { StripeConfig } from '../src/modules/payments/stripe/stripe.config';
import { STRIPE_GATEWAY } from '../src/modules/payments/stripe/stripe.gateway';
import {
  FakePaymentsRepository,
  FakeStripeGateway,
  TEST_STRIPE_ENV,
  testStripeConfig,
} from '../src/modules/payments/__tests__/payments.doubles';
import { createTenantHarness, TENANT_A, TENANT_B, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `payments` pour ses suites d'intégration et d'isolation.
 *
 * C'est une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que ce qui est
 * propre à l'encaissement — trois substitutions, chacune pour une raison
 * distincte :
 *
 * 1. `PaymentsRepository` → son double en mémoire, qui reproduit le **scoping
 *    par tenant** de l'extension Prisma. C'est cette propriété-là que les
 *    suites de fuite exercent ; un double qui l'ignorerait ferait verdir
 *    exactement ce qu'on cherche.
 * 2. `STRIPE_GATEWAY` → une passerelle en mémoire. **Aucune suite de ce dépôt
 *    n'atteint Stripe**, live ou test (payments-stripe §7), et une suite qui
 *    dépendrait du réseau d'un tiers rougirait pour des raisons qui ne nous
 *    appartiennent pas.
 * 3. `StripeConfig` → une configuration complète, avec deux clés de
 *    remplissage. Sans elle, la suite dépendrait de l'environnement de la
 *    machine : verte sur un poste qui a des clés, rouge ailleurs.
 *
 * ## L'établissement entre par le slug d'URL, et par lui seul
 *
 * La route de ce module est publique — on paie sans compte comme on réserve
 * sans compte —, donc son établissement est résolu par `TenantScopeMiddleware`
 * à partir du `:tenantSlug` de l'URL, validé contre la table `tenants`. C'est
 * pourquoi ce harnais expose des **slugs** là où celui du catalogue expose
 * surtout des identifiants : les tentatives croisées se jouent en changeant le
 * slug de l'URL, pas le porteur d'un jeton.
 */

/** Slug public de l'établissement de l'appelant. */
export const TENANT_SLUG = TENANT_A.slug;
/** Slug public de l'établissement voisin. */
export const OTHER_TENANT_SLUG = TENANT_B.slug;

export interface PaymentsHarness {
  app: INestApplication;
  /** Le dépôt en mémoire — c'est par lui que les suites sèment rendez-vous et encaissements. */
  repository: FakePaymentsRepository;
  /** La passerelle en mémoire — commandes reçues, relectures, échec provoqué. */
  stripe: FakeStripeGateway;
  /** L'établissement de l'appelant. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Le slug par lequel l'espace public désigne `tenantId`. */
  tenantSlug: string;
  /** Le slug par lequel l'espace public désigne `otherTenantId`. */
  otherTenantSlug: string;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

export interface PaymentsHarnessOptions {
  /**
   * Monte l'application **sans clés Stripe**, pour le seul cas qui l'exige :
   * prouver qu'un déploiement non configuré répond 503 par requête plutôt que
   * de démarrer en silence.
   */
  readonly withoutStripeKeys?: boolean;
}

export async function createPaymentsHarness(
  options: PaymentsHarnessOptions = {},
): Promise<PaymentsHarness> {
  const repository = new FakePaymentsRepository();
  const stripe = new FakeStripeGateway();

  const config =
    options.withoutStripeKeys === true
      ? new StripeConfig({ NODE_ENV: 'test' })
      : testStripeConfig();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: PaymentsRepository, useValue: repository },
      { provide: STRIPE_GATEWAY, useValue: stripe },
      { provide: StripeConfig, useValue: config },
    ],
  });

  return {
    app: harness.app,
    repository,
    stripe,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    tenantSlug: harness.a.slug,
    otherTenantSlug: harness.b.slug,
    server: harness.server,
    close: harness.close,
  };
}

/** Les deux clés de remplissage, réexportées pour les assertions « ne fuit pas ». */
export { TEST_STRIPE_ENV };
