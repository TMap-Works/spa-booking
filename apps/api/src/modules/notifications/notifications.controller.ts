import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  ListNotificationsQueryDto,
  NotificationListDto,
  toNotificationListDto,
  toNotificationSearch,
} from './dto/list-notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * Le journal d'envois de l'établissement — CDC §1.4, « le statut d'envoi est
 * visible dans le back-office » (#70).
 *
 * | Route | Rôle | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /notifications` | `STAFF` | les traces d'envoi, filtrées |
 *
 * ## Pourquoi `STAFF` et non `MANAGER`
 *
 * La question à laquelle cette route répond est « ma cliente dit n'avoir rien
 * reçu — le message est-il parti ? ». Elle se pose au comptoir, au téléphone,
 * pendant que la cliente attend. La placer à `MANAGER` l'aurait rendue
 * inaccessible aux personnes qui décrochent — c'est-à-dire à toutes celles qui
 * en ont besoin — et le CDC range explicitement la tenue de l'agenda et des
 * fiches clientes dans les gestes de front-desk.
 *
 * Le seuil est celui de `GET /customers` et de `GET /appointments` chez leurs
 * modules respectifs, et il tient à ce que la réponse ne porte **rien** de plus
 * sensible qu'eux : ni coordonnée, ni contenu de message, ni chiffre
 * d'affaires. Un statut d'envoi et une date.
 *
 * Le contraste avec `reporting` est délibéré : là-bas, `MANAGER`, parce qu'un
 * rapport rend la performance de l'établissement. Ici, rien de tel — le journal
 * ne dit pas combien le salon gagne, il dit si un e-mail est parti.
 *
 * ## Aucune route publique, aucune route `CLIENT`
 *
 * Une cliente n'a pas à interroger l'état de ses envois : ce qu'elle a reçu, elle
 * l'a reçu, et ce qu'elle n'a pas reçu ne s'explique pas par un statut technique.
 * Ouvrir cette route à `CLIENT` aurait par ailleurs demandé une comparaison
 * « ce rendez-vous est-il le sien ? » — exactement le genre de vérification
 * applicative dont l'oubli fait les fuites (tenant-isolation §4).
 *
 * ## Ni `:tenantId`, ni identifiant en chemin
 *
 * L'établissement vient du jeton vérifié, jamais du chemin
 * (tenant-isolation §2). Le rendez-vous se désigne par un filtre de requête et
 * non par un segment d'URL, parce que la route rend une **liste** : un
 * `/appointments/:id/notifications` aurait promis un 404 sur un rendez-vous
 * inconnu, donc une lecture d'`appointments` depuis un module qui ne le possède
 * pas. Ici, un rendez-vous inconnu — ou celui d'un autre salon — rend simplement
 * une liste vide, ce qui est la vérité : ce module n'a aucune trace pour lui.
 *
 * ## Aucun verbe d'écriture
 *
 * Ni renvoi, ni reprise, ni suppression. La reprise d'un envoi échoué appartient
 * à SQS et à son backoff natif (notifications §4) ; un bouton « renvoyer » au
 * comptoir doublerait la file et masquerait la profondeur de DLQ sur laquelle
 * repose l'alarme de supervision.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  public constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({
    summary: 'Lire le journal d’envois de l’établissement',
    description:
      'Les traces d’envoi, du plus récent au plus ancien. Aucune coordonnée ni ' +
      'contenu de message : la table n’en porte pas.',
  })
  @ApiOkResponse({ type: NotificationListDto })
  @ApiBadRequestResponse({ description: 'Filtre invalide — le champ fautif est nommé.' })
  public async list(@Query() query: ListNotificationsQueryDto): Promise<NotificationListDto> {
    return toNotificationListDto(await this.notifications.list(toNotificationSearch(query)));
  }
}
