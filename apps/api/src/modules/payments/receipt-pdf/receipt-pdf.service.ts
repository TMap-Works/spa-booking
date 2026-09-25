import { Injectable } from '@nestjs/common';
import type { Locale } from '@spa/shared';
import PDFDocument from 'pdfkit';

import { AppConfigService } from '../../../config/app-config.service';
import { receiptNumberOf } from '../dto/receipt.dto';
import { ReceiptService } from '../receipt.service';
import type { SaleReceipt } from '../receipt.types';
import { receiptFont } from './fonts';
import { mm, ReceiptCanvas, type CanvasOptions } from './receipt-pdf.canvas';
import { bookingUrl, receiptFileName } from './receipt-pdf.format';
import { renderReceipt, type TemplateContext } from './receipt-pdf.template';
import type { ReceiptPdfFormat, RenderedReceiptPdf } from './receipt-pdf.types';
import { receiptVocabulary } from './receipt-pdf.vocabulary';

/**
 * Le ticket de caisse en PDF — #819.
 *
 * Il ne relit pas la base : il demande le reçu à `ReceiptService`, celui que
 * #818 compose, et n'imprime que cela. C'est ce qui fait que le PDF et le JSON
 * de `GET /sales/:id/receipt` ne peuvent pas diverger — un total de ticket qui
 * ne serait pas celui de l'écran est exactement la classe de faute qu'une
 * seconde lecture aurait introduite.
 *
 * ## Pourquoi PDFKit
 *
 * Le premier critère l'exige : « la bibliothèque ne demande pas de navigateur,
 * pour éviter d'embarquer Chromium dans l'image Fargate ». PDFKit écrit le
 * format à la main — ses six dépendances sont du JavaScript pur (fontkit,
 * png-js, linebreak, fflate, deux paquets `@noble`) — là où une chaîne HTML vers
 * PDF aurait ajouté quelque trois cents mégaoctets de navigateur à une image qui
 * en fait aujourd'hui moins de deux cents, et un processus enfant à surveiller
 * sur chaque tâche ECS.
 *
 * ## Les deux passes
 *
 * Le deuxième critère demande que la hauteur du ticket 80 mm s'ajuste à son
 * contenu, et la taille d'une page PDF est figée à sa création. Le gabarit est
 * donc déroulé **deux fois** : une passe de mesure sur un document jetable, puis
 * une passe de rendu sur un document à la hauteur trouvée. Le code de gabarit
 * est le même dans les deux cas (`ReceiptCanvas`), ce qui est la seule façon que
 * la mesure et le rendu ne divergent pas.
 *
 * La passe de mesure n'est pas sérialisée — rien n'est branché sur son flux et
 * `end()` n'est jamais appelé : PDFKit n'écrit qu'à ce moment-là.
 *
 * ## La langue du document — #1230
 *
 * Elle se résout **ici**, en un seul endroit, et descend ensuite jusqu'au
 * gabarit et au nom de fichier par `TemplateContext.locale`. La chaîne est celle
 * que le premier critère de #1230 énonce :
 *
 * 1. la langue **demandée** — `?locale=`, c'est-à-dire celle de l'interface au
 *    moment où on imprime, la seule qui sache dans quelle langue on lit l'écran ;
 * 2. à défaut, `tenants.default_locale` — la langue de l'établissement, celle de
 *    ses notifications ;
 * 3. à défaut, `DEFAULT_LOCALE` — mais ce troisième cran n'est atteignable que
 *    par une valeur de colonne posée hors de l'application, et il est tenu par
 *    `ReceiptService`, qui normalise déjà ce qu'il lit.
 *
 * La hauteur mesurée dépend de la langue, puisque les libellés n'ont pas la même
 * longueur d'une langue à l'autre : c'est pourquoi la passe de mesure reçoit le
 * **même** contexte que la passe de rendu. Les mesurer dans une langue pour
 * imprimer dans l'autre est exactement le genre d'écart qui coupe le pied d'un
 * ticket thermique.
 */

/** Largeur du rouleau, et largeur imprimable — deuxième critère. */
const TICKET_WIDTH = mm(80);
const TICKET_PRINTABLE_WIDTH = mm(72);
const TICKET_SIDE_MARGIN = (TICKET_WIDTH - TICKET_PRINTABLE_WIDTH) / 2;

/** A4 en points PostScript — 210 × 297 mm. */
const A4_WIDTH = mm(210);
const A4_HEIGHT = mm(297);
const A4_SIDE_MARGIN = mm(18);
const A4_TOP_MARGIN = mm(16);
const A4_BOTTOM_MARGIN = mm(16);

/**
 * La hauteur du document jetable de la passe de mesure.
 *
 * Généreuse à dessein pour le ticket, dont la page ne se coupe jamais : la
 * mesure doit pouvoir dépasser ce qu'un rouleau porterait sans que PDFKit
 * n'ouvre une page — ce qui remettrait le curseur en haut et fausserait la
 * hauteur totale. Pour l'A4, la pagination est au contraire voulue, et c'est la
 * vraie hauteur qui sert.
 */
const MEASURE_HEIGHT = mm(4000);

interface Geometry {
  readonly width: number;
  readonly canvas: CanvasOptions;
}

