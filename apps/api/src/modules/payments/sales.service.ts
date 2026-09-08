import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
// Import **de valeur** et non `import type` : Nest lit le type du paramètre de
// constructeur dans les métadonnées émises par TypeScript, et un `import type`
// s'efface à la compilation — l'injection échouerait alors au démarrage.
import { ServicesService } from '../catalog/services.service';
import { assertOrderedWindow, toHistoryPage } from './history';
import {
  SaleAmountOutOfRangeError,
  SaleCurrencyMismatchError,
  SaleItemUnavailableError,
} from './payments.errors';
import type { Money } from './payments.types';
import { PosRepository } from './pos.repository';
import { composeSale, fitsInAmountColumn } from './pos.totals';
import type {
  PricedCatalogItem,
  Sale,
  SaleHistoryFilter,
  SaleLineRequest,
  SalePage,
  SaleRequest,
  TenantSaleSettings,
} from './pos.types';

/**
 * Ce qu'une ligne de ticket a besoin de savoir d'un article, quelle que soit sa
 * nature.
 *
 * `ServiceView` et `Product` n'ont pas la même forme complète — l'une porte une
 * durée et des tampons, l'autre un code article — mais le prix d'une ligne ne
 * dépend que de ces quatre champs. Les nommer ici évite d'avoir à choisir entre
 * les deux types à chaque accès, sans élargir ce que la caisse lit du catalogue.
 */
interface SellableArticle {
  readonly id: string;
  readonly name: string;
  readonly price: Money;
  readonly isActive: boolean;
}

/**
 * Le catalogue d'un ticket : tout ce que ses lignes désignent, déjà lu et indexé
 * par identifiant (#420).
 *
 * Deux ensembles et non un seul : un identifiant de prestation et un identifiant
 * d'article vivent dans deux tables, et rien n'interdit qu'ils coïncident. Les
 * confondre dans une table unique aurait fait dépendre le prix d'une ligne de
 * l'ordre des lectures.
 */
interface TicketCatalog {
  readonly services: ReadonlyMap<string, SellableArticle>;
  readonly products: ReadonlyMap<string, SellableArticle>;
}

/** Un ensemble d'articles, indexé par identifiant — l'ordre n'y veut rien dire. */
function indexById<T extends { readonly id: string }>(
  articles: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(articles.map((article) => [article.id, article]));
}

/**
 * Résout une ligne de catalogue en prix unitaire — **le seul chemin par lequel
 * un montant d'article entre dans un ticket**.
 *
 * Trois refus, dans l'ordre où ils comptent : l'article n'existe pas ici (404,
 * indiscernable du voisin), il existe mais n'est plus vendable (422), il est
 * libellé dans une autre devise (422). Le premier protège la frontière du
 * tenant, les deux autres protègent la pièce comptable.
 *
 * ## Le contrat du refus multi-lignes : la première position fautive
 *
 * Cette fonction juge **une** ligne ; l'appelant les parcourt dans l'ordre du
 * comptoir, et le premier refus l'emporte — `details.position` désigne cette
 * ligne-là et aucune autre. Lire le catalogue par lot (#420) aurait permis de
 * rapporter d'un coup toutes les positions fautives ; ce n'est délibérément pas
 * fait. C'est sur cette position unique que l'écran de caisse surligne, et en
 * changer serait un changement du contrat d'API — donc une écriture dans
 * `packages/shared`, hors de l'empreinte du ticket qui a groupé la lecture. La
 * lecture est devenue constante, le jugement reste séquentiel.
 *
 * Pure et synchrone : tout ce dont elle a besoin a déjà été lu.
 */
function priceLine(
  line: Extract<SaleLineRequest, { kind: 'SERVICE' | 'PRODUCT' }>,
  position: number,
  settings: TenantSaleSettings,
  catalog: TicketCatalog,
): PricedCatalogItem {
  const article =
    line.kind === 'SERVICE'
      ? catalog.services.get(line.serviceId)
      : catalog.products.get(line.productId);

  if (article === undefined) {
    // Le refus ne distingue pas « inconnu » de « chez le voisin » : les deux
    // lectures sont scopées, et n'ont donc simplement pas rendu la ligne. Le
    // libellé suit la nature que l'appelant vient de demander, et ne lui apprend
    // rien qu'il ne sache déjà.
    throw new NotFoundError(
      line.kind === 'SERVICE' ? 'Prestation introuvable.' : 'Article introuvable.',
    );
  }

  if (!article.isActive) {
    throw new SaleItemUnavailableError(position);
  }

  if (article.price.currency !== settings.defaultCurrency) {
    throw new SaleCurrencyMismatchError(position);
  }

  return {
    kind: line.kind,
    referenceId: article.id,
    // Le libellé est **figé** ici : un renommage ultérieur de l'article ne doit
    // pas réécrire les tickets déjà émis.
    label: article.name,
    unitPrice: article.price,
    quantity: line.quantity,
  };
}

