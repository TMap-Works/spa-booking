import type { INestApplication } from '@nestjs/common';

import { FakeStripeWebhookRepository } from '../src/modules/payments/__tests__/webhook.doubles';
import { WEBHOOK_QUEUE, type WebhookQueue } from '../src/modules/payments/stripe-webhook.queue';
import { StripeWebhookRepository } from '../src/modules/payments/stripe-webhook.repository';
import { computeSignature } from '../src/modules/payments/stripe/stripe-signature';
import { createTenantHarness, TENANT_A, TENANT_B, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du point d'entrée des webhooks pour ses suites d'intégration.
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`) : deux
 * établissements, l'application réellement câblée par `configureApp` — donc
 * avec le lecteur de corps brut monté avant le parseur JSON global, ce qui est
 * très exactement le point que ces suites doivent prouver.
 *
 * Une seule substitution propre au module : `StripeWebhookRepository`, remplacé
 * par son double en mémoire. Ce que le double **ne** prouve pas — que
 * l'extension Prisma tient la frontière, que la transaction annule bien la
 * marque d'idempotence quand l'effet échoue — se prouve contre un vrai moteur
 * dans `payments-webhook.isolation-spec.ts`.
 *
 * ## Les signatures sont vraies
 *
 * `sign()` passe par `computeSignature`, la fonction que le contrôleur emploie
 * pour vérifier. Ce n'est pas une tautologie : ce qui est éprouvé n'est pas que
 * l'algorithme se vérifie lui-même — les tests unitaires de
 * `stripe-signature.spec.ts` le confrontent à des vecteurs figés — mais que les
 * **octets** signés sont ceux qui arrivent au contrôleur. C'est ce qu'un
 * parseur JSON en amont casserait, et rien d'autre ne le montre.
 */

/** Le secret qu'attend l'application de test — posé par `test/setup-env.ts`. */
export const WEBHOOK_SECRET = 'whsec_test_not_a_secret_0003';

export const WEBHOOK_PATH = '/api/v1/payments/webhooks/stripe';

export interface WebhookHarness {
  readonly app: INestApplication;
  readonly repository: FakeStripeWebhookRepository;
  /** L'établissement de l'appelant. */
  readonly tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  readonly otherTenantId: string;
  readonly tenantSlug: string;
  readonly otherTenantSlug: string;
  /** Attend que la file ait consommé tout ce qui y a été mis. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function createWebhookHarness(): Promise<WebhookHarness> {
  const repository = new FakeStripeWebhookRepository();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: StripeWebhookRepository, useValue: repository }],
  });

  const queue = harness.app.get<WebhookQueue>(WEBHOOK_QUEUE);

  return {
    app: harness.app,
    repository,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    tenantSlug: TENANT_A.slug,
    otherTenantSlug: TENANT_B.slug,
    drain: () => queue.whenIdle(),
    close: () => harness.close(),
  };
}

/**
 * L'en-tête `Stripe-Signature` d'un corps donné, signé comme Stripe le signe.
 *
 * Le corps est passé en **chaîne**, jamais en objet : c'est l'appelant qui
 * décide des octets exacts, et c'est là tout l'intérêt — une suite peut signer
 * une mise en forme et en envoyer une autre.
 */
export function sign(
  body: string,
  options: { secret?: string; timestampSeconds?: number } = {},
): string {
  const secret = options.secret ?? WEBHOOK_SECRET;
  const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, Buffer.from(body, 'utf8'))}`;
}

/** Un corps d'événement Stripe, sérialisé une fois — les octets font foi. */
export function eventBody(
  type: string,
  object: Record<string, unknown>,
  eventId = 'evt_test_1',
): string {
  return JSON.stringify({ id: eventId, type, data: { object } });
}
