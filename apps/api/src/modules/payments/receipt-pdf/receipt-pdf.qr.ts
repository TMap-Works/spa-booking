import qrcode from 'qrcode-generator';

/**
 * Le QR code du pied de ticket — #819, troisième critère, huitième section.
 *
 * Il rend une **matrice de booléens**, et ne dessine rien. C'est ce qui le rend
 * vérifiable par un test unitaire — nombre de modules, motifs de détection aux
 * trois coins, marge — là où un PDF ne se relit qu'à l'œil.
 *
 * ## Pourquoi `qrcode-generator` et pas `qrcode`
 *
 * Les deux encodent correctement. `qrcode` rend des PNG et des SVG, ce dont nous
 * n'avons aucun usage — un PDF dessine des rectangles —, et tire `yargs` pour sa
 * ligne de commande. `qrcode-generator` n'a **aucune dépendance**, porte ses
 * propres types, et expose exactement la primitive dont un gabarit a besoin :
 * `isDark(ligne, colonne)`.
 *
 * Ni l'un ni l'autre ne demande de navigateur — c'est la contrainte que le
 * premier critère pose pour la bibliothèque PDF, et elle vaut tout autant pour
 * ce qu'on lui ajoute : embarquer Chromium pour tramer un carré de 21 modules
 * aurait été la même faute, en plus petit.
 */

/**
 * Les octets d'une chaîne, en UTF-8.
 *
 * Par défaut, `qrcode-generator` encode en Latin-1 : une URL dont l'origine
 * porte un caractère hors de cette plage — un domaine internationalisé — serait
 * encodée en octets faux, et le QR mènerait ailleurs. La substitution est faite
 * une fois, au chargement du module, sur la fabrique elle-même : c'est
 * l'interface que la bibliothèque prévoit pour cela.
 *
 * La garde est ce qu'impose `noUncheckedIndexedAccess`, et elle n'est pas de
 * pure forme : un accès à une table par une clé littérale rend `T | undefined`,
 * et écraser `stringToBytes` par `undefined` aurait produit un « n'est pas une
 * fonction » au premier ticket imprimé plutôt qu'à la compilation.
 */
const utf8Bytes = qrcode.stringToBytesFuncs['UTF-8'];

if (utf8Bytes !== undefined) {
  qrcode.stringToBytes = utf8Bytes;
}

/**
 * La correction d'erreur, à **M** — environ 15 % de modules restituables.
 *
 * `L` (7 %) serait suffisant sur un écran et insuffisant sur du papier
 * thermique : l'encre s'y efface à la chaleur et au frottement, et un ticket
 * vit dans une poche. `H` (30 %) densifierait la matrice sans gain lisible à
 * 203 ppp — plus de modules dans la même largeur, donc des modules plus petits,
 * donc un code plus fragile que celui qu'on voulait renforcer.
 */
const ERROR_CORRECTION = 'M';

/** La matrice d'un QR code, ligne par ligne. `true` vaut module noir. */
export type QrMatrix = readonly (readonly boolean[])[];

/**
 * La matrice du QR code d'un texte.
 *
 * La version est laissée à la bibliothèque (`0` : automatique) — elle prend la
 * plus petite qui accepte la charge, ce qui donne les modules les plus gros
 * pour une largeur imprimée donnée.
 */
export function qrMatrix(text: string): QrMatrix {
  const code = qrcode(0, ERROR_CORRECTION);

  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const rows: boolean[][] = [];

  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];

    for (let column = 0; column < size; column += 1) {
      cells.push(code.isDark(row, column));
    }

    rows.push(cells);
  }

  return rows;
}
