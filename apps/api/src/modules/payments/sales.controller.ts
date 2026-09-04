import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { CreateSaleDto, SaleDto, toSaleDto, toSaleRequest } from './dto/sale.dto';
import { SalesService } from './sales.service';

/**
 * La caisse du comptoir — CDC §1.4, « POS de base » (#60).
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `POST /sales` | staff et au-dessus | compose un ticket et l'inscrit |
 * | `GET /sales/:id` | staff et au-dessus | relit un ticket, lignes comprises |
 *
 * ## Le seuil, et pourquoi il est à `STAFF`
 *
 * Composer un ticket **est** le geste de comptoir : c'est la personne qui
 * encaisse qui le fait, pas son responsable. C'est le même seuil que la
 * création d'une fiche cliente chez `crm`, et pour la même raison — le CDC
 * range ces gestes-là dans le front-desk.
 *
 * **Aucune route n'est ouverte au rôle `CLIENT`, ni au public.** Un ticket est
 * une pièce comptable du salon ; le parcours public paie une réservation par
 * `PublicPaymentsController`, il ne compose pas d'addition.
 *
 * ## L'historique des ventes n'est pas ici
 *
 * `GET /sales` — la liste filtrable — appartient à #62, avec le paiement en
 * espèces qu'elle sert à rapprocher. L'ouvrir ici aurait été une route sans le
 * filtrage que son ticket lui destine.
 *
 * ## Ce que la route ne reçoit pas
 *
 * Ni total, ni prix unitaire, ni `cashierUserId`, ni `tenantId`. Les deux
 * premiers sont recalculés côté serveur (troisième critère de #60) ; l'opérateur
 * vient de `@CurrentUser()`, donc d'un jeton vérifié ; l'établissement de la
 * revendication signée (tenant-isolation §2).
 *
 * ## Pourquoi `ParseUUIDPipe`
 *
 * Un identifiant mal formé est rejeté en 400 avant d'atteindre la base. Cela ne
 * révèle rien — la forme d'un UUID est publique — et évite qu'une chaîne
 * arbitraire descende jusqu'au pilote PostgreSQL, qui la refuserait par une
 * erreur de type remontée en 500.
 */
@ApiTags('payments')
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  public constructor(private readonly sales: SalesService) {}

  /**
   * Compose un ticket et l'inscrit.
   *
   * **201** : une ressource est créée. **404** si le rendez-vous, la prestation
   * ou l'article est inconnu — ou appartient à un autre établissement, ce qui
   * doit être indiscernable. **422** si un article existe mais n'est plus
   * vendable, s'il est libellé dans une autre devise, ou si le total dépasse ce
   * qu'un montant peut porter.
   *
   * Le corps de la réponse porte les quatre montants **calculés par le
   * serveur** : c'est la seule autorité sur ce que la cliente doit.
   */
  @Post()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Composer un ticket de caisse' })
  @ApiCreatedResponse({ type: SaleDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description:
      'Ni le rendez-vous, ni la prestation, ni l’article ne se trouve dans cet établissement.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Article retiré du catalogue, devise étrangère à l’établissement, ou total hors bornes.',
  })
  public async open(
    @Body() body: CreateSaleDto,
    @CurrentUser() cashier: AuthenticatedUser,
  ): Promise<SaleDto> {
    return toSaleDto(await this.sales.open(toSaleRequest(body), cashier.userId));
  }

  /**
   * Un ticket, par identifiant — lignes comprises, dans l'ordre du reçu.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'un ticket d'un
   * autre établissement, indistinctement (tenant-isolation §4).
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire un ticket de caisse' })
  @ApiOkResponse({ type: SaleDto })
  @ApiNotFoundResponse({ description: 'Aucun ticket de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<SaleDto> {
    return toSaleDto(await this.sales.byId(id));
  }
}
