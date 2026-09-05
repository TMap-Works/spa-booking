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
} from './pos.errors';
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
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est le point. Le dépôt est scopé par le contexte de
 * requête, `ServicesService` l'est par le sien : une prestation ou un article
 * d'un autre établissement est *introuvable*, et le ticket entier est refusé en
 * 404 — jamais 403, qui confirmerait son existence (tenant-isolation §4). Ce
 * service ne compare aucun `tenantId` parce qu'il n'en reçoit aucun.
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

    const items: PricedCatalogItem[] = [];
    let tipAmountMinor = 0;

    // Les lignes sont résolues **dans l'ordre du comptoir** : c'est cet ordre
    // que `position` fige, donc celui du reçu. Le rang sert aussi à désigner la
    // ligne fautive dans un refus, sans jamais recopier d'identifiant.
    for (const [position, line] of request.lines.entries()) {
      if (line.kind === 'TIP') {
        // Un seul pourboire par ticket — le DTO le garantit. Le cumul est écrit
        // ainsi plutôt qu'une affectation pour que la règle reste vraie même si
        // cette borne bougeait un jour.
        tipAmountMinor += line.amountMinor;
        continue;
      }

      items.push(await this.priceLine(line, position, settings));
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
   * Résout une ligne de catalogue en prix unitaire — **le seul chemin par
   * lequel un montant d'article entre dans un ticket**.
   *
   * Trois refus, dans l'ordre où ils comptent : l'article n'existe pas ici
   * (404, indiscernable du voisin), il existe mais n'est plus vendable (422), il
   * est libellé dans une autre devise (422). Le premier protège la frontière du
   * tenant, les deux autres protègent la pièce comptable.
   */
  private async priceLine(
    line: Extract<SaleLineRequest, { kind: 'SERVICE' | 'PRODUCT' }>,
    position: number,
    settings: TenantSaleSettings,
  ): Promise<PricedCatalogItem> {
    const article =
      line.kind === 'SERVICE'
        ? // `byId` lève `NotFoundError` hors de l'établissement courant : la
          // frontière est tenue par `catalog`, et le POS n'a rien à comparer.
          await this.services.byId(line.serviceId)
        : await this.repository.findProductById(line.productId);

    if (article === null) {
      throw new NotFoundError('Article introuvable.');
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
      // Le libellé est **figé** ici : un renommage ultérieur de l'article ne
      // doit pas réécrire les tickets déjà émis.
      label: article.name,
      unitPrice: article.price,
      quantity: line.quantity,
    };
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
