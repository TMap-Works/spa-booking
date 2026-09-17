import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthWith } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { ReceiptPdfQueryDto, toReceiptPdfFormat } from './dto/receipt-pdf.dto';
import { SaleReceiptDto, toSaleReceiptDto } from './dto/receipt.dto';
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
import { contentDisposition } from './receipt-pdf/receipt-pdf.format';
import { ReceiptPdfService } from './receipt-pdf/receipt-pdf.service';
import { ReceiptService } from './receipt.service';
import { SalesService } from './sales.service';
import { SettlementService } from './settlement.service';

/**
 * Le nom de l'en-tête d'idempotence, écrit une fois — #834, quatrième critère.
 *
 * Même en-tête, mêmes bornes et même refus que la console de l'éditeur
 * (`identity/platform`), mais les constantes sont **redéclarées ici** : un
 * module n'atteint pas les internes d'un autre (api-module §3), et les
 * remonter dans le tronc commun serait un mouvement hors de l'empreinte de ce
 * ticket. La valeur des bornes est un détail de forme ; ce qui compte est
 * qu'elles soient écrites à côté de la route qu'elles gardent.
 */
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * La caisse du comptoir — CDC §1.4, « POS de base » (#60).
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `POST /sales` | staff et au-dessus | compose un ticket et l'inscrit |
 * | `GET /sales` | staff et au-dessus | l'historique, filtrable (#62) |
 * | `GET /sales/:id` | staff et au-dessus | relit un ticket, lignes comprises |
 * | `GET /sales/:id/receipt` | staff et au-dessus | le ticket de caisse, en JSON (#818) |
 * | `GET /sales/:id/receipt.pdf` | staff et au-dessus | la même pièce imprimable — rouleau 80 mm ou facture A4 (#819) |
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
/*
 * ## `checkout:collect` remplace le rang, depuis #812
 *
 * Toutes les routes de ce contrôleur exigent la même permission. Le rang `STAFF`
 * qui ouvrait la caisse est tombé pour une raison que le retour de test du PO du
 * 16/09 a rendue visible : l'écran d'encaissement liste la journée **de tout le
 * salon**, si bien qu'il rendait par une autre porte l'agenda complet que #812
 * ferme par ailleurs. Une praticienne y lisait les rendez-vous et les noms des
 * clientes de sa collègue.
 *
 * `checkout:collect` est portée par `manager` et `admin` (ADR 0013) : les routes
 * qui étaient déjà au seuil `MANAGER` — historique, remboursement, prix de vente
 * — ne changent donc pas de public, et seules celles qui étaient à `STAFF` se
 * referment. L'uniformité est délibérée : une caisse dont une moitié s'ouvre
 * plus bas que l'autre est une caisse qu'on contourne par sa moitié basse.
 */
@ApiTags('payments')
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  public constructor(
    private readonly sales: SalesService,
    private readonly settlements: SettlementService,
    private readonly receipts: ReceiptService,
    private readonly receiptPdfs: ReceiptPdfService,
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
  @AuthWith('checkout:collect')
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
  @AuthWith('checkout:collect')
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
  @AuthWith('checkout:collect')
  @ApiOperation({ summary: 'Lire un ticket de caisse' })
  @ApiOkResponse({ type: SaleDto })
  @ApiNotFoundResponse({ description: 'Aucun ticket de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<SaleDto> {
    return toSaleDto(await this.sales.byId(id));
  }

  /**
   * Le **ticket de caisse** d'une vente — #818, cinquième et sixième critères.
   *
   * C'est la pièce comptable, et non l'addition : elle porte l'identité légale
   * du salon et ses coordonnées, le numéro de pièce, la date et l'heure en UTC
   * avec le fuseau du salon, le caissier, la cliente et le praticien, les lignes
   * avec leur prix unitaire TTC, la ventilation de la taxe par taux, les
   * règlements avec la monnaie rendue, le pourboire, et les avoirs émis.
   *
   * ## Pourquoi une route à part de `GET /sales/:id`
   *
   * Parce que ce sont deux lectures différentes. L'addition sert l'écran de
   * caisse — elle est appelée à chaque frappe. La pièce sert l'impression et la
   * réclamation, et charge pour cela l'établissement, trois personnes et les
   * remboursements. Les fondre aurait fait payer ces lectures à chaque
   * consultation d'un ticket, pour un écran qui n'en affiche rien.
   *
   * ## Le numéro est nul tant que la vente n'est pas close
   *
   * Le rang est attribué **à la clôture** (`receipt.numbering.ts`) : un ticket
   * encore ouvert n'en a pas, et ce que la route rend est alors un proforma.
   * En attribuer un ici en percerait la suite à chaque consultation.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'un ticket d'un
   * autre établissement, indistinctement (tenant-isolation §4).
   */
  @Get(':id/receipt')
  @AuthWith('checkout:collect')
  @ApiOperation({ summary: 'Éditer le ticket de caisse d’une vente' })
  @ApiOkResponse({ type: SaleReceiptDto })
  @ApiNotFoundResponse({
    description: 'Aucun ticket de cet établissement ne porte cet identifiant.',
  })
  public async receipt(@Param('id', ParseUUIDPipe) id: string): Promise<SaleReceiptDto> {
    return toSaleReceiptDto(await this.receipts.bySaleId(id));
  }

  /**
   * Le ticket de caisse **en PDF** — #819, premier critère.
   *
   * Deux documents sous une seule route, que `?format=` départage : le rouleau
   * thermique **80 mm** du comptoir (défaut) et la **facture A4** qu'on envoie.
   * Le contenu est celui de `GET /sales/:id/receipt` — mêmes montants, même
   * numéro de pièce, même fuseau —, mis en page.
   *
   * ## Le même seuil que le reçu JSON, et pourquoi
   *
   * `STAFF`, comme tout le reste de la caisse : imprimer le ticket **est** le
   * geste de comptoir qui suit l'encaissement, et c'est la personne qui encaisse
   * qui le fait. Un seuil plus haut aurait obligé à appeler un responsable pour
   * réimprimer un ticket perdu ; un seuil plus bas n'existe pas ici — aucune
   * route de `sales` n'est ouverte au rôle `CLIENT` ni au public.
   *
   * ## Ce que le document ne porte pas
   *
   * Aucune donnée de carte — ni PAN, ni quatre derniers chiffres, ni marque
   * (septième critère, payments-stripe §1). Il n'y a rien à filtrer : ces
   * colonnes n'existent pas, et un règlement au terminal s'imprime « Carte
   * bancaire (TPE) ». Les métadonnées du PDF ne portent pas davantage de nom de
   * personne : un visualiseur les affiche, et elles survivent au document.
   *
   * **404** pour un identifiant inconnu comme pour celui d'un ticket d'un autre
   * établissement, indistinctement (tenant-isolation §4) — le refus vient de la
   * lecture, avant qu'aucun octet ne soit produit. **400** sur un `format`
   * inconnu.
   */
  @Get(':id/receipt.pdf')
  @AuthWith('checkout:collect')
  @ApiOperation({ summary: 'Éditer le ticket de caisse d’une vente en PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description:
      'Le PDF. `Content-Disposition` porte le numéro de pièce — « proforma » tant que la vente est ouverte.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiBadRequestResponse({ description: 'Format inconnu — seuls `ticket-80` et `a4` sont servis.' })
  @ApiNotFoundResponse({
    description: 'Aucun ticket de cet établissement ne porte cet identifiant.',
  })
  public async receiptPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReceiptPdfQueryDto,
  ): Promise<StreamableFile> {
    const pdf = await this.receiptPdfs.bySaleId(id, toReceiptPdfFormat(query));

    return new StreamableFile(pdf.bytes, {
      type: 'application/pdf',
      disposition: contentDisposition(pdf.fileName),
      length: pdf.bytes.byteLength,
    });
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
   *
   * ## La carte se règle au **TPE du salon** — #834, ADR 0014
   *
   * `mean` vaut `CASH` ou `CARD_TERMINAL`, et rien d'autre : le comptoir ne sait
   * plus produire d'intention Stripe. `CARD_TERMINAL` signifie « la carte est
   * passée sur le terminal de la banque du salon » — l'API n'appelle aucun
   * prestataire, ne reçoit ni ne stocke de donnée de carte, et enregistre
   * l'issue que le caissier déclare, avec l'opérateur et l'horodatage.
   * `terminalReference` est le numéro du ticket du terminal, facultatif ; une
   * valeur qui ressemble à un numéro de carte sort en **400**.
   *
   * ## L'en-tête `Idempotency-Key` est **obligatoire** — quatrième critère
   *
   * Cette route n'est pas rejouable par construction, et ne peut pas l'être :
   * deux règlements de 25,00 € sur le même ticket sont deux gestes distincts,
   * et rien du côté serveur ne distingue la double soumission du double geste.
   * C'est l'appelant qui le sait, et la clé est la façon dont il le dit —
   * rejouée, elle rend le règlement déjà inscrit **sans rien écrire**, et
   * `replayed` vaut alors `true`.
   *
   * Une clé absente ou hors bornes est un **400**, du même
   * `{ code: "VALIDATION_ERROR", details.violations }` qu'un champ de corps
   * invalide : un appelant n'a pas à traiter deux formes de 400 selon que la
   * faute est dans le corps ou dans un en-tête.
   */
  @Post(':saleId/payments')
  @HttpCode(HttpStatus.CREATED)
  @AuthWith('checkout:collect')
  @ApiOperation({ summary: 'Régler un ticket, en totalité ou en partie' })
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Clé choisie par l’appelant. Rejouée sur le même ticket, elle rend le ' +
      'règlement déjà inscrit au lieu d’en inscrire un second.',
  })
  @ApiCreatedResponse({ type: SaleSettlementDto })
  @ApiBadRequestResponse({
    description:
      'Corps ou en-tête invalide — le champ fautif est nommé. Une ' +
      '`terminalReference` qui ressemble à un numéro de carte tombe ici.',
  })
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
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() operator: AuthenticatedUser,
  ): Promise<SaleSettlementDto> {
    return toSaleSettlementDto(
      await this.settlements.settleSale(
        saleId,
        operator.userId,
        toSettlementRequest(body),
        readIdempotencyKey(idempotencyKey),
      ),
    );
  }
}

/**
 * Lit l'en-tête d'idempotence, ou refuse la requête — #834, quatrième critère.
 *
 * **Obligatoire**, et ce n'est pas un excès de zèle : le règlement d'un ticket
 * inscrit une pièce comptable à chaque appel, et une clé facultative aurait
 * rendu la garantie du critère conditionnelle au soin de l'appelant — c'est-à-
 * dire inexistante le jour où un réseau coupe entre la requête et sa réponse.
 *
 * Le refus prend la forme d'un rapport de validation — `message` en tableau —
 * pour que `DomainExceptionFilter` le rende sous le même
 * `{ code: "VALIDATION_ERROR", details.violations }` que n'importe quel champ de
 * corps invalide.
 */
function readIdempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();

  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new BadRequestException({
      message: [
        `${IDEMPOTENCY_HEADER} : en-tête obligatoire, de ` +
          `${String(IDEMPOTENCY_KEY_MIN_LENGTH)} à ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} caractères`,
      ],
    });
  }

  return key;
}
