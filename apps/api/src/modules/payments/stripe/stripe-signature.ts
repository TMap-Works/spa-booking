import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Vérification de la signature d'un webhook Stripe — le seul endroit du dépôt
 * qui décide si un corps reçu vient bien de Stripe.
 *
 * ## Pourquoi ce fichier existe plutôt qu'un `stripe.webhooks.constructEvent`
 *
 * payments-stripe §3 montre l'appel de `stripe-node`. Le paquet n'est pas dans
 * les dépendances, et l'y ajouter toucherait `apps/api/package.json`, hors de
 * l'empreinte de ce ticket — la même raison qui a fait choisir `node:events`
 * plutôt que `@nestjs/event-emitter` au bus d'événements d'`appointments`.
 *
 * Ce que `constructEvent` fait tient en trois gestes, et les voici : recomposer
 * la charge signée `{timestamp}.{corps brut}`, en calculer le HMAC-SHA256 avec
 * le secret de terminaison, et le comparer **en temps constant** aux signatures
 * annoncées. Le schéma est public et versionné (`v1`), il ne bouge pas.
 *
 * Le jour où `stripe-node` entrera pour Terminal, ce fichier disparaîtra
 * derrière son appel — la frontière est déjà là : rien d'autre dans le module
 * ne sait comment une signature se calcule.
 *
 * ## Ce que la fonction ne fait pas
 *
 * Elle ne lève pas. Elle rend un verdict, et c'est le contrôleur qui décide du
 * statut HTTP. Une exception aurait obligé chaque appelant à distinguer « corps
 * falsifié » de « erreur de programmation », et un `catch` trop large aurait
 * fini par avaler les deux.
 */

/** Le schéma de signature du webhook, tel que Stripe le publie aujourd'hui. */
const SIGNATURE_SCHEME = 'v1';

/** Longueur d'un HMAC-SHA256 en hexadécimal. */
const HEX_DIGEST_LENGTH = 64;

/**
 * Fenêtre d'acceptation de l'horodatage, en secondes — la valeur par défaut de
 * Stripe.
 *
 * Sans elle, la signature reste valable indéfiniment : quiconque a intercepté
 * une livraison légitime pourrait la rejouer des mois plus tard. L'idempotence
 * de `processed_webhook_events` rendrait le rejeu **sans effet**, ce qui est
 * déjà l'essentiel — mais elle ne le rendrait pas *impossible*, et deux
 * barrières valent mieux qu'une sur le seul point d'entrée non authentifié de
 * l'API.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Le contenu utile de l'en-tête `Stripe-Signature`. */
export interface ParsedSignatureHeader {
  /** Instant de signature, en secondes depuis l'époque. */
  readonly timestamp: number;
  /** Toutes les signatures `v1` annoncées — Stripe en envoie plusieurs pendant une rotation de secret. */
  readonly signatures: readonly string[];
}

/**
 * Pourquoi une livraison a été refusée. Le contrôleur ne renvoie **jamais** ce
 * détail au client : il part au journal, où il sert au diagnostic d'une
 * intégration qui ne prend pas. Le corps de réponse, lui, dit la même chose
 * pour les quatre — un attaquant qui sonde ne doit pas apprendre laquelle de
 * ses hypothèses était la bonne.
 */
export type SignatureRejection =
  | 'missing-header'
  | 'malformed-header'
  | 'timestamp-out-of-tolerance'
  | 'no-matching-signature';

export type SignatureVerdict =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: SignatureRejection };

export interface VerifySignatureInput {
  /** Le corps **brut**, tel qu'il est arrivé sur la socket. Jamais un objet re-sérialisé. */
  readonly payload: Buffer;
  /** La valeur de l'en-tête `Stripe-Signature`, ou `undefined` si elle manque. */
  readonly header: string | undefined;
  /** Le secret de terminaison, `whsec_…`. */
  readonly secret: string;
  /** Instant courant, en millisecondes — injecté pour que le test n'ait pas à attendre. */
  readonly now: number;
  readonly toleranceSeconds?: number;
}

/**
 * Découpe `t=1492774577,v1=5257a869…,v1=…` en horodatage et signatures.
 *
 * Tolérant sur ce qui ne nous concerne pas — un schéma `v0` inconnu, un espace
 * après une virgule — et strict sur ce qui nous concerne : sans `t` numérique
 * ni au moins une signature `v1`, l'en-tête n'est pas exploitable.
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      // `Number.parseInt` accepterait « 12abc » : l'en-tête est produit par une
      // machine, une valeur qui n'est pas entière de bout en bout est un signe
      // de falsification, pas de tolérance à accorder.
      if (!/^\d+$/.test(value)) {
        return null;
      }
      timestamp = Number(value);
      continue;
    }

    if (key === SIGNATURE_SCHEME) {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

/**
 * Le HMAC attendu pour cette charge — exporté pour que les tests et le harnais
 * de recette signent comme Stripe signe, plutôt que de recopier l'algorithme
 * à côté et de valider une signature contre elle-même.
 */
export function computeSignature(secret: string, timestamp: number, payload: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(payload)
    .digest('hex');
}

/**
 * Comparaison à **temps constant**.
 *
 * Un `===` sur deux chaînes s'arrête au premier caractère différent : la durée
 * de la comparaison renseigne alors sur le nombre de caractères devinés, et
 * quelques milliers de requêtes suffisent à reconstruire une signature octet
 * par octet. `timingSafeEqual` exige des tampons de même longueur — une
 * candidate mal dimensionnée est écartée avant, ce qui ne fuit rien : sa
 * longueur est déjà publique dans l'en-tête.
 */
function matches(expected: string, candidate: string): boolean {
  if (candidate.length !== HEX_DIGEST_LENGTH || !/^[0-9a-f]+$/.test(candidate)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
}

/**
 * Le verdict complet : en-tête présent, bien formé, horodatage dans la fenêtre,
 * et au moins une signature `v1` qui correspond.
 *
 * L'ordre compte : l'horodatage est vérifié **avant** le HMAC, pour ne pas
 * calculer un condensat sur une charge dont on sait déjà qu'on la refusera.
 */
export function verifyStripeSignature(input: VerifySignatureInput): SignatureVerdict {
  if (input.header === undefined || input.header.trim() === '') {
    return { ok: false, reason: 'missing-header' };
  }

  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) {
    return { ok: false, reason: 'malformed-header' };
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const ageSeconds = Math.abs(Math.floor(input.now / 1000) - parsed.timestamp);
  if (ageSeconds > tolerance) {
    return { ok: false, reason: 'timestamp-out-of-tolerance' };
  }

  const expected = computeSignature(input.secret, parsed.timestamp, input.payload);
  // `some` s'arrête à la première correspondance, ce qui ne fuit rien : le
  // nombre de signatures annoncées est déjà public, il est dans l'en-tête.
  if (!parsed.signatures.some((candidate) => matches(expected, candidate))) {
    return { ok: false, reason: 'no-matching-signature' };
  }

  return { ok: true, timestamp: parsed.timestamp };
}
