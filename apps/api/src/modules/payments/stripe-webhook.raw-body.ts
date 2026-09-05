import type { RawBodyRequest } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { WebhookPayloadTooLargeError } from './payments.errors';

/**
 * Le lecteur de corps **brut** de la route de webhook — ce qui exclut cette
 * route, et elle seule, du parseur JSON global.
 *
 * ## Pourquoi le corps brut est non négociable
 *
 * La signature de Stripe porte sur les **octets** envoyés, pas sur l'objet
 * qu'ils décrivent. `JSON.parse` puis `JSON.stringify` rendent un texte
 * différent dès qu'un espace, l'ordre des clés ou la notation d'un nombre
 * changent — et le condensat ne correspond plus. Une route de webhook branchée
 * derrière `express.json()` échoue donc **systématiquement** à la vérification,
 * quelles que soient les clés (payments-stripe §3).
 *
 * ## Comment l'exclusion est obtenue
 *
 * Nest enregistre `express.json()` et `express.urlencoded()` dans `init()`
 * (`NestApplication.registerParserMiddleware`), c'est-à-dire **après** tout ce
 * que `configureApp` a monté par `app.use(…)`. Ce lecteur est donc en amont
 * d'eux, borné à un chemin unique, et consomme la requête jusqu'à `end`.
 *
 * `body-parser` sort alors immédiatement sur `onFinished.isFinished(req)` —
 * son propre garde-fou « body already parsed », qui est vrai dès que la requête
 * est entièrement lue. Ce n'est pas un contournement : c'est la voie par
 * laquelle body-parser lui-même cède la place à un lecteur amont.
 *
 * Le point est vérifié de bout en bout par `payments-webhook.integration-spec` :
 * une signature calculée sur les octets exacts est acceptée, et une charge dont
 * seule la mise en forme diffère est refusée. Si une version future de
 * body-parser changeait ce garde-fou, ce sont ces cas-là qui rougiraient.
 *
 * ## La borne de taille n'est pas décorative
 *
 * En sortant du parseur global, on sort aussi de sa limite par défaut (100 Kio).
 * Cette route est le seul point d'entrée public non authentifié de l'API :
 * sans borne, un corps de plusieurs gigaoctets serait accumulé en mémoire
 * avant même qu'une signature ne soit vérifiée. Un événement Stripe pèse
 * quelques kilo-octets ; 1 Mio laisse deux ordres de grandeur de marge.
 */

/**
 * Le chemin servi, tel qu'Express le voit — préfixe global et version compris.
 *
 * Il est déclaré **ici**, dans le module qui sert la route, et importé par
 * `bootstrap.ts` : deux chaînes en regard l'une de l'autre finiraient par
 * diverger, et la divergence se lirait en production sous la forme d'une
 * signature qui ne correspond jamais.
 */
export const STRIPE_WEBHOOK_PATH = '/api/v1/payments/webhooks/stripe';

/** Segment du contrôleur, sous le préfixe et la version que Nest ajoute. */
export const STRIPE_WEBHOOK_ROUTE = 'payments/webhooks/stripe';

/** Borne du corps accepté, en octets. Un événement Stripe en pèse quelques milliers. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/**
 * Le middleware, monté par `configureApp` — donc par `main.ts` **et** par tous
 * les harnais de test, qui câblent l'application par la même fonction.
 */
export function stripeWebhookRawBody(): RequestHandler {
  return function stripeWebhookRawBodyReader(
    request: Request,
    _response: Response,
    next: NextFunction,
  ): void {
    // Seul `POST` porte un corps signé. Laisser passer le reste évite de retenir
    // une requête `OPTIONS` de préflight, et laisse la route inconnue en `GET`
    // se conclure en 404 par le gestionnaire de Nest.
    if (request.method !== 'POST') {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      // `next()` nu et non `next(undefined)` : quelques intergiciels distinguent
      // les deux par `arguments.length`, et « pas d'erreur » doit se lire ainsi.
      if (error === undefined) {
        next();
        return;
      }
      next(error);
    };

    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        // Le flux n'est pas détruit : la réponse d'erreur part sur la même
        // connexion, et la couper ici la ferait avorter côté client. Les octets
        // restants sont lus et jetés, ce que la borne rend sans conséquence.
        settle(new WebhookPayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) {
        return;
      }
      // Le nom du champ est celui de Nest (`RawBodyRequest`) : le contrôleur le
      // lit avec le type que Nest publie, sans qu'on ait à en déclarer un. La
      // conversion est l'unique endroit où ce champ est écrit — `Request` d'Express
      // ne le déclare pas, c'est Nest qui l'ajoute.
      (request as RawBodyRequest<Request>).rawBody = Buffer.concat(chunks);
      settle();
    });

    // Coupure réseau en cours de lecture : l'erreur part au filtre plutôt que
    // de laisser la requête pendre jusqu'au délai de garde.
    request.on('error', (error: Error) => {
      settle(error);
    });
  };
}
