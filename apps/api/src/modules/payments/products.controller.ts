import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductDto,
  UpdateProductDto,
  toProductDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

/**
 * Le rayon retail du comptoir — CDC §1.4, « POS de base : services et produits
 * retail » (#60).
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /products` | staff et au-dessus | le rayon, pour l'écran de caisse |
 * | `POST /products` | manager et au-dessus | l'entrée d'un article au catalogue |
 * | `PATCH /products/:id` | manager et au-dessus | prix, nom, retrait du rayon |
 *
 * ## Deux seuils, et pourquoi la ligne passe là
 *
 * `STAFF` lit le rayon : c'est le geste de caisse, celui de la personne qui
 * encaisse. Placer ce seuil plus haut aurait rendu le POS inutilisable par ceux
 * qui s'en servent.
 *
 * `MANAGER` décide de ce qui s'y trouve et à quel prix. Fixer un prix de vente
 * n'est pas un geste de comptoir, et c'est le même partage que chez `catalog`,
 * où les prestations se créent au rang `MANAGER` et se lisent en dessous.
 *
 * **Aucune route n'est ouverte au rôle `CLIENT`, ni au public.** Le rayon d'un
 * salon, ses prix d'achat implicites et ses références sont des données
 * commerciales : la vitrine publique vend des prestations, pas l'inventaire.
 *
 * ## Ni `DELETE`, ni `:tenantId`
 *
 * Pas de `DELETE` : `sale_items.product_id` référence l'article en `Restrict`,
 * si bien qu'un article vendu une fois ne se supprime pas — et le reporting doit
 * continuer à le compter. Un verbe qui n'efface rien mentirait.
 *
 * Pas de `:tenantId` : l'établissement vient du jeton vérifié, jamais du chemin
 * (tenant-isolation §2). Il n'y a ici rien à comparer, le client Prisma est déjà
 * borné.
 */
@ApiTags('payments')
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  public constructor(private readonly products: ProductsService) {}

  /** Le rayon de l'établissement, trié par nom. */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les articles revendables' })
  @ApiOkResponse({ type: [ProductDto] })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  public async list(@Query() query: ListProductsQueryDto): Promise<ProductDto[]> {
    const products = await this.products.list({ includeInactive: query.includeInactive ?? false });

    return products.map((product) => toProductDto(product));
  }

  /**
   * Entre un article au rayon.
   *
   * **201** : une ressource est créée. **409** si le code est déjà pris dans cet
   * établissement — l'unicité est par tenant, deux salons gardent le droit de
   * coder chacun leur `SH-01`.
   *
   * La devise n'est pas dans le corps : c'est celle de l'établissement, relue en
   * base. Un article libellé ailleurs serait invendable au comptoir.
   */
  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Créer un article revendable' })
  @ApiCreatedResponse({ type: ProductDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiConflictResponse({ description: 'Ce code article est déjà utilisé dans cet établissement.' })
  public async create(@Body() body: CreateProductDto): Promise<ProductDto> {
    return toProductDto(
      await this.products.create({
        sku: body.sku,
        name: body.name,
        priceAmountMinor: body.priceAmountMinor,
      }),
    );
  }

  /**
   * Modifie un article : son nom, son prix, sa présence au rayon.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'un article
   * d'un autre établissement, indistinctement : distinguer le second
   * confirmerait son existence (tenant-isolation §4).
   */
  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Modifier un article revendable' })
  @ApiOkResponse({ type: ProductDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucun article de cet établissement ne porte cet identifiant.' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductDto,
  ): Promise<ProductDto> {
    return toProductDto(
      await this.products.update(id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.priceAmountMinor === undefined
          ? {}
          : { priceAmountMinor: body.priceAmountMinor }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      }),
    );
  }
}
