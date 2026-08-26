/**
 * Encaissement — CDC §1.4 « paiement en ligne ou au comptoir, carte ou espèces ».
 *
 * Aucune valeur de ce fichier ne décrit un moyen de paiement au sens PCI : ni
 * réseau de carte, ni type de carte, ni rien qui suppose de connaître un PAN.
 * La tokenisation se fait côté client vers Stripe et le serveur ne manipule que
 * des références opaques (payments-stripe).
 */

export const PAYMENT_METHODS = ['card', 'cash'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuts pour lesquels de l'argent a réellement été encaissé. */
export const CAPTURED_PAYMENT_STATUSES = [
  'succeeded',
  'refunded',
  'partially_refunded',
] as const satisfies readonly PaymentStatus[];

/** `true` si `value` est un statut de paiement connu. */
export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}
