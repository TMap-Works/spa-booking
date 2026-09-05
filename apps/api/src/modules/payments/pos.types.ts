import type { Money } from './payments.types';

/**
 * Le vocabulaire du POS — ce que le service et le dépôt de la caisse acceptent
 * et rendent (#60, CDC §1.4 « POS de base : services et produits retail »).
 *
 * Ni DTO HTTP — ils vivent sous `dto/` —, ni types générés par Prisma
 * (api-module §2).
 *
 * `Money` vient de `payments.types.ts` : c'est le **même** module, et un ticket
 * de caisse et une intention Stripe ont exactement la même notion de montant —
 * un entier dans la plus petite unité, accompagné de son code ISO 4217. En
 * redéclarer une seconde ici aurait ouvert la porte à deux définitions de
 * l'argent dans un module qui n'en manipule que ça.
 *
 * TODO(#26) : `Product`, `Sale` et `SaleItem` appartiennent au contrat d'API et
 * seront importés de `@spa/shared` le jour où `apps/api` dépendra du paquet —
 * même TODO que dans `payments.types.ts`.
 */

/**
 * Nature d'une ligne de ticket — `enum SaleItemKind` du schéma.
 *
 * Liste locale plutôt qu'import du client généré, pour la raison qui vaut dans
 * `payments.types.ts` : ce fichier est lu par le service et le contrôleur, et
 * api-module §2 réserve l'import de `@prisma/client` au dépôt. Le **témoin**
 * vit dans la suite de test, qui compare cette liste à l'énumération réellement
 * générée.
 */
export const SALE_ITEM_KINDS = ['SERVICE', 'PRODUCT', 'TAX', 'TIP'] as const;
export type SaleItemKind = (typeof SALE_ITEM_KINDS)[number];

/**
 * Les deux natures que le comptoir **désigne** ; les deux autres sont composées
 * par le serveur et n'ont pas d'article derrière elles.
 */
export const CATALOG_ITEM_KINDS = ['SERVICE', 'PRODUCT'] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

/** Un article revendable, tel que le POS le lit et le rend. */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
  readonly isActive: boolean;
}

/** Ce que le dépôt écrit à la création d'un article. */
export interface ProductDraft {
  readonly sku: string;
  readonly name: string;
  readonly price: Money;
}

/**
 * Les champs **présents** d'une modification d'article, et eux seuls.
 *
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini » :
 * un `name: undefined` recopié dans un `data` Prisma écraserait le nom, là où
 * l'appelant demandait seulement de ne pas y toucher.
 */
export interface ProductPatch {
  readonly name?: string;
  readonly price?: Money;
  readonly isActive?: boolean;
}

/**
 * Une ligne telle que le comptoir la demande — **sans montant** pour les deux
 * natures qui en ont un au catalogue.
 *
 * C'est la forme même de cette union qui porte le troisième critère de #60 :
 * il n'existe aucun champ pour envoyer le prix d'une prestation ou d'un
 * article. Le montant n'est pas « ignoré » par le service, il n'a nulle part
 * où entrer.
 *
 * Le pourboire fait exception, et c'est la seule : il n'existe dans aucune
 * table à relire — c'est une somme qu'une personne décide au comptoir. Le
 * serveur ne peut donc que le valider, jamais le recalculer.
 */
export type SaleLineRequest =
  | { readonly kind: 'SERVICE'; readonly serviceId: string; readonly quantity: number }
  | { readonly kind: 'PRODUCT'; readonly productId: string; readonly quantity: number }
  | { readonly kind: 'TIP'; readonly amountMinor: number };

/** Le ticket tel que le comptoir le compose. */
export interface SaleRequest {
  /** `null` pour une vente retail autonome — deuxième critère de #60. */
  readonly appointmentId: string | null;
  readonly lines: readonly SaleLineRequest[];
}

/**
 * L'article résolu au catalogue, prêt à être facturé.
 *
 * C'est la seule source du prix unitaire : ce que rend `ServicesService.byId`
 * pour une prestation, ce que rend le dépôt pour un article. Le `label` est
 * recopié ici pour être **figé** sur la ligne — un renommage ultérieur ne doit
 * pas réécrire les tickets passés.
 */