/**
 * La langue dans laquelle la pièce s'imprime — premier critère de #1230.
 *
 * La demande d'abord, l'établissement ensuite. Le troisième cran — la langue par
 * défaut du système — est déjà appliqué par `ReceiptService`, qui normalise
 * `tenants.default_locale` à la lecture : `issuer.defaultLocale` est donc
 * toujours l'une des deux langues du contrat, et il n'y a pas de quatrième cas à
 * traiter ici.
 */
function resolveLocale(receipt: SaleReceipt, requested: Locale | undefined): Locale {
  return requested ?? receipt.issuer.defaultLocale;
}

function geometryOf(format: ReceiptPdfFormat): Geometry {
  if (format === 'a4') {
    return {
      width: A4_WIDTH,
      canvas: {
        sideMargin: A4_SIDE_MARGIN,
        top: A4_TOP_MARGIN,
        baseSize: 10,
        pageBreakAt: A4_HEIGHT - A4_BOTTOM_MARGIN,
      },
    };
  }

  return {
    width: TICKET_WIDTH,
    canvas: {
      sideMargin: TICKET_SIDE_MARGIN,
      top: mm(5),
      // 8 points : la taille à laquelle une thermique 203 ppp rend encore un
      // accent lisible. En dessous, le « é » et le « è » se confondent.
      baseSize: 8,
      pageBreakAt: null,
    },
  };
}

/** Un document PDFKit à la bonne taille, polices embarquées enregistrées. */
function newDocument(
  width: number,
  height: number,
  receipt: SaleReceipt,
  locale: Locale,
): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: [width, height],
    // Les marges sont tenues par `ReceiptCanvas`, qui doit pouvoir décider du
    // haut de page : deux jeux de marges se seraient additionnés.
    margin: 0,
    info: {
      // Le titre que le visualiseur affiche dans son onglet suit la langue du
      // document — #1230. L'identifiant de vente qu'il porte, non : c'est une
      // clé technique, et elle ne nomme aucune personne.
      Title: `${receiptVocabulary(locale).documentTitle} ${receipt.saleId}`,
      Author: receipt.issuer.legalName ?? receipt.issuer.name,
      // Aucune métadonnée de personne ni de moyen de paiement : les propriétés
      // d'un PDF sont lues par n'importe quel visualiseur, et survivent au
      // document bien après que la cliente l'a transmis.
      Creator: 'Spa & Salon Booking',
    },
  });

  doc.registerFont('regular', receiptFont('regular'));
  doc.registerFont('bold', receiptFont('bold'));
  doc.font('regular');

  return doc;
}

/** Les octets d'un document, une fois `end()` appelé. */
async function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

@Injectable()
export class ReceiptPdfService {
  public constructor(
    private readonly receipts: ReceiptService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Le PDF du ticket d'une vente de l'établissement courant.
   *
   * `locale` est la langue **demandée** — celle de l'interface qui imprime. Son
   * absence n'est pas une erreur : elle vaut « prends celle du salon », et c'est
   * ce que fait {@link resolveLocale}.
   *
   * @throws {NotFoundError} vente inconnue, ou d'un autre établissement — les
   * deux refus sont indiscernables, et c'est `ReceiptService` qui les rend
   * (tenant-isolation §4). Rien n'est imprimé avant que la lecture n'ait abouti.
   */
  public async bySaleId(
    saleId: string,
    format: ReceiptPdfFormat,
    locale?: Locale,
  ): Promise<RenderedReceiptPdf> {
    const receipt = await this.receipts.bySaleId(saleId);

    return this.render(receipt, format, locale);
  }

  /** Le rendu seul, sans lecture — le point d'entrée que les tests exercent. */
  public async render(
    receipt: SaleReceipt,
    format: ReceiptPdfFormat,
    locale?: Locale,
  ): Promise<RenderedReceiptPdf> {
    const receiptNumber = receiptNumberOf(receipt);
    const printed = resolveLocale(receipt, locale);
    const context: TemplateContext = {
      variant: format,
      receiptNumber,
      bookingUrl: bookingUrl(this.config.appUrl, receipt.issuer.slug),
      locale: printed,
    };
    const geometry = geometryOf(format);
    const height = this.measure(receipt, context, geometry);

    const doc = newDocument(geometry.width, height, receipt, printed);

    renderReceipt(new ReceiptCanvas(doc, geometry.canvas, true), receipt, context);

    return {
      bytes: await collect(doc),
      fileName: receiptFileName(receiptNumber, format, printed),
      receiptNumber,
      locale: printed,
    };
  }

  /**
   * La hauteur du document — celle du contenu pour le ticket, A4 pour la facture.
   *
   * La marge basse est ajoutée au ticket pour qu'il ne finisse pas au ras de la
   * dernière ligne : une thermique coupe quelques millimètres après la fin du
   * document, et sans cette réserve le « Reprendre rendez-vous » tomberait dans
   * la coupe.
   */
  private measure(
    receipt: SaleReceipt,
    context: TemplateContext,
    geometry: Geometry,
  ): number {
    if (context.variant === 'a4') {
      return A4_HEIGHT;
    }

    // Le même contexte que la passe de rendu — langue comprise : « Thank you for
    // your visit! » et « Merci de votre visite ! » ne tiennent pas sur le même
    // nombre de lignes à 72 mm de large.
    const scratch = newDocument(geometry.width, MEASURE_HEIGHT, receipt, context.locale);
    const canvas = new ReceiptCanvas(scratch, geometry.canvas, false);

    renderReceipt(canvas, receipt, context);

    return canvas.y + mm(6);
  }
}
