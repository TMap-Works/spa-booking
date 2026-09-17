import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  DispatchNotificationDto,
  DispatchResultDto,
  toNotificationMessage,
} from './dto/dispatch-notification.dto';
import { InternalCallerGuard } from './internal-caller.guard';
import { NotificationDispatchService } from './notification-dispatch.service';
import { INTERNAL_TOKEN_HEADER } from './notifications.config';

/**
 * La route d'envoi **interne** — `POST /api/v1/interne/notifications/dispatch`
 * (#799).
 *
 * ```
 * spa-{env}-notifications (SQS)
 *          │
 *          ▼
 * spa-{env}-notification-dispatcher (Lambda)
 *          │  POST { messageId, message }
 *          ▼
 *      cette route  ──►  portée de tenant  ──►  PENDING → SES/SNS → SENT
 * ```
 *
 * ## Pourquoi elle existe, et pourquoi la Lambda n'appelle pas SES elle-même
 *
 * Parce que l'ordre d'écriture `PENDING → fournisseur → SENT` et l'index
 * d'idempotence qui le porte appartiennent à ce module, posés et testés par #68.
 * « Les réécrire en JavaScript dans la fonction donnerait deux implémentations
 * de la même règle, dans deux exécutables, avec un seul jeu de tests —
 * c'est-à-dire une divergence garantie, sur la règle la plus coûteuse à casser
 * de toute la chaîne » (`infra/terraform/modules/notifications/README.md`). La
 * Lambda est le transport ; cette route est le traitement.
 *
 * C'est la même division du travail que pour les deux autres routes internes du
 * module — le balayage du rappel J-1 (#71) et l'ingestion des rebonds SES (#73)
 * — et c'est pourquoi elles partagent la garde et le jeton.
 *
 * ## Un contrôleur à part, et pas une route de plus sur `NotificationsController`
 *
 * Le chemin l'impose : `interne/notifications` n'est pas `notifications`, et
 * c'est le contrat que `dispatch_url` désigne depuis #67 — la valeur est déjà
 * écrite dans la composition Terraform de chaque environnement. Le segment
 * `interne` n'est pas cosmétique non plus : il **sépare à la racine** ce qu'une
 * personne authentifiée peut appeler de ce que seule l'infrastructure appelle,
 * ce qu'un règlement de périmètre (WAF, ALB, groupe de sécurité) sait exploiter
 * là où un suffixe sur un chemin partagé demanderait de les énumérer.
 *
 * ## Les codes qu'elle rend, et ce qu'ils font à la file
 *
 * Ils ne sont pas choisis ici : la table du README les fige, et la Lambda les
 * traduit déjà.
 *
 * | Ce qui s'est passé | Code | Sort du message SQS |
 * |---|---|---|
 * | le message est parti | `200` | acquitté, compté `Sent` |
 * | rejeu, adresse supprimée, rappel sans objet | `204` | acquitté, compté `Skipped` |
 * | corps illisible ou non conforme | `400` | acquitté, `PermanentFailures` |
 * | jeton absent ou faux | `401` | **rendu à SQS** — un refus d'authentification ne dit rien du message |
 * | le rendez-vous annoncé n'existe plus | `404` | acquitté, `PermanentFailures` |
 * | destinataire injoignable — adresse vide, numéro non normalisable | `422` | acquitté, `PermanentFailures` |
 * | aucun expéditeur configuré, modèle absent, base injoignable | `5xx` | **rendu à SQS**, rejoué puis DLQ |
 *
 * Le `503` de l'expéditeur non configuré est la ligne qui tient le troisième
 * critère d'acceptation : il est **transitoire**, donc le message survit en
 * DLQ et repart le jour où la passerelle est branchée. C'est ce qu'un faux
 * `SENT` aurait rendu impossible.
 *
 * ## Le `204` est posé à la main, et c'est nécessaire
 *
 * Nest fige un code par route ; celui-ci dépend du **résultat**, qu'on ne
 * connaît qu'après l'expédition. Rendre `200` sur un rejeu aurait fait compter
 * un `Sent` là où rien n'est parti — et c'est précisément cette métrique qui dit
 * si la chaîne fonctionne. `@Res({ passthrough: true })` laisse Nest sérialiser
 * la réponse comme d'habitude ; seule la ligne de statut est écrite ici, comme
 * le fait déjà `health.controller.ts`.
 *
 * ## Ni `@AuthAtLeast`, ni portée de tenant résolue par la requête
 *
 * L'appelant est une fonction Lambda sans compte, sans rôle et sans
 * établissement : `internal-caller.guard.ts` explique pourquoi un jeton partagé
 * est ici la forme juste, et pourquoi la comparaison est à temps constant.
 *
 * La portée, elle, s'ouvre sur `message.tenantId` — la seule chose de
 * l'enveloppe qui ne se relise pas, et elle est là **pour cela** depuis #71 :
 * « le jour où l'événement viendra d'une file, il n'y aura plus aucune requête
 * ni aucun `AsyncLocalStorage` à hériter ». Ce jour est celui-ci. Sans elle, le
 * consommateur n'aurait qu'un choix — deviner le tenant par une lecture **non
 * scopée** du rendez-vous —, c'est-à-dire ouvrir dans la chaîne d'envoi
 * exactement le genre de chemin que tenant-isolation §3 cherche à supprimer.
 *
 * Ce que cela borne est net : tout ce que le traitement lit et écrit passe par
 * le client scopé sur ce tenant-là. Une enveloppe qui nommerait l'établissement
 * A ne peut rien lire de B — le rendez-vous de B est introuvable, son compte
 * destinataire aussi, et le message finit en `404` sans avoir rien divulgué.
 */
