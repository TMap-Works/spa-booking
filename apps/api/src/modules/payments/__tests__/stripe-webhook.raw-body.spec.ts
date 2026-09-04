import { Readable } from 'node:stream';

import type { RawBodyRequest } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { WebhookPayloadTooLargeError } from '../stripe-webhook.errors';
import {
  MAX_WEBHOOK_BODY_BYTES,
  STRIPE_WEBHOOK_PATH,
  STRIPE_WEBHOOK_ROUTE,
  stripeWebhookRawBody,
} from '../stripe-webhook.raw-body';

/**
 * Le lecteur de corps brut — la moitié applicative de « route exclue du parseur
 * JSON global ». L'autre moitié est son **montage** avant `init()`, que seul un
 * test d'intégration peut prouver : `test/payments-webhook.integration-spec.ts`
 * envoie une vraie requête et vérifie qu'une signature calculée sur les octets
 * exacts est acceptée.
 */

interface Capture {
  readonly request: RawBodyRequest<Request>;
  readonly done: Promise<Error | undefined>;
}

function run(chunks: readonly Buffer[], method = 'POST'): Capture {
  const stream = Readable.from(chunks) as unknown as Request;
  stream.method = method;

  let settle: (error: Error | undefined) => void = () => undefined;
  const done = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });

  const next: NextFunction = (error?: unknown) => {
    settle(error instanceof Error ? error : undefined);
  };

  stripeWebhookRawBody()(stream, {} as Response, next);

  return { request: stream as RawBodyRequest<Request>, done };
}

describe('stripeWebhookRawBody', () => {
  it('rend les octets exacts, sans les interpréter', async () => {
    // Le corps est délibérément mis en forme d'une façon qu'aucun
    // `JSON.stringify` ne reproduirait : c'est ce que la signature protège.
    const payload = Buffer.from('{  "id" : "evt_1"  }\n', 'utf8');
    const { request, done } = run([payload]);

    expect(await done).toBeUndefined();
    expect(request.rawBody?.equals(payload)).toBe(true);
  });

  it('recompose un corps arrivé en plusieurs fragments', async () => {
    const { request, done } = run([Buffer.from('{"id":'), Buffer.from('"evt_1"}')]);

    await done;

    expect(request.rawBody?.toString('utf8')).toBe('{"id":"evt_1"}');
  });

  it('accepte un corps vide plutôt que de laisser la requête pendre', async () => {
    // Un corps vide est irrecevable, mais c'est la vérification de signature qui
    // doit le dire — pas un délai de garde.
    const { request, done } = run([]);

    expect(await done).toBeUndefined();
    expect(request.rawBody?.length).toBe(0);
  });

  it('refuse un corps qui dépasse la borne', async () => {
    // En sortant du parseur global, on sort de sa limite par défaut. Sans borne,
    // le seul point d'entrée public non gardé de l'API accumulerait en mémoire
    // un corps non authentifié de taille arbitraire.
    const { done } = run([Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1)]);

    expect(await done).toBeInstanceOf(WebhookPayloadTooLargeError);
  });

  it('accepte exactement la borne', async () => {
    const { done } = run([Buffer.alloc(MAX_WEBHOOK_BODY_BYTES)]);

    expect(await done).toBeUndefined();
  });

  it('ne retient pas ce qui n’est pas un POST', async () => {
    // Une requête `OPTIONS` de préflight, ou un `GET` qui finira en 404 : rien à
    // lire, et surtout rien à retenir.
    const { request, done } = run([Buffer.from('ignoré')], 'OPTIONS');

    expect(await done).toBeUndefined();
    expect(request.rawBody).toBeUndefined();
  });

  it('ne conclut qu’une fois, même si le flux échoue après coup', async () => {
    const stream = Readable.from([Buffer.from('{}')]) as unknown as Request;
    stream.method = 'POST';
    const next = jest.fn();

    stripeWebhookRawBody()(stream, {} as Response, next);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.emit('error', new Error('connexion coupée'));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('sert le chemin que le contrôleur déclare', () => {
    // Deux chaînes en regard l'une de l'autre finiraient par diverger, et la
    // divergence se lirait en production comme une signature jamais valide.
    expect(STRIPE_WEBHOOK_PATH).toBe(`/api/v1/${STRIPE_WEBHOOK_ROUTE}`);
  });
});
