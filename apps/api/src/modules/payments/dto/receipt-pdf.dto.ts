import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { LOCALES, type Locale } from '@spa/shared';

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

  /**
   * La langue de la pièce — `?locale=fr|en`, premier critère de #1230.
   *
   * ## Pourquoi elle traverse la demande
   *
   * Le PDF est composé **par le serveur** : aucun catalogue de messages du front
   * ne l'atteint. Trois sources étaient possibles, et deux sont écartées pour la
   * raison que `reportExportLocaleSchema` a déjà tranchée (#851) :
   *
   * - `Accept-Language` est la préférence du **navigateur**. Une gérante qui
   *   bascule le back-office en anglais sur un navigateur français aurait tendu
   *   à sa cliente un ticket français ;
   * - `tenants.default_locale` seule ne dit rien de la langue dans laquelle on
   *   est *en train* de lire l'écran. Elle reste le **repli**, ce que le critère
   *   demande — mais un repli, pas la source.
   *
   * Reste la demande, où la langue est explicite. Le paramètre est **facultatif**
   * : le rendre obligatoire aurait fait répondre 400 au bouton « Imprimer le
   * ticket » de toute caisse antérieure à ce ticket, pour une information dont
   * l'établissement porte déjà un défaut utilisable.
   *
   * La casse est normalisée avant d'être jugée, comme sur
   * `CustomerDataExportQueryDto.locale` : `?locale=FR` recopié d'un en-tête
   * `Accept-Language` désigne la même langue que `?locale=fr`. Toute autre valeur
   * est refusée en **400** nommant le champ, jamais repliée en silence — un
   * `?locale=de` qui rendrait de l'anglais laisserait croire l'allemand servi.
   * C'est la même frontière que `format` : « non précisé » et « précisé faux »
   * sont deux choses différentes.
   */
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'fr',
    description:
      'Langue du document. Absente, la pièce est composée dans la langue de ' +
      'l’établissement (`defaultLocale`). Les montants restent des entiers dans ' +
      'la plus petite unité monétaire, et le fuseau reste celui du salon.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(LOCALES as readonly string[], {
    message: `locale : langue attendue parmi ${LOCALES.join(', ')}`,
  })
  public locale?: Locale;
}

/** Le format retenu — celui du paramètre, ou le rouleau du comptoir. */
export function toReceiptPdfFormat(query: ReceiptPdfQueryDto): ReceiptPdfFormat {
  return query.format ?? 'ticket-80';
}

/**
 * La langue demandée, ou `undefined` quand la demande n'en porte aucune.
 *
 * L'absence n'est **pas** repliée ici : c'est `ReceiptPdfService` qui connaît la
 * langue de l'établissement, et une valeur inventée à la frontière HTTP lui
 * ferait perdre la différence entre « on m'a demandé du français » et « on ne
 * m'a rien demandé ».
 */
export function toReceiptPdfLocale(query: ReceiptPdfQueryDto): Locale | undefined {
  return query.locale;
}
