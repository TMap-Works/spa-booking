import type { Locale } from '@spa/shared';

/**
 * Le vocabulaire du ticket imprimé — #819, premier critère.
 *
 * Ces types ne franchissent pas la frontière HTTP : le DTO de la requête vit
 * sous `dto/`, et la réponse est un flux d'octets. Ce sont ceux du domaine.
 */

/**
 * Les deux formats que la route sert — `?format=ticket-80|a4`.
 *
 * `ticket-80` est le rouleau thermique du comptoir, `a4` la facture qu'on
 * envoie. Ce sont deux **documents** et non deux mises en page du même : le
 * quatrième critère donne à la facture des données que le ticket n'a pas.
 */
export const RECEIPT_PDF_FORMATS = ['ticket-80', 'a4'] as const;

export type ReceiptPdfFormat = (typeof RECEIPT_PDF_FORMATS)[number];

/** `true` si `value` est un format servi. */
export function isReceiptPdfFormat(value: unknown): value is ReceiptPdfFormat {
  return typeof value === 'string' && (RECEIPT_PDF_FORMATS as readonly string[]).includes(value);
}

/** Le document produit, prêt à être servi. */
export interface RenderedReceiptPdf {
  readonly bytes: Buffer;
  /** Le nom du fichier — il porte le numéro de pièce (sixième critère). */
  readonly fileName: string;
  /** Le numéro de pièce, ou `null` quand la vente est encore ouverte. */
  readonly receiptNumber: string | null;
  /**
   * La langue dans laquelle la pièce a été composée — #1230.
   *
   * Celle de la demande, ou celle de l'établissement à défaut. Elle est rendue
   * pour que la route puisse l'annoncer en `Content-Language` : un document
   * servi sans indication de langue est un document qu'aucun lecteur d'écran ni
   * aucun cache ne sait qualifier.
   */
  readonly locale: Locale;
}