/**
 * La caisse — composition et lecture d'un ticket (#60, CDC §1.4 « POS de
 * base »).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Les quatre invariants qu'il tient
 *
 * 1. **Le total est recalculé côté serveur.** Le corps de la requête ne porte
 *    que des références et des quantités ; chaque prix unitaire est relu à sa
 *    source — `ServicesService` pour une prestation, le dépôt pour un article —
 *    et le total est composé par `composeSale`. C'est le troisième critère de
 *    #60, et il tient par construction : `SaleLineRequest` n'a pas de champ où
 *    un montant de prestation ou d'article pourrait entrer.
 * 2. **Le pourboire est la seule valeur acceptée de l'appelant**, parce qu'il
 *    n'existe dans aucune table à relire. Il est borné par le DTO, jamais
 *    « recalculé » — il n'y aurait rien à partir de quoi le recalculer.
 * 3. **Taxes et pourboires sont des lignes distinctes**, jamais des montants
 *    fondus dans le prix d'un article (payments-stripe §5, cinquième critère).
 * 4. **Aucun montant n'est un flottant.** Entiers dans la plus petite unité,
 *    devise explicite, taux de taxe en points de base.
 *
 * ## Deux lectures par ticket, quelle qu'en soit la longueur
 *
 * Les prix sont relus **par lot** (#420) : une lecture pour toutes les
 * prestations du ticket, une pour tous ses articles, avant que la moindre ligne
 * ne soit jugée. La résolution ligne par ligne d'origine coûtait un aller-retour
 * par ligne — jusqu'à cent, la borne du DTO —, invisible sur l'addition de deux
 * lignes d'un comptoir réel, mesurable sur une addition longue.
 *
 * Ce que le groupement **ne change pas** : le refus. Les lignes restent jugées
 * dans l'ordre du comptoir et le premier refus l'emporte, `details.position`
 * désignant cette ligne-là. Rapporter d'un coup toutes les positions fautives
 * serait un autre contrat, et il se déciderait dans `packages/shared`, pas ici.
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est le point. Le dépôt est scopé par le contexte de
 * requête, `ServicesService` l'est par le sien : une prestation ou un article
 * d'un autre établissement est *introuvable*, et le ticket entier est refusé en
 * 404 — jamais 403, qui confirmerait son existence (tenant-isolation §4). Ce
 * service ne compare aucun `tenantId` parce qu'il n'en reçoit aucun. Lire par
 * lot n'y change rien : un identifiant du voisin est absent des deux ensembles
 * rendus, exactement comme un identifiant inventé.
 *
 * ## Ce que ce service ne fait pas
 *
 * **Il n'encaisse rien.** Composer le ticket et le régler sont deux gestes
 * distincts : le règlement — espèces au comptoir, carte par Stripe Terminal ou
 * lien de paiement — est l'affaire de #62 et de la ligne `payments`, qui a sa
 * propre unicité et son propre cycle de vie. Un ticket existe donc avant d'être
 * payé, ce qui est exactement ce qu'un comptoir fait.
 */
@Injectable()
export class SalesService {
  public constructor(
    private readonly repository: PosRepository,
    /**
     * La voie conforme d'api-module §3 pour lire le catalogue : un appel de
     * service, jamais le dépôt du module voisin. C'est `catalog` qui décide de
     * ce qu'est le prix d'une prestation, et il n'y a aucune raison que le POS
     * en ait un second avis.
     */
    private readonly services: ServicesService,
  ) {}

