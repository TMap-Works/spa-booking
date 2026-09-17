import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Le second facteur de la console plateforme — TOTP, RFC 6238.
 *
 * L'ADR 0012 exige une MFA sur l'espace qui ouvre tous les salons. TOTP plutôt
 * qu'un code envoyé par SMS ou par e-mail, pour trois raisons qui tiennent
 * toutes au périmètre du MVP :
 *
 * 1. **Aucune dépendance de plus.** Un code par SMS passerait par SNS, donc par
 *    le module `notifications`, donc par une file, une facturation et un mode de
 *    panne de plus sur le chemin de la connexion de l'éditeur.
 * 2. **Rien à stocker par tentative.** Le code se dérive de l'horloge et d'un
 *    secret ; il n'y a ni ligne à écrire, ni durée de vie à balayer, ni course à
 *    arbitrer entre deux envois.
 * 3. **Aucune donnée personnelle de plus.** Pas de numéro de téléphone de
 *    l'opérateur à conserver (CDC §5.1).
 *
 * Ce fichier est volontairement **pur** : pas de Nest, pas de base, pas
 * d'horloge implicite — l'instant est un paramètre. C'est ce qui le rend
 * exerçable contre les vecteurs de test de la RFC 6238, appendice B.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne mémorise pas les codes déjà présentés. Un code reste donc valable
 * pendant sa fenêtre, et un code intercepté y est rejouable. Fermer cette
 * fenêtre demanderait un registre partagé des codes consommés — Redis, pas la
 * base — et c'est une décision d'infrastructure que #806 ne porte pas. La
 * fenêtre est bornée à ±1 pas, soit trente secondes de part et d'autre.
 */

/** Pas de temps, en secondes — la valeur par défaut de la RFC 6238 §4. */
export const TOTP_STEP_SECONDS = 30;

/** Longueur du code, en chiffres — celle que tous les authentificateurs attendent. */
export const TOTP_DIGITS = 6;

/**
 * Tolérance de dérive d'horloge, en pas.
 *
 * Un pas de part et d'autre : c'est ce qui absorbe la seconde où l'opérateur
 * appuie sur « valider » pendant que le code tourne, et la dérive ordinaire d'un
 * téléphone. Deux pas tripleraient la fenêtre d'un code intercepté sans rendre
 * service à personne.
 */
export const TOTP_WINDOW_STEPS = 1;

/**
 * Taille du secret, en octets — 20, soit 160 bits, la taille de bloc de
 * HMAC-SHA1 recommandée par la RFC 4226 §4.
 */
const SECRET_BYTES = 20;

/** Alphabet base32, RFC 4648 §6 — celui qu'attendent les authentificateurs. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode des octets en base32 **sans remplissage**.
 *
 * Le `=` de remplissage est omis délibérément : les URI `otpauth://` le portent
 * dans un paramètre de requête, où il devrait être encodé, et plusieurs
 * applications d'authentification le recopient tel quel dans le secret. Sans
 * remplissage, il n'y a rien à mal recopier.
 */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Décode une chaîne base32, ou rend `null` si ce n'en est pas une.
 *
 * Tolérant à ce qu'un humain fait d'un secret qu'il recopie : espaces, tirets,
 * remplissage, minuscules. Intolérant au reste — un caractère hors alphabet rend
 * `null` plutôt que d'être ignoré, sans quoi deux secrets distincts se
 * décoderaient sur la même valeur.
 */
export function decodeBase32(value: string): Uint8Array | null {
  const normalized = value.replaceAll(/[\s-]/g, '').replaceAll('=', '').toUpperCase();
  if (normalized.length === 0) {
    return null;
  }

  const bytes: number[] = [];
  let bits = 0;
  let accumulator = 0;

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      return null;
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Uint8Array.from(bytes);
}

/** Un secret TOTP neuf, en base32 — ce que la commande d'exploitation imprime. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(SECRET_BYTES));
}

/**
 * Le compteur HOTP d'un instant — RFC 6238 §4.2.
 *
 * `Math.floor` sur une division entière : l'instant est en millisecondes, et un
 * `Date.now() / 1000` non arrondi ferait dériver le compteur d'un pas à la
 * frontière.
 */
function counterAt(instantMs: number): bigint {
  return BigInt(Math.floor(instantMs / 1000 / TOTP_STEP_SECONDS));
}

/** Le compteur, en huit octets gros-boutiens — RFC 4226 §5.1. */
function counterBytes(counter: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  return buffer;
}

/**
 * Le code d'un secret à un instant donné — RFC 4226 §5.3, troncature dynamique.
 *
 * Rend `null` sur un secret illisible plutôt que de lever : l'appelant est une
 * vérification de connexion, et une exception y distinguerait « secret corrompu
 * en base » de « code faux » par un 500 — un oracle sur l'état du compte.
 */
export function totpCodeAt(secretBase32: string, instantMs: number, offsetSteps = 0): string | null {
  const secret = decodeBase32(secretBase32);
  if (secret === null || secret.length === 0) {
    return null;
  }

  const digest = createHmac('sha1', Buffer.from(secret))
    .update(counterBytes(counterAt(instantMs) + BigInt(offsetSteps)))
    .digest();

  // Troncature dynamique : les quatre bits de poids faible du dernier octet
  // désignent l'offset des quatre octets à lire, dont on masque le bit de signe.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/**
 * Le code présenté est-il celui du secret, à cet instant, à la dérive près ?
 *
 * La comparaison est **à temps constant** : un `===` sur des chaînes s'arrête au
 * premier caractère différent, et la durée de la réponse dirait alors combien de
 * chiffres de tête sont justes — de quoi retrouver un code six chiffres par
 * chiffre plutôt que par force brute.
 */
export function verifyTotp(
  secretBase32: string,
  presented: string,
  instantMs: number,
  windowSteps = TOTP_WINDOW_STEPS,
): boolean {
  const candidate = presented.trim();
  if (!new RegExp(`^\\d{${String(TOTP_DIGITS)}}$`).test(candidate)) {
    return false;
  }

  let matched = false;
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const expected = totpCodeAt(secretBase32, instantMs, offset);
    if (expected === null) {
      return false;
    }
    // Sans court-circuit : sortir de la boucle au premier succès ferait dépendre
    // la durée de la réponse du pas qui a répondu, donc de la dérive d'horloge
    // du porteur. Six comparaisons de six octets ne coûtent rien.
    matched = constantTimeEquals(expected, candidate) || matched;
  }

  return matched;
}

/** Égalité de deux chaînes de même longueur, sans court-circuit. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * L'URI que la commande d'exploitation imprime, et que l'opérateur scanne.
 *
 * `otpauth://totp/{émetteur}:{compte}?secret=…&issuer=…` — le format de fait,
 * que tous les authentificateurs lisent. L'émetteur est constant : il n'y a
 * qu'une console plateforme, et c'est elle qui s'affiche dans l'application.
 */
export function totpUri(account: string, secretBase32: string, issuer = 'Spa Booking'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
