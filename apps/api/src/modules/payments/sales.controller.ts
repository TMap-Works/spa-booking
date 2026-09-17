import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import {
  CreateSaleDto,
  ListSalesQueryDto,
  SaleDto,
  SalePageDto,
  toSaleDto,
  toSaleHistoryFilter,
  toSaleRequest,
  toSaleSummaryDto,
} from './dto/sale.dto';
import {
  SaleSettlementDto,
  SettleSaleDto,
  toSaleSettlementDto,
  toSettlementRequest,
} from './dto/settlement.dto';
import { SalesService } from './sales.service';
import { SettlementService } from './settlement.service';

/**
 * La caisse du comptoir — CDC §1.4, « POS de base » (#60).
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `POST /sales` | staff et au-dessus | compose un ticket et l'inscrit |
 * | `GET /sales` | staff et au-dessus | l'historique, filtrable (#62) |
 * | `GET /sales/:id` | staff et au-dessus | relit un ticket, lignes comprises |
 * | `POST /sales/:saleId/payments` | staff et au-dessus | règle le ticket, en une fois ou en plusieurs (#817) |
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
 * ## L'historique, ouvert par #62
 *
 * `GET /sales` était laissé à ce ticket-là par #60 — « l'ouvrir ici aurait été
 * une route sans le filtrage que son ticket lui destine ». Il l'a. Il rend les
 * en-têtes de tickets, **sans leurs lignes** : le détail se demande par
 * `GET /sales/:id`, et une page de cinquante tickets de dix lignes en aurait
 * fait transiter cinq cents qu'aucun tableau n'affiche.
 *
 * Il reste au seuil `STAFF`, comme le reste de la caisse : la relève de fin de
 * journée est un geste de comptoir. L'historique des **transactions** — celui
 * qui porte les références Stripe et sert le rapprochement — est chez
 * `CounterPaymentsController`, au seuil `MANAGER` : ce sont deux lectures
 * distinctes, l'une sur ce qui a été vendu, l'autre sur ce qui a été encaissé.
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
  public constructor(
    private readonly sales: SalesService,
    private readonly settlements: SettlementService,
  ) {}

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
   * L'historique des ventes, du plus récent au plus ancien (#62).
   *
   * Chaque élément porte les trois faits que le premier critère de #62 demande
   * d'une vente : l'**opérateur** qui l'a composée, son **horodatage** et ses
   * **montants**. Les lignes, elles, ne sont pas rendues ici.
   *
   * **422** si la fenêtre est à l'envers (`from` postérieur ou égal à `to`) : la
   * borne haute étant exclue, elle ne contiendrait aucun instant, et rendre une
   * page vide ferait conclure à une journée sans vente.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les tickets de caisse' })
  @ApiOkResponse({ type: SalePageDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre vide — `to` doit suivre `from`.' })
  public async history(@Query() query: ListSalesQueryDto): Promise<SalePageDto> {
    const page = await this.sales.history(toSaleHistoryFilter(query));

    return {
      items: page.items.map((sale) => toSaleSummaryDto(sale)),
      page: page.page,
      pageSize: page.pageSize,
      totalItems: page.totalItems,
      totalPages: page.totalPages,
    };
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

  /**
   * Règle un ticket — en une fois, ou en plusieurs (#817, quatrième critère).
   *
   * C'est la porte du **règlement mixte** : un ticket de 78,00 € se règle en
   * 50,00 € d'espèces puis 28,00 € au terminal, et il est soldé quand la somme
   * de ses encaissements égale son total. Une vente sans rendez-vous se règle
   * exactement de la même façon qu'une vente adossée à un soin — c'est la même
   * route, et c'est le point.
   *
   * **201** : chaque appel inscrit un encaissement de plus, qui est une pièce
   * comptable. La route n'est **pas** rejouable, et ne peut pas l'être : deux
   * règlements de 25,00 € sur le même ticket sont deux gestes distincts, et les
   * confondre effacerait l'un des deux du rapprochement. Ce qui protège du
   * double clic est ailleurs — le reste dû décroît au premier appel, et le
   * second se heurte au ticket soldé.
   *
   * **404** si le ticket est inconnu, ou appartient à un autre établissement —
   * indistinctement (tenant-isolation §4). **409** `SALE_ALREADY_SETTLED` s'il
   * est déjà soldé. **422** `SALE_OVERPAYMENT` si le montant demandé dépasse le
   * reste dû, avec ce reste dans `details`.
   *
   * **Le montant réglé est toujours celui que le serveur a composé**, relu sous
   * verrou : le corps ne porte aucun total, seulement la part qu'on règle
   * maintenant (cinquième critère).
   */
  @Post(':saleId/payments')
  @HttpCode(HttpStatus.CREATED)
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Régler un ticket, en totalité ou en partie' })
  @ApiCreatedResponse({ type: SaleSettlementDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucun ticket de cet établissement ne porte cet identifiant.' })
  @ApiConflictResponse({
    description: 'Ticket déjà soldé, ou intention carte encore en vol.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Le règlement dépasse le reste dû — il est dans `details`.',
  })
  public async settle(
    @Param('saleId', new ParseUUIDPipe({ version: '4' })) saleId: string,
    @Body() body: SettleSaleDto,
    @CurrentUser() operator: AuthenticatedUser,
  ): Promise<SaleSettlementDto> {
    return toSaleSettlementDto(
      await this.settlements.settleSale(saleId, operator.userId, toSettlementRequest(body)),
    );
  }
}
