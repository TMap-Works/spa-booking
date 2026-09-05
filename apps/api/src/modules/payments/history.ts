import { HistoryWindowInvalidError } from './payments.errors';

/**
 * Les deux règles que partagent les deux historiques de #62 — celui des ventes
 * et celui des transactions.
 *
 * Elles vivent ici plutôt que recopiées dans `SalesService` et
 * `PaymentsHistoryService` parce qu'elles doivent rester **identiques** : deux
 * écrans de back-office qui compteraient leurs pages différemment, ou qui
 * n'auraient pas la même idée d'une fenêtre valable, se contrediraient sur le
 * même jour de caisse.
 *
 * Fonctions pures, sans dépendance Nest : elles s'exercent sans monter quoi que
 * ce soit.
 */

/**
 * Une fenêtre d'historique — `from` **inclus**, `to` **exclu**.
 *
 * C'est la seule convention qui permette de poser deux journées de caisse bout à
 * bout sans compter deux fois l'encaissement de minuit, ni l'oublier. Les deux
 * bornes sont facultatives : sans elles, l'historique rend tout, paginé.
 */
export interface HistoryWindow {
  readonly from?: Date;
  readonly to?: Date;
}

/**
 * Refuse une fenêtre qui ne contient aucun instant.
 *
 * `from >= to` et non `>` : la borne haute étant exclue, une fenêtre dont les
 * deux bornes coïncident est vide elle aussi. Rendre une page vide aurait été
 * défendable, mais trompeur — « aucune transaction » et « la fenêtre est à
 * l'envers » appellent deux conduites différentes.
 *
 * @throws {HistoryWindowInvalidError} 422, les deux bornes étant par ailleurs
 * bien formées : c'est leur relation qui est refusée, pas leur syntaxe.
 */
export function assertOrderedWindow(window: HistoryWindow): void {
  const { from, to } = window;

  if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
    throw new HistoryWindowInvalidError();
  }
}

/**
 * Le nombre de pages d'un ensemble — `0` sur un ensemble vide.
 *
 * « Page 1 sur 0 » et non « page 1 sur 1 » : c'est la convention déjà rendue par
 * `CustomerPageDto`, et un écran qui afficherait « 1 sur 1 » sur une recherche
 * sans résultat laisserait croire à une page qu'on aurait mal lue.
 */
export function totalPagesOf(totalItems: number, pageSize: number): number {
  return Math.ceil(totalItems / pageSize);
}

/**
 * Le critère `created_at` d'une fenêtre — ou **rien** quand elle est ouverte des
 * deux côtés.
 *
 * `gte` sur `from`, `lt` sur `to` : la borne haute est exclue, ce qui permet de
 * poser deux journées de caisse bout à bout sans compter deux fois l'écriture de
 * minuit. C'est la traduction, côté `where`, de la convention qu'`assertOrderedWindow`
 * fait respecter — et elle vit ici pour la même raison : `transactionWhere` et
 * `saleWhere` doivent rester des jumeaux, et deux copies finiraient par ne plus
 * avoir la même idée d'un jour de caisse.
 *
 * `undefined` plutôt qu'un objet vide : un `createdAt: {}` porté jusqu'au `where`
 * de Prisma s'y lirait comme un filtre à composer plutôt que comme l'absence de
 * filtre. La forme rendue est celle d'un filtre de date de Prisma, sans en
 * importer le type — ce fichier reste pur.
 */
export function createdAtWithin(
  window: HistoryWindow,
): { gte?: Date; lt?: Date } | undefined {
  if (window.from === undefined && window.to === undefined) {
    return undefined;
  }

  return {
    ...(window.from === undefined ? {} : { gte: window.from }),
    ...(window.to === undefined ? {} : { lt: window.to }),
  };
}

/** Les deux paramètres de pagination, une fois résolus à la frontière HTTP. */
export interface HistoryPageBounds {
  readonly page: number;
  readonly pageSize: number;
}

/** Ce qu'un dépôt d'historique rend : la tranche demandée, et le compte total. */
export interface HistorySlice<T> {
  readonly items: readonly T[];
  readonly totalItems: number;
}

/** Une page d'historique, avec de quoi afficher un sélecteur de page. */
export interface HistoryPage<T> extends HistoryPageBounds, HistorySlice<T> {
  readonly totalPages: number;
}

/**
 * Assemble la page rendue par un historique.
 *
 * Les deux historiques de #62 la composaient à l'identique, à quatre lignes
 * près : c'est exactement le genre de recopie qui laisse un écran compter ses
 * pages autrement que l'autre. Le compte des pages passe par `totalPagesOf`,
 * donc « page 1 sur 0 » sur un ensemble vide, des deux côtés.
 */
export function toHistoryPage<T>(bounds: HistoryPageBounds, slice: HistorySlice<T>): HistoryPage<T> {
  return {
    items: slice.items,
    page: bounds.page,
    pageSize: bounds.pageSize,
    totalItems: slice.totalItems,
    totalPages: totalPagesOf(slice.totalItems, bounds.pageSize),
  };
}