  /**
   * Compose un ticket et l'inscrit.
   *
   * @throws {NotFoundError} rendez-vous, prestation ou article inconnu — ou
   * appartenant à un autre établissement, ce qui doit être indiscernable.
   * @throws {SaleItemUnavailableError} article existant mais retiré du catalogue.
   * @throws {SaleCurrencyMismatchError} article libellé dans une autre devise.
   * @throws {SaleAmountOutOfRangeError} total hors des bornes d'un montant.
   */
  public async open(request: SaleRequest, cashierUserId: string): Promise<Sale> {
    const settings = await this.requireSettings();

    if (request.appointmentId !== null && !(await this.repository.appointmentExists(request.appointmentId))) {
      // Le message ne distingue pas « inconnu » de « chez le voisin » : la
      // différence servirait de sonde d'existence. `details` reste vide, pour
      // que les deux refus soient identiques octet pour octet.
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    // **Deux lectures pour le ticket entier**, quelle qu'en soit sa longueur
    // (#420) : une pour les prestations, une pour les articles. La résolution
    // ligne par ligne qui les précédait coûtait un aller-retour par ligne,
    // jusqu'à cent par addition.
    const catalog = await this.readCatalog(request.lines);

    const items: PricedCatalogItem[] = [];
    let tipAmountMinor = 0;

    // Les lignes sont jugées **dans l'ordre du comptoir** : c'est cet ordre que
    // `position` fige, donc celui du reçu. Le rang sert aussi à désigner la
    // ligne fautive dans un refus, sans jamais recopier d'identifiant — et c'est
    // la **première** fautive qui l'emporte, contrat inchangé par le groupement
    // des lectures.
    for (const [position, line] of request.lines.entries()) {
      if (line.kind === 'TIP') {
        // Un seul pourboire par ticket — le DTO le garantit. Le cumul est écrit
        // ainsi plutôt qu'une affectation pour que la règle reste vraie même si
        // cette borne bougeait un jour.
        tipAmountMinor += line.amountMinor;
        continue;
      }

      items.push(priceLine(line, position, settings, catalog));
    }

    const composed = composeSale({
      currency: settings.defaultCurrency,
      taxRateBps: settings.taxRateBps,
      items,
      tipAmountMinor,
    });

    if (!fitsInAmountColumn(composed)) {
      throw new SaleAmountOutOfRangeError();
    }

    return this.repository.createSale({
      ...composed,
      appointmentId: request.appointmentId,
      cashierUserId,
    });
  }

  /**
   * Un ticket, par identifiant — lignes comprises.
   *
   * @throws {NotFoundError} ticket inconnu, ou d'un autre établissement.
   */
  public async byId(id: string): Promise<Sale> {
    const sale = await this.repository.findSaleById(id);

    if (sale === null) {
      throw new NotFoundError('Ticket introuvable.');
    }

    return sale;
  }

  /**
   * L'historique des ventes, du plus récent au plus ancien (#62).
   *
   * Chaque élément porte les trois faits que le premier critère de #62 demande
   * d'une vente : l'**opérateur** (`cashierUserId`, `NOT NULL` depuis #60),
   * l'**horodatage** (`createdAt`) et le **montant** (les quatre montants, en
   * fait — sous-total, taxe, pourboire, total). Sans ses lignes : le détail d'un
   * ticket se demande par `byId`.
   *
   * @throws {HistoryWindowInvalidError} `from` postérieur ou égal à `to` — la
   * borne haute étant exclue, une telle fenêtre ne contient aucun instant.
   */
  public async history(filter: SaleHistoryFilter): Promise<SalePage> {
    assertOrderedWindow(filter);

    return toHistoryPage(filter, await this.repository.listSales(filter));
  }

  /**
   * Lit d'un coup tout ce que les lignes du ticket désignent — **deux requêtes,
   * et non une par ligne** (#420).
   *
   * Les deux partent de front : elles visent deux tables distinctes, et rien
   * dans l'une ne conditionne l'autre. Sur un ticket qui ne porte qu'une nature,
   * la lecture de l'autre ne coûte rien du tout — `byIds` et
   * `findProductsByIds` court-circuitent sur un lot vide.
   *
   * Ce que la lecture anticipée change, et qui ne s'observe pas : les lignes qui
   * suivent une ligne fautive sont désormais lues avant que le refus ne tombe.
   * Elles ne sont ni écrites, ni rendues, et les deux lectures sont bornées à
   * l'établissement courant — il n'y a donc ni effet, ni fuite, seulement un
   * coût que le lot rend constant.
   *
   * Les références sont **dédoublonnées** en chemin : trois shampoings sur trois
   * lignes ne font qu'un identifiant à demander. La base les confondrait de
   * toute façon, mais un `IN` de cent paramètres pour dix articles distincts
   * serait exactement le gaspillage que ce regroupement existe pour supprimer.
   * Le ticket, lui, garde ses trois lignes : c'est la boucle de `open` qui
   * facture, pas ce lot.
   */
  private async readCatalog(lines: readonly SaleLineRequest[]): Promise<TicketCatalog> {
    const serviceIds = new Set<string>();
    const productIds = new Set<string>();

    for (const line of lines) {
      if (line.kind === 'SERVICE') {
        serviceIds.add(line.serviceId);
      } else if (line.kind === 'PRODUCT') {
        productIds.add(line.productId);
      }
    }

    const [services, products] = await Promise.all([
      // `byIds` est la voie conforme d'api-module §3, au même titre que `byId`
      // avant elle : c'est `catalog` qui décide du prix d'une prestation, et le
      // POS n'en a pas de second avis — pas plus par lot qu'à l'unité.
      this.services.byIds([...serviceIds]),
      this.repository.findProductsByIds([...productIds]),
    ]);

    return { services: indexById(services), products: indexById(products) };
  }

  /** Le paramétrage de l'établissement courant — voir `ProductsService`. */
  private async requireSettings(): Promise<TenantSaleSettings> {
    const settings = await this.repository.tenantSaleSettings();

    if (settings === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return settings;
  }
}
