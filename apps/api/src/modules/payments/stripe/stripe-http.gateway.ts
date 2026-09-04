import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../../common/logging/structured-logger';
import { PaymentProviderUnavailableError } from '../payments.errors';
import { STRIPE_API_VERSION, StripeConfig } from './stripe.config';
import type {
  CreatePaymentIntentCommand,
  StripeGateway,
  StripePaymentIntent,
} from './stripe.gateway';

/**
 * L'implémentation HTTP du port Stripe — `fetch`, et rien d'autre.
 *
 * ## Pourquoi pas `stripe-node`
 *
 * Deux appels sont nécessaires ici : créer une intention, en relire une. Le SDK
 * officiel apporte pour cela une dépendance de plusieurs mégaoctets, sa propre
 * politique de nouvelle tentative et sa propre couche de types générés. `fetch`
 * est global depuis Node 18 et l'API Stripe est une API HTTP ordinaire :
 * formulaire encodé à l'aller, JSON au retour. Le jour où le module aura besoin
 * de Terminal, des Connect Accounts ou de la vérification de signature de
 * webhook (#58), le SDK entrera — **derrière `StripeGateway`**, sans qu'une
 * ligne du service ne bouge. C'est la raison d'être du port.
 *
 * ## Ce qui ne sort jamais d'ici
 *
 * - **La clé secrète.** Elle ne quitte `StripeConfig` que pour l'en-tête
 *   `Authorization`, et n'entre dans aucun message d'erreur ni dans aucun
 *   journal.
 * - **Le corps de réponse Stripe.** payments-stripe §1 l'interdit
 *   explicitement : « l'enregistrement d'un corps de requête Stripe complet
 *   dans les logs ». Seuls le statut HTTP, le type d'erreur et le code Stripe —
 *   trois valeurs énumérées, sans donnée personnelle ni référence de carte —
 *   sont journalisés.
 * - **Le `client_secret`.** Il est rendu à l'appelant et disparaît ; rien ne
 *   l'écrit nulle part. `redaction.ts` le couvre de toute façon, tout champ
 *   dont le nom contient « secret » étant expurgé.
 *
 * ## Ce qui n'y entre jamais
 *
 * Aucun numéro de carte, aucun cryptogramme, aucune date d'expiration : il n'y
 * a pas de paramètre pour les recevoir, et `automatic_payment_methods` laisse
 * Stripe présenter les moyens de paiement au navigateur, dans ses propres
 * iframes. C'est la définition opérationnelle de SAQ A.
 */

/** Base de l'API Stripe. Constante : il n'y a pas d'instance auto-hébergée. */
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Délai au-delà duquel l'appel est abandonné.
 *
 * Une intention de paiement est créée **dans le fil d'une requête HTTP
 * entrante** : sans borne, un Stripe lent immobiliserait un worker de l'API par
 * cliente en attente. Dix secondes laissent largement le temps d'un appel
 * nominal (~300 ms) tout en gardant l'échec rapide.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Ce que nous lisons d'une réponse `payment_intent`, et rien de plus. */
interface StripePaymentIntentPayload {
  id?: unknown;
  client_secret?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
}

/** L'enveloppe d'erreur de Stripe, réduite à ce qui est journalisable. */
interface StripeErrorPayload {
  error?: { type?: unknown; code?: unknown };
}

function asStripeIntent(payload: unknown): StripePaymentIntent | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }

  const { id, client_secret, status, amount, currency } = payload as StripePaymentIntentPayload;

  if (
    typeof id !== 'string' ||
    typeof client_secret !== 'string' ||
    typeof status !== 'string' ||
    typeof amount !== 'number' ||
    typeof currency !== 'string'
  ) {
    return null;
  }

  return { id, clientSecret: client_secret, status, amountMinor: amount, currency };
}

/**
 * Le couple `(type, code)` de l'erreur Stripe — les deux seules valeurs de son
 * corps qui soient énumérées, donc sûres à journaliser.
 */
function describeStripeError(payload: unknown): { type: string; code: string } {
  if (payload === null || typeof payload !== 'object') {
    return { type: 'unknown', code: 'unknown' };
  }

  const { error } = payload as StripeErrorPayload;

  if (error === null || typeof error !== 'object') {
    return { type: 'unknown', code: 'unknown' };
  }

  return {
    type: typeof error.type === 'string' ? error.type : 'unknown',
    code: typeof error.code === 'string' ? error.code : 'unknown',
  };
}

