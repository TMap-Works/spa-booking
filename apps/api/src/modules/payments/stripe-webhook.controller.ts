import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { WebhookAckDto } from './dto/webhook-ack.dto';
import { InvalidWebhookSignatureError } from './stripe-webhook.errors';
import { WEBHOOK_QUEUE, type WebhookQueue } from './stripe-webhook.queue';
import { STRIPE_WEBHOOK_ROUTE } from './stripe-webhook.raw-body';
import { readWebhookEvent } from './stripe-webhook.types';
import { StripeWebhookConfig } from './stripe/stripe-webhook.config';
import { verifyStripeSignature } from './stripe/stripe-signature';

/**
 * Le point d'entrée des webhooks Stripe — `POST /api/v1/payments/webhooks/stripe`.
 *
 * ## La seule route non gardée de l'API à écrire en base
 *
 * Elle n'a ni jeton, ni slug d'établissement, ni session : Stripe n'en présente
 * aucun. Ce qui l'authentifie est **la signature du corps**, et rien d'autre.
 * D'où l'ordre, qui n'est pas négociable :
 *
 * 1. le secret est-il configuré ? sinon 503 — Stripe rejouera ;
 * 2. la signature est-elle valide ? sinon **400 immédiat, aucun traitement**
 *    (payments-stripe §3) ;
 * 3. seulement là, le corps est désérialisé ;
 * 4. l'événement part en file, et la réponse 200 est écrite sans l'attendre.
 *
 * Rien entre l'étape 1 et l'étape 2 ne touche le contenu du corps : il n'est ni
 * désérialisé, ni journalisé, ni mesuré autrement que par sa taille. Un corps
 * non authentifié ne mérite aucun de ces traitements.
 *
 * ## Pourquoi le contrôleur ne traite pas lui-même
 *
 * « Répondre 200 rapidement » (payments-stripe §3) : un webhook qui dépasse le
 * délai de Stripe est rejoué, et le rejeu arrive pendant que le premier
 * traitement n'est pas fini. Le traitement est donc remis à `WEBHOOK_QUEUE`, et
 * son échec éventuel n'a aucune influence sur le statut rendu — c'est
 * l'idempotence de `processed_webhook_events` qui rend le rejeu inoffensif, pas
 * la finesse de notre code de retour.
 *
 * ## Ce que la réponse ne dit jamais
 *
 * Ni pourquoi une signature a été refusée, ni si l'événement était connu, ni ce
 * qu'il a changé. Le seul appelant légitime n'en a pas l'usage ; le seul autre
 * appelant possible est en train de sonder.
 */
@ApiTags('payments')
@Controller(STRIPE_WEBHOOK_ROUTE)
export class StripeWebhookController {
  public constructor(
    private readonly config: StripeWebhookConfig,
    @Inject(WEBHOOK_QUEUE) private readonly queue: WebhookQueue,
    private readonly logger: StructuredLogger,
  ) {}

  @Post()
  // 200 et non 201 : rien n'est créé du point de vue de l'appelant, et Stripe
  // ne considère comme succès que le 2xx — autant rendre celui qui décrit la
  // vérité, « reçu ».
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Réception des événements Stripe',
    description:
      'Point de terminaison appelé par Stripe. La signature du corps brut fait foi ; ' +
      'aucune donnée de carte n’y transite. Le traitement est asynchrone et idempotent.',
  })
  @ApiHeader({
    name: 'stripe-signature',
    required: true,
    description: 'Signature de la livraison, au format `t=…,v1=…`.',
  })
  @ApiOkResponse({ type: WebhookAckDto, description: 'Livraison reçue et signature vérifiée.' })
  public receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): WebhookAckDto {
    const secret = this.config.requireSecret();
    const payload = this.requireRawBody(request);

    const verdict = verifyStripeSignature({ payload, header: signature, secret, now: Date.now() });
    if (!verdict.ok) {
      // `warn` et non `error` : cette route est publique et sera sondée en
      // continu. Journaliser chaque sonde comme un incident noierait les vrais
      // sous le bruit — c'est la doctrine que `DomainExceptionFilter` applique
      // déjà à tous les 4xx. Le motif reste ici, il ne part pas au client.
      this.logger.warn(
        'stripe webhook: signature refusée',
        { reason: verdict.reason, bytes: payload.length },
        StripeWebhookController.name,
      );
      throw new InvalidWebhookSignatureError();
    }

    // Le corps est authentifié : il peut maintenant être lu.
    const read = readWebhookEvent(payload);

    switch (read.status) {
      case 'handled':
        this.queue.enqueue(read.event);
        break;

      case 'ignored':
        // Hors périmètre MVP, ou champs utiles absents. Acquitté sans
        // traitement : répondre autre chose ferait rejouer indéfiniment un
        // événement dont le rejeu ne changerait rien.
        this.logger.debug(
          'stripe webhook: événement hors périmètre, acquitté sans traitement',
          { eventId: read.eventId, eventType: read.eventType },
          StripeWebhookController.name,
        );
        break;

      case 'unreadable':
        // Signé par Stripe, et pourtant illisible. Le rejeu ne le rendrait pas
        // lisible : on acquitte pour ne pas boucler, et on journalise en
        // `error` parce que c'est un vrai désaccord de contrat, pas une sonde.
        this.logger.error(
          'stripe webhook: corps signé mais illisible',
          { bytes: payload.length },
          StripeWebhookController.name,
        );
        break;
    }

    return new WebhookAckDto(true);
  }

  /**
   * Le corps brut, ou un échec bruyant.
   *
   * `rawBody` est posé par `stripeWebhookRawBody()`, monté dans `configureApp`.
   * Son absence ne peut vouloir dire qu'une chose : le middleware n'est plus
   * monté, ou plus sur ce chemin — et alors **toute** vérification de signature
   * échouerait, silencieusement, en 400. Un 500 avec ce message-là nomme la
   * cause au lieu de la déguiser en corps falsifié.
   */
  private requireRawBody(request: RawBodyRequest<Request>): Buffer {
    if (request.rawBody === undefined) {
      throw new Error(
        'Le lecteur de corps brut n’est pas monté sur la route de webhook : ' +
          '`stripeWebhookRawBody()` doit être appliqué par `configureApp` avant que Nest ' +
          'n’enregistre le parseur JSON global, faute de quoi aucune signature ne peut être vérifiée.',
      );
    }
    return request.rawBody;
  }
}
