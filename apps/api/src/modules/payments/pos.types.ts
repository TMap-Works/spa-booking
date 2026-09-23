import type { HistoryWindow } from './history';
import type { Money, SettlementMean } from './payments.types';

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
 * Écart assumé, tranché en #554 : `Product`, `Sale` et `SaleItem` appartiennent au contrat d'API, et
 * #510 n'a pas pu les y prendre pour la raison la plus simple qui soit : le
 * contrat **ne les décrit pas**. `packages/shared/src/schemas/payment.ts` porte
 * l'intention de paiement, le remboursement et l'encaissement au comptoir, mais
 * ni le produit retail, ni le ticket de caisse, ni ses lignes. Il n'y a donc pas
 * d'import à faire mais des schémas à écrire, dans un paquet hors de l'empreinte
 * de ce ticket — et l'écriture n'est pas mécanique : elle demande de trancher la
 * casse de `SALE_ITEM_KINDS` et de `PAYMENT_METHODS`, que la colonne écrit en
 * majuscules et que le contrat nomme partout ailleurs en minuscules (premier
 * point de vigilance de #510, même constat que dans `reporting.types.ts`).
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
 * C'est la seule source du prix unitaire : ce que rend `ServicesService.byIds`
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
 *
 * ## Les prix du catalogue sont TTC (#816)
 *
 * Les lignes `SERVICE` et `PRODUCT` portent le prix **affiché** — celui du
 * tunnel, celui du reçu, taxe comprise. Les quatre montants ci-dessous en
 * découlent par **extraction**, jamais par addition : c'est la correction de
 * #816, et c'est ce qui fait qu'un soin annoncé 65,00 € se facture 65,00 €.
 */
export interface ComposedSale {
  readonly currency: string;
  /**
   * La part **hors taxe** des lignes du catalogue —
   * `arrondi(ttc × 10 000 / (10 000 + taux))`.
   *
   * Jusqu'à #816, c'était la somme des prix affichés, sur laquelle la taxe
   * s'ajoutait ensuite. Le nom de la colonne n'a pas changé, son sens si : voir
   * le README du module.
   */
  readonly subtotalAmountMinor: number;
  /**
   * La taxe **comprise dans** les prix affichés — `ttc − ht`, jamais un montant
   * de plus à payer.
   */
  readonly taxAmountMinor: number;
  /** Le pourboire, hors taxe par nature : ce n'est pas une prestation vendue. */
  readonly tipAmountMinor: number;
  /**
   * Ce que la cliente doit : `sous-total + taxe + pourboire`, c'est-à-dire la
   * **somme des prix affichés** plus le pourboire.
   *
   * La forme est celle que `sales_total_amount_minor_check` vérifie en base, et
   * elle tient telle quelle depuis que `subtotal` est le montant hors taxe.
   */
  readonly totalAmountMinor: number;
  readonly items: readonly SaleItemDraft[];
}

/** Ce que le dépôt écrit pour un ticket entier, en une transaction. */
export interface SaleDraft extends ComposedSale {
  readonly appointmentId: string | null;
  readonly cashierUserId: string;
  /**
   * Le taux **sous lequel ce ticket est composé**, en points de base — #818,
   * cinquième critère.
   *
   * Il est figé sur la vente, et non relu sur l'établissement à l'affichage :
   * un salon qui change de taux ne doit pas réécrire la ventilation de ses
   * tickets passés. Il est porté ici plutôt que par {@link ComposedSale} parce
   * qu'il ne participe à aucun des quatre montants — `composeSale` le consomme,
   * le ticket le conserve.
   */
  readonly taxRateBps: number;
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
  /**
   * Ce qui a été **capturé** sur ce ticket — #817.
   *
   * « Capturé » et non « engagé » : une intention carte en vol n'y compte
   * **pas**, et c'est délibéré — une carte refusée ne doit pas condamner le
   * ticket jusqu'à ce qu'un webhook relâche la somme. C'est le webhook
   * `payment_intent.succeeded` qui fait avancer ce compte.
   *
   * Ce que cela laisserait ouvert — un ticket réglé au comptoir pendant qu'une
   * intention est en vol — est fermé un cran plus haut : `SettlementRepository`
   * refuse un règlement de comptoir sur un ticket qui porte une intention
   * vivante.
   */
  readonly settled: Money;
  /** `total − settled`, jamais négatif : la base l'interdit. */
  readonly remaining: Money;
  /** L'instant du solde, ou `null` tant qu'il reste un centime dû. */
  readonly settledAt: Date | null;
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
  /**
   * Restreindre aux tickets **réglés par ce moyen** — #834, sixième critère.
   *
   * C'est ce qui rend la relève du TPE possible : `mean=CARD_TERMINAL` posé sur
   * la journée de caisse rend les tickets passés au terminal, dont le total se
   * compare au relevé de fin de journée que le terminal imprime.
   *
   * ## Ce que le filtre retient exactement
   *
   * Un ticket portant **au moins un** encaissement abouti par ce moyen. C'est
   * la seule sémantique tenable en présence du règlement mixte de #817 : un
   * ticket de 78,00 € réglé 50,00 € en espèces puis 28,00 € au terminal
   * apparaît sous les deux moyens, parce qu'il *a* été réglé par les deux. Son
   * `total` reste celui du ticket entier — la part passée au terminal se lit sur
   * les lignes de `GET /payments`, qui portent un montant par encaissement.
   *
   * La **journée**, elle, est le couple `settledWithin` ci-dessous, et non
   * `from`/`to` : la relève se lit sur l'instant de **capture** du règlement,
   * pas sur l'ouverture du ticket (#1027).
   */
  readonly mean?: SettlementMean;
  /**
   * La fenêtre de l'instant de **capture** du règlement — #1027, deuxième point.
   *
   * ## Pourquoi une seconde fenêtre, et non un autre sens donné à la première
   *
   * `from`/`to` bornent l'ouverture du ticket — `sales.created_at` —, et c'est
   * la même convention que l'historique des transactions, qui lit la même
   * journée de caisse. Un ticket ouvert le 17 à 23 h 55 et réglé au TPE le 18 à
   * 00 h 05 manquait donc à la requête du 18, alors qu'il figure sur le relevé
   * que le terminal imprime le 18 — c'est-à-dire précisément l'usage auquel le
   * sixième critère de #834 destine `mean`.
   *
   * Le choix était entre deux paramètres distincts et une fenêtre dont le sens
   * suit le filtre. C'est la **première** branche qui est retenue, pour la
   * raison que l'ADR 0015 développe déjà à propos de `PaymentCardChannel` : on
   * ne change pas en silence le sens d'un filtre que des consommateurs lisent
   * déjà. `from`/`to` gardent le leur, et la relève se demande par la fenêtre
   * qui dit ce qu'elle borne.
   *
   * ## Les deux critères portent sur le **même** encaissement
   *
   * `mean` et cette fenêtre se posent sur une seule condition d'existence : le
   * ticket doit porter un règlement qui soit **à la fois** de ce moyen et
   * capturé dans cette fenêtre. Deux conditions séparées auraient rendu un
   * ticket réglé en espèces le 18 et au terminal le 17 sous
   * `mean=CARD_TERMINAL` + la journée du 18 — une ligne que le relevé du
   * terminal ne porte pas.
   *
   * Utilisable seule : sans `mean`, elle rend les tickets dont un encaissement
   * abouti a été capturé dans la fenêtre, tous moyens confondus.
   *
   * L'index est déjà là : `payments(tenant_id, status, captured_at)`, posé par
   * #74 pour cette lecture exacte.
   */
  readonly settledWithin?: HistoryWindow;
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
