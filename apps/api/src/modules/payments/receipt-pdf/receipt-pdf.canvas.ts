import { printable } from './receipt-pdf.format';
import type { QrMatrix } from './receipt-pdf.qr';

/**
 * La planche à dessin des deux gabarits — #819, deuxième et quatrième critères.
 *
 * PDFKit sait poser du texte à une coordonnée ; il ne sait pas ce qu'est une
 * ligne de ticket, ni où commence la suivante. Cette classe tient le **curseur
 * vertical** et rien d'autre, pour que les gabarits décrivent un ticket —
 * « l'enseigne, une règle, les lignes, le total » — au lieu d'arithmétique de
 * points.
 *
 * ## Le mode mesure, et pourquoi il existe
 *
 * Le deuxième critère demande une « hauteur ajustée au contenu ». Or la taille
 * d'une page PDF est **figée à sa création** : il faut connaître la hauteur du
 * ticket avant d'avoir dessiné la première ligne. La solution est de dessiner
 * deux fois — une passe de mesure sur un document jetable, une passe de rendu
 * sur un document à la bonne hauteur —, avec le **même** code de gabarit.
 *
 * C'est le `draw` du constructeur. En mesure, le curseur avance exactement comme
 * en rendu — `heightOfString` fait foi dans les deux cas — mais rien n'est
 * écrit. Toute autre approche (estimer la hauteur, ou rogner après coup) aurait
 * fait diverger la mesure du rendu au premier libellé qui passe à la ligne, et
 * un ticket de caisse est plein de libellés de longueur inconnue.
 */

/** Points PostScript d'une longueur en millimètres — l'unité des deux gabarits. */
export function mm(value: number): number {
  return (value * 72) / 25.4;
}

/** Les graisses, telles que les gabarits les nomment. */
export type Weight = 'regular' | 'bold';

export interface TextOptions {
  readonly weight?: Weight;
  readonly size?: number;
  readonly align?: 'left' | 'center' | 'right';
  /** Retrait à gauche, en points — pour les sous-lignes d'un règlement. */
  readonly indent?: number;
  readonly gapAfter?: number;
}

export interface RowOptions {
  readonly weight?: Weight;
  readonly size?: number;
  /** Retrait à gauche, en points — pour les sous-lignes d'un règlement. */
  readonly indent?: number;
  readonly gapAfter?: number;
}

export interface RuleOptions {
  readonly dashed?: boolean;
  readonly gapAfter?: number;
}

/**
 * Ce que le gabarit sait demander à une planche à dessin.
 *
 * C'est une **interface** et non la classe, pour une raison de vérifiabilité :
 * le troisième critère porte sur l'*ordre* et le *contenu* des huit sections du
 * ticket, et cela ne se relit pas dans un flux PDF — le texte y est encodé en
 * indices de glyphes de la police sous-ensemblée, pas en ASCII. Une planche de
 * test qui enregistre ce qu'on lui demande rend le critère assertable ligne à
 * ligne, là où l'inspection du PDF ne prouverait que sa taille de page.
 *
 * `ReceiptCanvas` en est la seule implémentation de production.
 */
export interface ReceiptSurface {
  text(value: string, options?: TextOptions): void;
  row(label: string, amount: string, options?: RowOptions): void;
  rule(options?: RuleOptions): void;
  gap(height: number): void;
  qr(matrix: QrMatrix, size: number): void;
}

export interface CanvasOptions {
  /** Marge gauche et droite, en points. */
  readonly sideMargin: number;
  /** Ordonnée de départ, en points. */
  readonly top: number;
  /** Corps de texte par défaut, en points. */
  readonly baseSize: number;
  /**
   * Ordonnée au-delà de laquelle il faut une page de plus, ou `null` pour un
   * support d'une seule page dont la hauteur s'ajuste — le ticket 80 mm.
   */
  readonly pageBreakAt: number | null;
}

export class ReceiptCanvas implements ReceiptSurface {
  public y: number;

