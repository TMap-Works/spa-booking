import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
// Import **de valeur** et non `import type` : Nest lit le type du paramètre de
// constructeur dans les métadonnées émises par TypeScript, et un `import type`
// s'efface à la compilation — l'injection échouerait alors au démarrage.
import { PosRepository } from './pos.repository';
import { ProductSkuTakenError } from './payments.errors';
import type { Product, ProductDraft, ProductPatch, TenantSaleSettings } from './pos.types';

/**
 * Le rayon revendable de l'établissement — les « produits retail » du CDC §1.4
 * (#60).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le dépôt est **scopé** par le contexte de requête,
 * que `JwtAuthGuard` a renseigné depuis une revendication signée. Une lecture
 * visant l'article d'un autre établissement ne le trouve donc pas — elle rend
 * `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4).
 *
 * ## Aucune suppression
 *
 * Comme au catalogue des prestations : les tickets passés référencent l'article,
 * et `sale_items.product_id` est en `Restrict`. Un article qui a été vendu une
 * fois ne se supprime pas — il se désactive, et le reporting continue de savoir
 * ce qui a été vendu.
 */
@Injectable()
export class ProductsService {
  public constructor(private readonly repository: PosRepository) {}

  /**
   * Le rayon, trié par nom.
   *
   * `includeInactive` est `false` par défaut côté DTO : les articles retirés
   * n'ont rien à faire dans l'écran de caisse, qui est l'usage dominant.
   */
  public async list(options: { includeInactive: boolean }): Promise<Product[]> {
    return this.repository.listProducts(options);
  }

  /**
   * Crée un article.
   *
   * La devise n'est **pas** un paramètre libre : elle est celle de
   * l'établissement, relue en base. Un article libellé dans une autre devise que
   * le salon qui le vend serait invendable au comptoir — `SalesService` le
   * refuserait —, et l'accepter ici n'aurait fait que déplacer le refus au
   * moment où quelqu'un essaie de l'encaisser.
   *
   * @throws {ProductSkuTakenError} le code est déjà pris dans cet établissement.
   */
  public async create(input: { sku: string; name: string; priceAmountMinor: number }): Promise<Product> {
    const settings = await this.requireSettings();

    const draft: ProductDraft = {
      sku: input.sku,
      name: input.name,
      price: { amountMinor: input.priceAmountMinor, currency: settings.defaultCurrency },
    };

    const created = await this.repository.createProduct(draft);

    if (created === null) {
      throw new ProductSkuTakenError();
    }

    return created;
  }

  /**
   * Modifie un article : son nom, son prix, son activation.
   *
   * Pas son code : `sku` est la clé de `@@unique([tenantId, sku])` et la
   * référence que porte l'étiquette. Le changer reviendrait à renommer l'article
   * dans les inventaires du salon sans que rien ne le trace.
   *
   * Le prix conserve la devise de l'établissement, pour la même raison qu'à la
   * création.
   *
   * @throws {NotFoundError} article inconnu — ou appartenant à un autre
   * établissement, ce qui doit être indiscernable (tenant-isolation §4).
   */
  public async update(
    id: string,
    patch: { name?: string; priceAmountMinor?: number; isActive?: boolean },
  ): Promise<Product> {
    const changes: ProductPatch = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.priceAmountMinor === undefined
        ? {}
        : {
            price: {
              amountMinor: patch.priceAmountMinor,
              currency: (await this.requireSettings()).defaultCurrency,
            },
          }),
      ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
    };

    const updated = await this.repository.updateProduct(id, changes);

    if (updated === null) {
      throw new NotFoundError('Article introuvable.');
    }

    return updated;
  }

  /**
   * Le paramétrage de l'établissement courant.
   *
   * Absent, c'est que la portée de tenant désigne une ligne qui n'existe pas —
   * un état incohérent qui se signale plutôt que de se deviner. Le message ne
   * distingue rien : c'est le même 404 que partout ailleurs.
   */
  private async requireSettings(): Promise<TenantSaleSettings> {
    const settings = await this.repository.tenantSaleSettings();

    if (settings === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return settings;
  }
}
