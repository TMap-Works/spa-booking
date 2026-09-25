import type { AppConfigService } from '../../../config/app-config.service';
import { NotFoundError } from '../../../common/errors';
import { ReceiptPdfService } from '../receipt-pdf/receipt-pdf.service';
import type { ReceiptService } from '../receipt.service';
import { ariaryReceiptFixture, receiptFixture } from './receipt-pdf.doubles';

/**
 * Le document réellement produit — #819, premier, deuxième et sixième critères.
 *
 * Cette suite ouvre les octets. Ce qu'elle prouve, et que la suite du gabarit ne
 * peut pas prouver : que c'est un PDF, qu'il fait la largeur d'un rouleau de
 * 80 mm, que sa hauteur suit son contenu, et que la facture tient sur de l'A4.
 *
 * Ce qu'elle **ne** prouve pas, et n'essaie pas : le texte rendu. Il est encodé
 * en indices de glyphes de la police sous-ensemblée, pas en ASCII — c'est
 * `receipt-pdf.template.spec.ts` qui en répond.
 */

/** 1 mm en points PostScript — l'unité des deux gabarits. */
const MM = 72 / 25.4;

function service(receipt = receiptFixture()): ReceiptPdfService {
  const receipts = { bySaleId: jest.fn().mockResolvedValue(receipt) } as unknown as ReceiptService;
  const config = { appUrl: 'https://app.spa.test' } as unknown as AppConfigService;

  return new ReceiptPdfService(receipts, config);
}

/**
 * Les dimensions de la première page, lues dans le `/MediaBox` du document.
 *
 * PDFKit écrit l'objet de page en clair — seuls les flux de contenu sont
 * comprimés —, si bien que la géométrie se relit sans dépaqueter quoi que ce
 * soit. C'est la seule assertion de mise en page qui tienne sans embarquer un
 * lecteur de PDF dans la suite de tests.
 */
function mediaBox(pdf: Buffer): { width: number; height: number } {
  const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*]/.exec(pdf.toString('latin1'));

  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('Aucun /MediaBox dans le document.');
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Le nombre de pages — un `/Type /Page` par page. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * La valeur d'une clé du dictionnaire `/Info`.
 *
 * PDFKit n'y écrit pas les chaînes en ligne : il y met des **références
 * indirectes** (`/Author 14 0 R`) vers des objets chaîne. Il faut donc suivre le
 * renvoi, ce que fait la seconde expression. Lire `/Author (…)` directement ne
 * trouverait jamais rien — et un test qui ne trouve rien passerait sans bruit
 * sur un `not.toContain`, ce qui est exactement le piège ici.
 */
function infoValue(pdf: Buffer, key: string): string | null {
  const raw = pdf.toString('latin1');
  const reference = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(raw);

  if (reference?.[1] === undefined) {
    return null;
  }

  const object = new RegExp(`\\n${reference[1]} 0 obj\\s*\\(([^)]*)\\)`).exec(raw);

  return object?.[1] ?? null;
}