  public constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly options: CanvasOptions,
    private readonly draw: boolean,
  ) {
    this.y = options.top;
  }

  /** La largeur utile, entre les deux marges — 72 mm sur le ticket 80 mm. */
  public get innerWidth(): number {
    return this.doc.page.width - this.options.sideMargin * 2;
  }

  public get left(): number {
    return this.options.sideMargin;
  }

  /** Avance le curseur sans rien poser. */
  public gap(height: number): void {
    this.y += height;
  }

  /**
   * S'assure qu'il reste `height` points, en ouvrant une page au besoin.
   *
   * Sans seuil de coupe — le ticket 80 mm —, c'est un no-op : sa page grandit
   * avec son contenu, il n'a par construction jamais de débord.
   */
  public ensure(height: number): void {
    const breakAt = this.options.pageBreakAt;

    if (breakAt === null || this.y + height <= breakAt) {
      return;
    }

    if (this.draw) {
      this.doc.addPage();
    }

    this.y = this.options.top;
  }

  /** Pose un paragraphe et avance le curseur de sa hauteur. */
  public text(value: string, options: TextOptions = {}): void {
    const size = options.size ?? this.options.baseSize;
    const indent = options.indent ?? 0;
    const width = this.innerWidth - indent;

    this.doc.font(options.weight ?? 'regular').fontSize(size);

    const content = printable(value);
    const height = this.doc.heightOfString(content, { width });

    this.ensure(height);

    if (this.draw) {
      this.doc.text(content, this.left + indent, this.y, {
        width,
        align: options.align ?? 'left',
      });
    }

    this.y += height + (options.gapAfter ?? 0);
  }

  /**
   * Une ligne à deux colonnes : un libellé à gauche, un montant à droite.
   *
   * C'est la forme de presque tout ce qu'un ticket porte — une prestation et son
   * prix, un taux et sa taxe, un total et sa valeur. La colonne de droite est
   * alignée à droite et de largeur fixe : c'est ce qui fait que les virgules
   * décimales tombent les unes sous les autres, seul moyen de contrôler une
   * addition à l'œil.
   *
   * La hauteur retenue est celle de la **plus haute** des deux colonnes : un
   * libellé de prestation qui passe à la ligne ne doit pas se faire recouvrir
   * par la ligne suivante.
   */
  public row(label: string, amount: string, options: RowOptions = {}): void {
    const size = options.size ?? this.options.baseSize;
    const indent = options.indent ?? 0;
    const available = this.innerWidth - indent;
    const amountWidth = available * 0.38;
    const labelWidth = available - amountWidth - mm(2);

    this.doc.font(options.weight ?? 'regular').fontSize(size);

    const left = printable(label);
    const right = printable(amount);
    const height = Math.max(
      this.doc.heightOfString(left, { width: labelWidth }),
      this.doc.heightOfString(right, { width: amountWidth }),
    );

    this.ensure(height);

    if (this.draw) {
      this.doc.text(left, this.left + indent, this.y, { width: labelWidth });
      this.doc.text(right, this.left + this.innerWidth - amountWidth, this.y, {
        width: amountWidth,
        align: 'right',
      });
    }

    this.y += height + (options.gapAfter ?? 0);
  }

  /** Un filet horizontal — le séparateur des sections du ticket. */
  public rule(options: RuleOptions = {}): void {
    this.ensure(mm(1));

    if (this.draw) {
      const line = this.doc.moveTo(this.left, this.y).lineTo(this.left + this.innerWidth, this.y);

      line.lineWidth(0.5);

      if (options.dashed === true) {
        line.dash(1.5, { space: 1.5 }).stroke().undash();
      } else {
        line.stroke();
      }
    }

    this.y += options.gapAfter ?? mm(2);
  }

  /**
   * Le QR code, centré, dans un carré de `size` points **plus sa marge blanche**.
   *
   * ## Le pas des modules
   *
   * Il est arrondi au **centième de point** plutôt que laissé à sa valeur
   * théorique : un pas régulier donne une trame régulière, là où deux modules
   * voisins tombés de part et d'autre de la grille du pilote ressortent l'un
   * gras et l'autre maigre. Le prix est quelques dixièmes de millimètre sur la
   * largeur totale, ce qui ne se voit pas.
   *
   * ## La zone de silence, et pourquoi elle est **dans** le carré
   *
   * `qrcode-generator` ne rend que les modules du symbole : sa matrice
   * commence au coin du motif de détection, sans la marge que la norme exige.
   * Or ISO/IEC 18004 §6.3.8 impose **quatre modules** de blanc tout autour, et
   * un lecteur qui l'applique refuse un code collé à son voisinage. Sur le
   * ticket 80 mm, le pied ne laisse que 2 mm au-dessus et 1,5 mm en dessous du
   * carré, pour une marge attendue de près de 3 mm : la dessiner ici est la
   * seule façon qu'elle existe quel que soit le gabarit qui appelle.
   *
   * Elle est comptée **dans** `size` — le carré demandé porte le symbole et sa
   * marge — pour que la place réservée par la passe de mesure soit exactement
   * celle que la passe de rendu occupe.
   */
  public qr(matrix: QrMatrix, size: number): void {
    const modules = matrix.length;

    if (modules === 0) {
      return;
    }

    // ISO/IEC 18004 §6.3.8 — quatre modules de blanc de chaque côté.
    const quietModules = 4;
    const spanned = modules + quietModules * 2;
    const step = Math.max(0.25, Math.round((size / spanned) * 100) / 100);
    const quiet = step * quietModules;
    const side = step * spanned;

    this.ensure(side);

    if (this.draw) {
      const originX = this.left + (this.innerWidth - side) / 2 + quiet;
      const originY = this.y + quiet;

      this.doc.fillColor('black');

      for (let row = 0; row < modules; row += 1) {
        const cells = matrix[row] ?? [];

        for (let column = 0; column < cells.length; column += 1) {
          if (cells[column] === true) {
            this.doc.rect(originX + column * step, originY + row * step, step, step).fill();
          }
        }
      }
    }

    this.y += side;
  }
}
