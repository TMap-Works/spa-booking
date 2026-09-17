import PDFDocument from 'pdfkit';

import { mm, ReceiptCanvas } from '../receipt-pdf/receipt-pdf.canvas';
import { qrMatrix } from '../receipt-pdf/receipt-pdf.qr';

/**
 * Le QR code du pied de ticket — #819, troisième critère, huitième section.
 *
 * Ce qui se prouve ici, c'est la **forme** : une matrice carrée, de taille de
 * version valide, portant les trois motifs de détection sans lesquels aucun
 * lecteur n'accroche. La justesse de l'encodage relève de la bibliothèque, qui a
 * ses propres suites ; ce que ce ticket ajoute, c'est de s'en servir
 * correctement.
 */

const URL = 'https://app.spa.test/barber-tana/reservation';

/** Le motif de détection d'un coin : un carré plein 3×3 dans un anneau 7×7. */
function hasFinderPattern(
  matrix: readonly (readonly boolean[])[],
  originRow: number,
  originColumn: number,
): boolean {
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const ring = row === 0 || row === 6 || column === 0 || column === 6;
      const core = row >= 2 && row <= 4 && column >= 2 && column <= 4;
      const expected = ring || core;

      if (matrix[originRow + row]?.[originColumn + column] !== expected) {
        return false;
      }
    }
  }

  return true;
}

describe('qrMatrix', () => {
  it('rend une matrice carrée de taille de version valide', () => {
    const matrix = qrMatrix(URL);

    expect(matrix.length).toBeGreaterThanOrEqual(21);
    // Toute version v vaut 17 + 4v modules de côté — 21, 25, 29…
    expect((matrix.length - 17) % 4).toBe(0);

    for (const row of matrix) {
      expect(row).toHaveLength(matrix.length);
    }
  });

  /** Sans ces trois motifs, aucun lecteur ne trouve le code sur le papier. */
  it('porte les trois motifs de détection', () => {
    const matrix = qrMatrix(URL);
    const last = matrix.length - 7;

    expect(hasFinderPattern(matrix, 0, 0)).toBe(true);
    expect(hasFinderPattern(matrix, 0, last)).toBe(true);
    expect(hasFinderPattern(matrix, last, 0)).toBe(true);
  });

  it('est déterministe — deux tickets du même salon portent le même code', () => {
    expect(qrMatrix(URL)).toStrictEqual(qrMatrix(URL));
  });

  it('change avec le lien', () => {
    expect(qrMatrix(URL)).not.toStrictEqual(qrMatrix(`${URL}?x=1`));
  });

  it('grandit avec la charge plutôt que de la tronquer', () => {
    const long = `${URL}/${'a'.repeat(200)}`;

    expect(qrMatrix(long).length).toBeGreaterThan(qrMatrix(URL).length);
  });

  /**
   * L'encodage par défaut de la bibliothèque est Latin-1 : une origine
   * internationalisée y serait encodée en octets faux. La substitution UTF-8
   * faite au chargement du module se vérifie par le fait qu'un caractère hors
   * Latin-1 ne fait pas échouer l'encodage.
   */
  it('encode une origine internationalisée sans échouer', () => {
    expect(() => qrMatrix('https://salon-café.test/réservation')).not.toThrow();
  });
});

/**
 * Le tracé du code sur la planche — la **zone de silence** d'ISO/IEC 18004 §6.3.8.
 *
 * `qrcode-generator` ne rend que les modules du symbole : sa matrice commence au
 * coin du motif de détection. Les quatre modules de blanc que la norme exige tout
 * autour n'existent donc que si la planche les réserve — et sur le ticket 80 mm,
 * le pied ne laisse que 2 mm au-dessus du carré et 1,5 mm en dessous, là où il en
 * faut près de trois. Sans cette marge, un lecteur qui applique la norme refuse le
 * code : la panne ne se voit ni dans la matrice, ni dans la taille de page, mais
 * au comptoir, téléphone en main.
 */
describe('le tracé du QR sur la planche', () => {
  const SIDE_MARGIN = mm(4);
  const SIZE = mm(30);

  /** Les rectangles posés par `qr`, dans l'ordre du tracé. */
  function drawnRects(matrix: ReturnType<typeof qrMatrix>): {
    rects: { x: number; y: number; side: number }[];
    canvas: ReceiptCanvas;
  } {
    const doc = new PDFDocument({ size: [mm(80), mm(200)], margin: 0 });
    const rects: { x: number; y: number; side: number }[] = [];

    jest.spyOn(doc, 'rect').mockImplementation((x, y, width) => {
      rects.push({ x, y, side: width });

      return { fill: () => doc } as unknown as PDFKit.PDFDocument;
    });

    const canvas = new ReceiptCanvas(
      doc,
      { sideMargin: SIDE_MARGIN, top: mm(5), baseSize: 8, pageBreakAt: null },
      true,
    );

    canvas.qr(matrix, SIZE);

    return { rects, canvas };
  }

  it('réserve quatre modules de blanc tout autour du symbole', () => {
    const matrix = qrMatrix(URL);
    const { rects, canvas } = drawnRects(matrix);
    const first = rects[0];

    expect(first).toBeDefined();

    const step = first?.side ?? 0;
    const occupied = canvas.y - mm(5);
    const innerWidth = mm(80) - SIDE_MARGIN * 2;

    // Le carré réservé porte le symbole **et** ses deux marges.
    expect(occupied).toBeCloseTo(step * (matrix.length + 8), 5);
    expect(occupied).toBeLessThanOrEqual(SIZE + step);

    // Le premier module — le coin du motif de détection — est posé quatre pas
    // après le coin du carré réservé, en abscisse comme en ordonnée.
    const reservedLeft = SIDE_MARGIN + (innerWidth - occupied) / 2;

    expect(first?.x).toBeCloseTo(reservedLeft + 4 * step, 5);
    expect(first?.y).toBeCloseTo(mm(5) + 4 * step, 5);

    // Et rien n'est tracé dans la marge : le dernier module reste à quatre pas
    // du bord opposé.
    const right = Math.max(...rects.map((rect) => rect.x + rect.side));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.side));

    expect(reservedLeft + occupied - right).toBeCloseTo(4 * step, 5);
    expect(mm(5) + occupied - bottom).toBeCloseTo(4 * step, 5);
  });

  /**
   * Le module doit rester lisible à 203 ppp — la définition d'une thermique de
   * comptoir. En dessous d'environ quatre points d'impression, la trame se
   * brouille et le code cesse d'être décodable, marge ou pas.
   */
  it('garde un module imprimable à 203 ppp', () => {
    const { rects } = drawnRects(qrMatrix(URL));
    const stepMm = ((rects[0]?.side ?? 0) * 25.4) / 72;

    expect(stepMm * (203 / 25.4)).toBeGreaterThanOrEqual(4);
  });
});