describe('ReceiptPdfService', () => {
  it('rend un document PDF complet', async () => {
    const pdf = await service().bySaleId('sale-id', 'ticket-80');

    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.bytes.toString('latin1')).toContain('%%EOF');
    expect(pdf.bytes.byteLength).toBeGreaterThan(1000);
  });

  /** Deuxième critère : « largeur imprimable de 72 mm » sur un rouleau de 80. */
  it('sert le ticket à la largeur d’un rouleau de 80 mm', async () => {
    const { bytes } = await service().bySaleId('sale-id', 'ticket-80');

    expect(mediaBox(bytes).width).toBeCloseTo(80 * MM, 1);
  });

  /** Deuxième critère : « hauteur ajustée au contenu ». */
  it('ajuste la hauteur du ticket à son contenu', async () => {
    const short = receiptFixture({ lines: [] });
    const long = receiptFixture({
      lines: Array.from({ length: 30 }, (_unused, index) => ({
        position: index,
        kind: 'PRODUCT' as const,
        label: `Article numéro ${index} au libellé délibérément long`,
        quantity: 1,
        unitAmount: { amountMinor: 1000, currency: 'EUR' },
        lineAmount: { amountMinor: 1000, currency: 'EUR' },
      })),
    });

    const shortHeight = mediaBox((await service(short).bySaleId('s', 'ticket-80')).bytes).height;
    const longHeight = mediaBox((await service(long).bySaleId('s', 'ticket-80')).bytes).height;

    expect(longHeight).toBeGreaterThan(shortHeight);
    expect(shortHeight).toBeGreaterThan(40 * MM);
  });

  /** Et il tient sur une seule page — un rouleau ne se pagine pas. */
  it('ne pagine jamais le ticket, quelle que soit sa longueur', async () => {
    const long = receiptFixture({
      lines: Array.from({ length: 60 }, (_unused, index) => ({
        position: index,
        kind: 'PRODUCT' as const,
        label: `Article ${index}`,
        quantity: 1,
        unitAmount: { amountMinor: 1000, currency: 'EUR' },
        lineAmount: { amountMinor: 1000, currency: 'EUR' },
      })),
    });

    expect(pageCount((await service(long).bySaleId('s', 'ticket-80')).bytes)).toBe(1);
  });

  it('sert la facture au format A4', async () => {
    const { bytes } = await service().bySaleId('sale-id', 'a4');
    const box = mediaBox(bytes);

    expect(box.width).toBeCloseTo(210 * MM, 1);
    expect(box.height).toBeCloseTo(297 * MM, 1);
  });

  /** Sixième critère : « `Content-Disposition` porte le numéro de pièce ». */
  it('nomme le fichier d’après le numéro de pièce', async () => {
    expect((await service().bySaleId('s', 'ticket-80')).fileName).toBe(
      'ticket-TIC-2026-000123.pdf',
    );
    expect((await service().bySaleId('s', 'a4')).fileName).toBe('facture-TIC-2026-000123.pdf');
  });

  /**
   * **#1230, premier critère** — la chaîne de résolution de la langue.
   *
   * Le salon du jeu d'essai tient sa caisse en français (`defaultLocale: 'fr'`).
   * Sans langue demandée, la pièce sort donc en français ; avec une langue
   * demandée, celle-ci l'emporte — c'est la langue de l'interface qui imprime,
   * la seule à savoir dans quelle langue on lit l'écran.
   */
  describe('la langue de la pièce', () => {
    it('suit celle de l’établissement quand la demande n’en porte aucune', async () => {
      const pdf = await service().bySaleId('s', 'ticket-80');

      expect(pdf.locale).toBe('fr');
      expect(pdf.fileName).toBe('ticket-TIC-2026-000123.pdf');
    });

    it('suit celle de la demande quand elle en porte une', async () => {
      const pdf = await service().bySaleId('s', 'a4', 'en');

      expect(pdf.locale).toBe('en');
      expect(pdf.fileName).toBe('invoice-TIC-2026-000123.pdf');
    });

    /** Un salon dont la caisse est en anglais, sans que rien ne soit demandé. */
    it('se replie sur un établissement anglophone sans rien demander', async () => {
      const receipt = receiptFixture();
      const english = receiptFixture({
        issuer: { ...receipt.issuer, defaultLocale: 'en' },
      });
      const pdf = await service(english).bySaleId('s', 'ticket-80');

      expect(pdf.locale).toBe('en');
      expect(pdf.fileName).toBe('receipt-TIC-2026-000123.pdf');
    });

    /** La langue demandée prime sur celle de l'établissement, dans les deux sens. */
    it('laisse la demande l’emporter sur l’établissement', async () => {
      const receipt = receiptFixture();
      const english = receiptFixture({
        issuer: { ...receipt.issuer, defaultLocale: 'en' },
      });

      expect((await service(english).bySaleId('s', 'ticket-80', 'fr')).locale).toBe('fr');
      expect((await service().bySaleId('s', 'ticket-80', 'en')).locale).toBe('en');
    });

    /**
     * Le titre des métadonnées suit la langue, l'identifiant de vente non : le
     * premier s'affiche dans l'onglet d'un visualiseur, le second est une clé
     * technique qui ne nomme aucune personne.
     *
     * Le titre anglais est de l'ASCII pur, que PDFKit écrit en clair ; le titre
     * français porte une cédille, qui le fait passer en UTF-16BE. D'où deux
     * assertions de nature différente sur la même clé — celle qui compte est
     * qu'aucun des deux ne porte le mot de l'autre.
     */
    it('compose le titre du document dans la langue retenue', async () => {
      const french = await service().bySaleId('sale-id', 'ticket-80');
      const english = await service().bySaleId('sale-id', 'ticket-80', 'en');

      expect(infoValue(english.bytes, 'Title')).toContain('Receipt');
      expect(infoValue(french.bytes, 'Title')).not.toContain('Receipt');
    });

    /**
     * La hauteur du rouleau est **mesurée dans la langue du rendu** : les
     * libellés n'ont pas la même longueur d'une langue à l'autre, et mesurer
     * dans l'une pour imprimer dans l'autre couperait le pied du ticket.
     */
    it('mesure le rouleau dans la langue où il s’imprime', async () => {
      const french = await service().bySaleId('s', 'ticket-80');
      const english = await service().bySaleId('s', 'ticket-80', 'en');

      for (const pdf of [french, english]) {
        expect(mediaBox(pdf.bytes).height).toBeGreaterThan(40 * MM);
        expect(pageCount(pdf.bytes)).toBe(1);
      }
    });
  });

  it('rend « proforma » tant que la vente n’est pas close', async () => {
    const open = receiptFixture({ sequence: null, issuedAt: null });
    const pdf = await service(open).bySaleId('s', 'ticket-80');

    expect(pdf.receiptNumber).toBeNull();
    expect(pdf.fileName).toBe('ticket-proforma.pdf');
  });

  /** Sixième critère : « rendu d'une vente multi-lignes à deux taux, en MGA ». */
  it('rend le ticket d’une caisse en ariary', async () => {
    const pdf = await service(ariaryReceiptFixture()).bySaleId('s', 'ticket-80');

    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(mediaBox(pdf.bytes).width).toBeCloseTo(80 * MM, 1);
  });

  /**
   * **Sixième critère, deuxième point.** Le refus vient de `ReceiptService`, qui
   * lit par le client scopé : un ticket du salon voisin est introuvable, et
   * l'impression n'a alors rien à imprimer (tenant-isolation §4). La garantie
   * n'est pas que le PDF soit vide — c'est qu'il n'existe pas.
   */
  it('ne produit aucun octet pour un ticket d’un autre établissement', async () => {
    const receipts = {
      bySaleId: jest.fn().mockRejectedValue(new NotFoundError('Ticket introuvable.')),
    } as unknown as ReceiptService;
    const config = { appUrl: 'https://app.spa.test' } as unknown as AppConfigService;
    const subject = new ReceiptPdfService(receipts, config);

    await expect(subject.bySaleId('sale-du-voisin', 'ticket-80')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  /**
   * Les propriétés d'un PDF sont lues par n'importe quel visualiseur et
   * survivent au document bien après que la cliente l'a transmis. Elles ne
   * portent donc ni nom de personne, ni moyen de paiement.
   */
  it('ne met aucun nom de personne dans les métadonnées du document', async () => {
    const { bytes } = await service().bySaleId('sale-id', 'ticket-80');

    expect(infoValue(bytes, 'Author')).toBe('TANA COIFFURE SARL');
    expect(infoValue(bytes, 'Title')).not.toContain('Camille Roux');
    expect(infoValue(bytes, 'Title')).not.toContain('Awa Diallo');

    // Et rien de tout cela n'est en clair ailleurs : les flux de contenu sont
    // comprimés, mais les objets chaîne du document, eux, ne le sont pas.
    const raw = bytes.toString('latin1');

    expect(raw).not.toContain('Camille Roux');
    expect(raw).not.toContain('Awa Diallo');
  });
});
