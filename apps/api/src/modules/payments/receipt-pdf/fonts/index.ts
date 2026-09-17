import { ROBOTO_BOLD_BASE64 } from './roboto-bold';
import { ROBOTO_REGULAR_BASE64 } from './roboto-regular';

/**
 * Les deux graisses de la police embarquée — #819, deuxième critère.
 *
 * Provenance, licence et raison du base64 : `NOTICE.md`, à côté.
 *
 * Le décodage est fait **une fois**, au premier ticket imprimé, et mémorisé :
 * `Buffer.from(…, 'base64')` sur 224 Kio de texte coûte quelques millisecondes,
 * ce qui est négligeable une fois mais pas à chaque impression d'un comptoir qui
 * en tire cent par jour. Paresseux plutôt qu'au chargement du module, pour ne
 * pas faire payer 330 Kio de RSS aux processus qui n'impriment jamais — la
 * tâche de migration réutilise la même image.
 */

/** Les deux graisses que les gabarits savent demander. */
export type ReceiptFontWeight = 'regular' | 'bold';

const SOURCES: Readonly<Record<ReceiptFontWeight, string>> = {
  regular: ROBOTO_REGULAR_BASE64,
  bold: ROBOTO_BOLD_BASE64,
};

const decoded = new Map<ReceiptFontWeight, Buffer>();

/** Les octets TrueType d'une graisse, décodés à la demande puis mémorisés. */
export function receiptFont(weight: ReceiptFontWeight): Buffer {
  const cached = decoded.get(weight);

  if (cached !== undefined) {
    return cached;
  }

  const bytes = Buffer.from(SOURCES[weight], 'base64');

  decoded.set(weight, bytes);

  return bytes;
}
