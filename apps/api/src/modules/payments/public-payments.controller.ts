import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CreatePaymentIntentDto, PaymentIntentDto } from './dto/create-payment-intent.dto';
import { PaymentsService } from './payments.service';

/**
 * Le paiement du tunnel public — l'étape « encaisser » de la boucle de valeur
 * du MVP (#57).
 *
 * ## Le `:tenantSlug` du chemin n'est pas un paramètre de ce contrôleur
 *
 * Il est déclaré parce qu'il est dans l'URL, et il n'est lu nulle part ici.
 * `TenantScopeMiddleware` l'a déjà résolu contre la table `tenants` et a posé
 * l'identifiant obtenu dans le contexte de requête ; c'est de là que le service
 * et le repository tirent l'établissement. Un `@Param('tenantSlug')` lu dans une
 * méthode ci-dessous serait un retour à « le client choisit son tenant »
 * (tenant-isolation §2). Même conduite que `PublicAppointmentsController`.
 *
 * La conséquence utile : si le slug est inconnu, désactivé ou mal formé,
 * **aucune méthode de ce fichier ne s'exécute**.
 *
 * ## Pas de garde d'authentification, et c'est le propos
 *
 * On réserve sans compte (#37), donc on paie sans compte. Ce qui autorise
 * l'appel est la **connaissance de l'identifiant** du rendez-vous — un UUID v4
 * remis à la cliente sur son écran de confirmation et dans son e-mail. C'est
 * exactement le régime du report et de l'annulation du même tunnel.
 *
 * Ce que cette route n'apprend donc à personne : un identifiant inconnu et
 * celui d'un autre salon rendent le **même** 404. Et ce qu'elle ne permet pas :
 * choisir un montant, une devise, un établissement ou un moyen de paiement —
 * le corps ne porte qu'un identifiant, et `forbidNonWhitelisted` rejette tout
 * le reste.
 *
 * `ThrottlerGuard` complète, pour la raison qui le pose sur la réservation :
 * cette route **écrit** — une ligne `payments` — et appelle un prestataire
 * externe à chaque passage. Sans quota, un script transformerait notre API en
 * amplificateur d'appels vers Stripe.
 *
 * ## Ce que cette route ne fait pas
 *
 * Elle ne **confirme** rien. Elle rend de quoi payer ; c'est le webhook signé
 * de #58 qui fera passer le rendez-vous en `CONFIRMED` et le paiement en
 * `SUCCEEDED`. Ne jamais confirmer une réservation sur la seule réponse du
 * navigateur (payments-stripe §2) : la cliente peut fermer l'onglet, perdre le
 * réseau, ou falsifier l'appel.
 *
 * Elle n'encaisse pas non plus au comptoir : le POS — espèces, produits retail,
 * lignes de vente — est #60 et #62, sur une surface gardée.
 */
@ApiTags('public')
@Controller({ path: 'public/:tenantSlug/payments', version: '1' })
@UseGuards(ThrottlerGuard)
@ApiParam({
  name: 'tenantSlug',
  description:
    'Slug public de l’établissement. Résolu contre la table `tenants` par le middleware, ' +
    'avant le contrôleur — un slug inconnu répond 404 sans qu’aucun code métier ne tourne.',
  example: 'salon-des-lilas',
})
export class PublicPaymentsController {
  public constructor(private readonly payments: PaymentsService) {}

  /**
   * Ouvre — ou reprend — le paiement d'un rendez-vous.
   *
   * **201**, et le corps porte le `client_secret` et la clé publiable : de quoi
   * monter Stripe Elements et confirmer le paiement directement auprès de
   * Stripe, sans qu'aucun champ carte de notre fabrication n'existe (#59).
   *
   * **Idempotente.** Appelée deux fois pour le même rendez-vous, elle rend deux
   * fois la même intention — un double clic ou un onglet rouvert ne produit
   * jamais deux débits. C'est la contrainte d'unicité en base et la clé
   * d'idempotence Stripe qui le tiennent, pas une vérification applicative.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement :
   * les deux doivent être indiscernables, faute de quoi cette route devient une
   * sonde d'existence (tenant-isolation §4).
   *
   * **422 `APPOINTMENT_NOT_PAYABLE`** quand le rendez-vous est annulé, terminé
   * ou marqué no-show : il n'y a plus de prestation à vendre en ligne.
   *
   * **409 `PAYMENT_ALREADY_SETTLED`** quand l'encaissement est déjà abouti,
   * remboursé, ou a été réglé en espèces au comptoir. Le front réaffiche le
   * dossier plutôt que de redemander une carte.
   *
   * **503 `PAYMENT_PROVIDER_UNAVAILABLE`** quand Stripe refuse ou ne répond
   * pas. 503 et non 500 : la conduite du front est de retenter, et le corps ne
   * porte **aucun** détail du prestataire.
   *
   * **429** au-delà de dix ouvertures de paiement par minute et par adresse —
   * même ordre de grandeur que la réservation, et pour la même raison.
   */
  @Post('intents')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ouvrir le paiement en ligne d’un rendez-vous' })
  @ApiCreatedResponse({ type: PaymentIntentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Établissement ou rendez-vous introuvable.' })
  @ApiConflictResponse({
    description: 'Ce rendez-vous a déjà été encaissé (`PAYMENT_ALREADY_SETTLED`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Rendez-vous annulé, terminé ou no-show — plus rien à encaisser en ligne ' +
      '(`APPOINTMENT_NOT_PAYABLE`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota d’ouvertures de paiement dépassé.' })
  @ApiServiceUnavailableResponse({
    description: 'Le prestataire de paiement est indisponible (`PAYMENT_PROVIDER_UNAVAILABLE`).',
  })
  public async createIntent(@Body() body: CreatePaymentIntentDto): Promise<PaymentIntentDto> {
    return this.payments.createIntentForAppointment(body.appointmentId);
  }
}