@ApiTags('notifications')
@Controller({ path: 'interne/notifications', version: '1' })
export class NotificationDispatchController {
  public constructor(
    private readonly dispatch: NotificationDispatchService,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  @Post('dispatch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(InternalCallerGuard)
  @ApiHeader({
    name: INTERNAL_TOKEN_HEADER,
    required: true,
    description: 'Jeton partagé de la chaîne de notifications. Route réservée à l’infrastructure.',
  })
  @ApiOperation({
    summary: 'Expédier un message de notification (route interne)',
    description:
      'Inscrit la ligne en PENDING, rend le message dans le fuseau de l’établissement, appelle ' +
      'SES ou SNS, puis passe la ligne à SENT avec l’accusé du fournisseur. Rend 204 quand une ' +
      'autre livraison avait déjà pris le message, ou qu’il n’a plus d’objet.',
  })
  @ApiOkResponse({ type: DispatchResultDto, description: 'Le message est parti.' })
  @ApiNoContentResponse({
    description: 'Rien à envoyer — rejeu, adresse supprimée, ou rappel sans objet.',
  })
  @ApiBadRequestResponse({ description: 'Enveloppe non conforme — le champ fautif est nommé.' })
  @ApiUnauthorizedResponse({ description: 'Jeton d’appel interne absent ou invalide.' })
  @ApiUnprocessableEntityResponse({
    description: 'Destinataire injoignable sur ce canal — échec permanent, à ne pas rejouer.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Aucun jeton d’appel interne, ou aucun expéditeur configuré pour ce canal. La ligne reste ' +
      'FAILED et le message est reprenable.',
  })
  public async dispatchMessage(
    @Body() body: DispatchNotificationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DispatchResultDto | undefined> {
    const message = toNotificationMessage(body.message);

    const outcome = await this.tenants.runWithTenant(message.tenantId, () =>
      this.dispatch.dispatch(message),
    );

    // L'identifiant SQS, et rien d'autre de la livraison : c'est ce qui relie
    // cette ligne au journal de la Lambda, et c'est la seule raison pour
    // laquelle `messageId` traverse le contrat. Ni contenu, ni coordonnée —
    // l'enveloppe n'en porte de toute façon aucune (notifications §7).
    this.logger.log('message de notification traité', {
      sqsMessageId: body.messageId,
      dedupeKey: message.dedupeKey,
      type: message.type,
      channel: message.channel,
      outcome,
    });

    if (outcome === 'skipped') {
      response.status(HttpStatus.NO_CONTENT);
      // `undefined` et non un corps vide : Express refuse d'écrire un corps sur
      // un 204, et Nest sérialiserait `{}` — ce qui produirait un avertissement
      // de flux et, selon l'agent HTTP, une réponse tenue pour malformée.
      return undefined;
    }

    return { outcome };
  }
}