export interface PricedCatalogItem {
  readonly kind: CatalogItemKind;
  readonly referenceId: string;
  readonly label: string;
  readonly unitPrice: Money;
  readonly quantity: number;
}

/** Une ligne du ticket, telle qu'elle est écrite puis relue. */
export interface SaleItem {
  readonly id: string;
  readonly kind: SaleItemKind;
  readonly serviceId: string | null;
  readonly productId: string | null;
  readonly label: string;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly lineAmount: Money;
  readonly position: number;
}

/** Une ligne prête à être écrite — la même, sans son identifiant. */
export type SaleItemDraft = Omit<SaleItem, 'id'>;

/**
 * Le ticket **composé** par le serveur : les lignes définitives et les quatre
 * montants qui en découlent.
 *
 * Rien ici ne vient de l'appelant hormis les quantités, les références et le
 * pourboire. C'est le résultat de `composeSale`, et c'est ce que le dépôt écrit
 * — jamais un montant qui aurait traversé HTTP.
 */
export interface ComposedSale {
  readonly currency: string;
  readonly subtotalAmountMinor: number;
  readonly taxAmountMinor: number;
  readonly tipAmountMinor: number;
  readonly totalAmountMinor: number;
  readonly items: readonly SaleItemDraft[];
}

/** Ce que le dépôt écrit pour un ticket entier, en une transaction. */
export interface SaleDraft extends ComposedSale {
  readonly appointmentId: string | null;
  readonly cashierUserId: string;
}

/** Le ticket tel que l'API le rend. */
export interface Sale {
  readonly id: string;
  readonly appointmentId: string | null;
  /**
   * Le compte qui a composé le ticket — la traçabilité de payments-stripe §4.
   *
   * Un identifiant, jamais un nom ni une adresse : le module `payments` n'a
   * aucune raison de lire les coordonnées de qui que ce soit, et ce qu'il ne
   * lit pas ne peut pas fuiter (CDC §5.1).
   */
  readonly cashierUserId: string;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly tip: Money;
  readonly total: Money;
  readonly items: readonly SaleItem[];
  readonly createdAt: Date;
}

/**
 * Le ticket **sans ses lignes** — l'élément de l'historique des ventes (#62).
 *
 * Les lignes sont écartées à dessein, et ce n'est pas une économie d'octets de
 * confort : une page de cinquante tickets de dix lignes en ferait transiter cinq
 * cents qu'aucun tableau n'affiche, lues une par une à la base. L'historique
 * répond « qui a vendu quoi, quand, pour combien » ; le détail d'un ticket se
 * demande par `GET /sales/:id`, qui existe pour cela depuis #60.
 *
 * `Omit` plutôt qu'une interface recopiée : les huit autres champs doivent rester
 * exactement ceux de `Sale`, et un champ ajouté au ticket doit apparaître ici
 * sans qu'on ait à y penser.
 */
export type SaleSummary = Omit<Sale, 'items'>;

/**
 * La fenêtre et les critères de l'historique des ventes (#62).
 *
 * `from` est inclus, `to` **exclu** — même convention que l'historique des
 * transactions, et pour la même raison : c'est ce qui permet de poser deux
 * journées de caisse bout à bout sans compter deux fois le ticket de minuit.
 *
 * Les deux filtres d'identifiant répondent aux deux questions que le back-office
 * pose réellement : « qu'a vendu cette personne aujourd'hui ? » — la relève de
 * caisse — et « qu'a-t-on facturé sur ce rendez-vous ? » — le rapprochement de
 * la fiche cliente. `@@index([tenantId, appointmentId])` a été posé pour la
 * seconde dès #60.
 */
export interface SaleHistoryFilter {
  readonly from?: Date;
  readonly to?: Date;
  readonly cashierUserId?: string;
  readonly appointmentId?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** Une page de tickets, avec de quoi afficher un sélecteur de page. */
export interface SalePage {
  readonly items: readonly SaleSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

/**
 * Le paramétrage de l'établissement dont la composition d'un ticket dépend.
 *
 * Les deux valeurs viennent de la ligne `tenants`, donc du serveur. Le taux est
 * en points de base — jamais un pourcentage à virgule, qui aurait introduit un
 * type inexact sur le chemin de l'argent.
 */
export interface TenantSaleSettings {
  readonly defaultCurrency: string;
  readonly taxRateBps: number;
}