@Injectable()
export class StripeHttpGateway implements StripeGateway {
  public constructor(
    private readonly config: StripeConfig,
    private readonly logger: StructuredLogger,
  ) {}

  public async createPaymentIntent(
    command: CreatePaymentIntentCommand,
  ): Promise<StripePaymentIntent> {
    const form = new URLSearchParams();
    // Entier, dans la plus petite unité de la devise — jamais un flottant
    // (payments-stripe §5). Notre schéma stocke déjà `amount_minor` dans cette
    // unité, et Stripe attend exactement la même : la valeur passe telle
    // quelle, sans multiplication par cent. C'est ce qui la rend juste aussi
    // pour les devises sans sous-unité (JPY, MGA), où « ×100 » serait faux.
    form.set('amount', String(command.amountMinor));
    // Stripe attend le code en minuscules ; le nôtre est en ISO 4217 majuscule.
    form.set('currency', command.currency.toLowerCase());
    // Laisse Stripe choisir et présenter les moyens de paiement, dans **ses**
    // iframes. C'est ce qui dispense notre front d'un champ carte maison.
    form.set('automatic_payment_methods[enabled]', 'true');

    for (const [key, value] of Object.entries(command.metadata)) {
      form.set(`metadata[${key}]`, value);
    }

    const payload = await this.call('/payment_intents', {
      method: 'POST',
      body: form,
      // L'en-tête d'idempotence de Stripe : rejoué avec la même clé, l'appel
      // rend l'intention déjà créée plutôt que d'en créer une seconde.
      idempotencyKey: command.idempotencyKey,
    });

    return this.parse(payload, 'create');
  }

  public async retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
    // `encodeURIComponent` bien que l'identifiant vienne de notre base : il y
    // est entré par une réponse Stripe, mais une valeur relue n'est pas une
    // valeur vérifiée, et un identifiant porteur d'un « / » changerait la route
    // appelée.
    const payload = await this.call(`/payment_intents/${encodeURIComponent(id)}`, {
      method: 'GET',
    });

    return this.parse(payload, 'retrieve');
  }

  /**
   * Un appel à l'API Stripe, borné dans le temps, dont l'échec ne fuit rien.
   *
   * Toute issue non nominale — statut non-2xx, coupure réseau, délai dépassé,
   * corps illisible — se termine en `PaymentProviderUnavailableError`. C'est
   * délibérément une seule erreur : le tunnel n'a qu'une conduite pour toutes,
   * et les distinguer dans la réponse ferait de cette route une sonde de l'état
   * de notre compte Stripe.
   */
  private async call(
    path: string,
    options: { method: 'GET' | 'POST'; body?: URLSearchParams; idempotencyKey?: string },
  ): Promise<unknown> {
    if (!this.config.isConfigured) {
      // Poste de développement sans compte Stripe. Le refus est explicite et
      // par requête, plutôt qu'un appel parti avec un en-tête `Bearer
      // undefined` dont Stripe rendrait un 401 illisible.
      this.logger.error('Aucune clé Stripe configurée', { path });
      throw new PaymentProviderUnavailableError();
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      // Épinglée : voir `STRIPE_API_VERSION`.
      'Stripe-Version': STRIPE_API_VERSION,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let response: Response;

    try {
      response = await fetch(`${STRIPE_API_BASE}${path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // Le message d'une erreur réseau peut porter l'URL appelée ; le nom de la
      // classe (`TimeoutError`, `TypeError`) suffit au diagnostic et ne porte
      // rien.
      this.logger.error('Appel Stripe impossible', {
        path,
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
      throw new PaymentProviderUnavailableError();
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const { type, code } = describeStripeError(payload);
      // Trois valeurs énumérées, et pas le corps : payments-stripe §1 interdit
      // d'écrire une réponse Stripe complète dans les journaux.
      this.logger.error('Stripe a refusé l’appel', { path, status: response.status, type, code });
      throw new PaymentProviderUnavailableError();
    }

    return payload;
  }

  private parse(payload: unknown, operation: 'create' | 'retrieve'): StripePaymentIntent {
    const intent = asStripeIntent(payload);

    if (intent === null) {
      // Le corps n'est pas journalisé : une réponse inattendue est justement
      // celle dont on ne sait pas ce qu'elle contient.
      this.logger.error('Réponse Stripe inexploitable', { operation });
      throw new PaymentProviderUnavailableError();
    }

    return intent;
  }
}
