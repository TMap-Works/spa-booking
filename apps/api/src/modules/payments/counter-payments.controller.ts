import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { CashPaymentsService } from './cash-payments.service';
import {
  CreateCashPaymentDto,
  ListPaymentsQueryDto,
  PaymentTransactionDto,
  PaymentTransactionPageDto,
  toPaymentHistoryFilter,
  toPaymentTransactionDto,
} from './dto/cash-payment.dto';
import { PaymentsHistoryService } from './payments-history.service';

/**
 * L'encaissement au comptoir et son historique — CDC §1.4 et §4.9 (#62).
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `POST /payments/cash` | staff et au-dessus | règle un rendez-vous en espèces |
 * | `GET /payments` | manager et au-dessus | l'historique des transactions, pour le rapprochement |
 *
 * ## Deux seuils, et pourquoi la ligne passe là
 *
 * `STAFF` encaisse : prendre un billet **est** le geste de comptoir, celui de la
 * personne qui tient la caisse. C'est le même seuil que la composition d'un
 * ticket (#60) et que la création d'une fiche cliente, et pour la même raison —
 * le CDC range ces gestes-là dans le front-desk.
 *
 * `MANAGER` lit l'historique. Le rapprochement avec les relevés Stripe est un
 * geste de gestion, pas de comptoir : il donne à voir le chiffre d'affaires de
 * l'établissement, ses remboursements et ses références de prestataire — c'est
 * le même partage que chez `products`, où le rayon se lit au comptoir mais où
 * les prix se fixent au-dessus.
 *
 * **Aucune route n'est ouverte au rôle `CLIENT`, ni au public.** Le parcours
 * public paie sa réservation par `PublicPaymentsController` ; il ne consulte pas
 * la caisse du salon.
 *
 * ## Ce que la route d'encaissement ne reçoit pas
 *
 * Ni montant, ni devise, ni `cashierUserId`, ni `tenantId`. Le montant est le
 * prix figé à la réservation, relu en base (payments-stripe §4) ; l'opérateur
 * vient de `@CurrentUser()`, donc d'un jeton vérifié ; l'établissement de la
 * revendication signée (tenant-isolation §2).
 *
 * ## Pourquoi elle cohabite avec le webhook sur le même préfixe
 *
 * `StripeWebhookController` sert `POST /payments/webhooks/stripe`, non gardé
 * parce que Stripe s'authentifie par sa signature. Les deux chemins ne se
 * recouvrent pas, et le partage du préfixe dit ce qu'il faut : tout ce qui
 * touche à l'encaissement se lit sous `payments`, quelle que soit la porte par
 * laquelle il entre.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class CounterPaymentsController {
  public constructor(
    private readonly cash: CashPaymentsService,
    private readonly history: PaymentsHistoryService,
  ) {}

  /**
   * Règle un rendez-vous en espèces.
   *
   * **200 et non 201**, et c'est délibéré : la route est **rejouable**. Un
   * deuxième clic ne crée pas une seconde ressource, il rend le même
   * encaissement que le premier — annoncer `201` à chaque fois aurait laissé
   * croire à deux recettes là où la base n'en porte qu'une.
   *
   * **404** si le rendez-vous est inconnu — ou appartient à un autre
   * établissement, ce qui doit être indiscernable. **422** s'il est annulé.
   * **409** si un *autre* encaissement existe déjà : une intention carte en
   * cours, aboutie ou remboursée. Le comptoir tranche alors, plutôt que d'écraser
   * une pièce comptable.
   *
   * **Aucun appel Stripe n'a lieu sur ce chemin** — le service qui le sert n'a
   * pas la passerelle parmi ses dépendances (quatrième critère de #62).
   */
  @Post('cash')
  @HttpCode(HttpStatus.OK)
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Encaisser un rendez-vous en espèces' })
  @ApiOkResponse({ type: PaymentTransactionDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description: 'Aucun rendez-vous de cet établissement ne porte cet identifiant.',
  })
  @ApiUnprocessableEntityResponse({ description: 'Rendez-vous annulé — plus rien à encaisser.' })
  @ApiConflictResponse({
    description: 'Un autre encaissement existe déjà pour ce rendez-vous.',
  })
  public async settleInCash(
    @Body() body: CreateCashPaymentDto,
    @CurrentUser() operator: AuthenticatedUser,
  ): Promise<PaymentTransactionDto> {
    return toPaymentTransactionDto(await this.cash.settle(body.appointmentId, operator.userId));
  }

  /**
   * L'historique des transactions de l'établissement, la plus récente d'abord.
   *
   * C'est la surface du rapprochement (CDC §4.9) : chaque ligne porte son moyen,
   * son statut, ses montants, son instant de capture et — quand il y en a une —
   * ses références Stripe. `?method=CARD` isole ce qui doit se retrouver sur un
   * relevé ; `?method=CASH` ce dont la caisse fait foi.
   *
   * **422** si la fenêtre est à l'envers (`from` postérieur ou égal à `to`) : la
   * borne haute étant exclue, elle ne contiendrait aucun instant, et rendre une
   * page vide ferait conclure à une journée sans recette.
   */
  @Get()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Lister les transactions, pour le rapprochement' })
  @ApiOkResponse({ type: PaymentTransactionPageDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre vide — `to` doit suivre `from`.' })
  public async list(
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentTransactionPageDto> {
    const page = await this.history.list(toPaymentHistoryFilter(query));

    return {
      items: page.items.map((transaction) => toPaymentTransactionDto(transaction)),
      page: page.page,
      pageSize: page.pageSize,
      totalItems: page.totalItems,
      totalPages: page.totalPages,
    };
  }
}
