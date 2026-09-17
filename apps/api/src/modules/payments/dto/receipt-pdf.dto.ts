import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { RECEIPT_PDF_FORMATS, type ReceiptPdfFormat } from '../receipt-pdf/receipt-pdf.types';

/**
 * Le format demandé — `?format=ticket-80|a4`, premier critère de #819.
 *
 * ## Pourquoi il a un défaut
 *
 * Parce que l'immense majorité des appels viennent du bouton « Imprimer le
 * ticket » d'un comptoir, dont le besoin est le rouleau. Rendre le paramètre
 * obligatoire aurait fait répondre 400 à un lien collé à la main et à toute
 * intégration qui l'oublie, pour une information que la caisse connaît déjà.
 *
 * Une valeur **inconnue** reste en revanche un refus : servir le ticket 80 mm à
 * qui a demandé `?format=a3` lui aurait fait croire qu'il tient une facture.
 * C'est la différence entre « non précisé » et « précisé faux ».
 */
export class ReceiptPdfQueryDto {
  @ApiPropertyOptional({
    enum: RECEIPT_PDF_FORMATS,
    default: 'ticket-80',
    description:
      'Rouleau thermique 80 mm (défaut) ou facture A4. Toute autre valeur est refusée en 400.',
  })
  @IsOptional()
  @IsIn(RECEIPT_PDF_FORMATS, {
    message: `format doit valoir l'une des valeurs suivantes : ${RECEIPT_PDF_FORMATS.join(', ')}`,
  })
  public format?: ReceiptPdfFormat;
}

/** Le format retenu — celui du paramètre, ou le rouleau du comptoir. */
export function toReceiptPdfFormat(query: ReceiptPdfQueryDto): ReceiptPdfFormat {
  return query.format ?? 'ticket-80';
}
