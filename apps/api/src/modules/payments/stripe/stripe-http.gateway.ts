import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../../common/logging/structured-logger';
import { PaymentProviderRefusedError, PaymentProviderUnavailableError } from '../payments.errors';
import { STRIPE_API_VERSION, StripeConfig } from './stripe.config';
import type {
  CreatePaymentIntentCommand,
  CreateRefundCommand,
  StripeGateway,
  StripePaymentIntent,
  StripeRefund,
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

/** Ce que nous lisons d'une réponse `refund`, et rien de plus (#63). */
interface StripeRefundPayload {
  id?: unknown;
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

function asStripeRefund(payload: unknown): StripeRefund | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }

  const { id, status, amount, currency } = payload as StripeRefundPayload;

  if (
    typeof id !== 'string' ||
    typeof status !== 'string' ||
    // Entier, jamais un flottant : un montant à virgule ici serait le signe
    // d'un corps mal lu, et l'accepter ferait entrer un `float` sur le chemin
    // de l'argent (payments-stripe §5).
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    typeof currency !== 'string'
  ) {
    return null;
  }

  return { id, status, amountMinor: amount, currency };
}

/**
 * `true` si ce statut HTTP dit « je n'ai rien fait », de façon définitive.
 *
 * Un 4xx a été reçu, compris et rejeté : aucune opération n'a été engagée chez
 * le prestataire. `429` est la seule exception — un quota dépassé n'est pas un
 * refus de l'opération, c'est un « plus tard », et le traiter comme définitif
 * ferait relâcher une réservation qu'une reprise réémettrait.
 *
 * Tout le reste — 5xx, et par extension une absence de réponse — laisse le sort
 * de l'opération **inconnu**. C'est cette distinction, et elle seule, qui
 * autorise le remboursement à relâcher sa réservation (#63).
 */
function isDefinitiveRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
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
   * Ordonne un remboursement — total ou partiel (#63).
   *
   * ## Ce qui part, et ce qui ne part pas
   *
   * `payment_intent` et `amount`, plus des métadonnées d'identifiants opaques.
   * **Pas de `reason`** : le champ homonyme de Stripe n'accepte que trois
   * valeurs énumérées (`duplicate`, `fraudulent`, `requested_by_customer`), là
   * où le motif du comptoir est un texte libre susceptible de nommer la
   * cliente. Il reste dans notre base, où le rapprochement le lit — l'envoyer
   * chez le prestataire aurait exporté une donnée personnelle sans nécessité
   * (CDC §5.1).
   *
   * `amount` est toujours envoyé, y compris pour un remboursement total :
   * l'omettre laisserait Stripe décider d'un montant que notre vérification de
   * cumul n'a pas examiné.
   */
  public async createRefund(command: CreateRefundCommand): Promise<StripeRefund> {
    const form = new URLSearchParams();
    form.set('payment_intent', command.paymentIntentId);
    // Déjà dans la plus petite unité de la devise, comme `amount_minor` en
    // base : la valeur passe telle quelle, sans multiplication par cent — ce
    // qui la rend juste aussi pour les devises sans sous-unité.
    form.set('amount', String(command.amountMinor));

    for (const [key, value] of Object.entries(command.metadata)) {
      form.set(`metadata[${key}]`, value);
    }

    const payload = await this.call('/refunds', {
      method: 'POST',
      body: form,
      // La clé est l'identifiant de notre ligne `payment_refunds`, posée avant
      // l'appel : un renvoi après coupure réseau rend le remboursement déjà
      // créé plutôt que d'en émettre un second. Un remboursement en double sort
      // de l'argent — c'est le seul appel du module où l'idempotence protège
      // une sortie de trésorerie et non une entrée.
      idempotencyKey: command.idempotencyKey,
    });

    const refund = asStripeRefund(payload);

    if (refund === null) {
      // Le corps n'est pas journalisé : une réponse inattendue est justement
      // celle dont on ne sait pas ce qu'elle contient.
      this.logger.error('Réponse Stripe inexploitable', { operation: 'refund' });
      throw new PaymentProviderUnavailableError();
    }

    return refund;
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
      // Un 4xx est un refus **définitif** : la requête a été reçue, comprise, et
      // rejetée — rien n'a bougé chez le prestataire. Un 5xx, lui, ne dit rien
      // du sort de l'opération. La distinction n'apparaît pas dans la réponse
      // HTTP (même code, même 503) : elle sert au serveur, qui n'a le droit de
      // relâcher une réservation de remboursement que sur un refus définitif
      // (#63). `429` en est exclu — un quota dépassé se retente.
      throw isDefinitiveRefusal(response.status)
        ? new PaymentProviderRefusedError()
        : new PaymentProviderUnavailableError();
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
