import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthWith } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { ownScopeFor } from '../identity/permissions';
import { DeliveryEventService } from './delivery-event.service';
import { DeliveryEventDto, toDeliveryEventDto } from './dto/delivery-event.dto';
import {
  ListNotificationsQueryDto,
  NotificationListDto,
  toNotificationListDto,
  toNotificationSearch,
} from './dto/list-notifications.dto';
import { ReminderSweepDto, toReminderSweepDto } from './dto/reminder-sweep.dto';
import { InternalCallerGuard } from './internal-caller.guard';
import { INTERNAL_TOKEN_HEADER } from './notifications.config';
import { NotificationsService } from './notifications.service';
import { ReminderSweepService } from './reminder-sweep.service';

/**
 * Le journal d'envois de l'établissement — CDC §1.4, « le statut d'envoi est
 * visible dans le back-office » (#70).
 *
 * | Route | Droit exigé | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /notifications` | `agenda:read:own` **ou** `:all` | les traces d'envoi, filtrées — **bornées à ses propres rendez-vous** pour le premier |
 * | `POST /notifications/reminders/sweep` | interne | les rappels J-1 dus (#71) |
 * | `POST /notifications/delivery-events` | interne | un rebond ou une plainte SES (#73) |
 *
 * Les deux routes internes ne sont pas gardées par un rôle mais par un **jeton
 * partagé** : leur appelant est une fonction Lambda, qui n'a ni compte, ni rôle,
 * ni établissement — et les deux traitements traversent de toute façon tous les
 * établissements. Voir `internal-caller.guard.ts`.
 *
 * La **troisième** route interne du module, `POST /interne/notifications/dispatch`
 * (#799), n'est pas ici : son chemin ne part pas de `notifications`, et ce n'est
 * pas une question de rangement — c'est le contrat que `dispatch_url` désigne
 * depuis #67, et le segment `interne` sépare à la racine ce qu'une personne
 * authentifiée peut appeler de ce que seule l'infrastructure appelle. Voir
 * `notification-dispatch.controller.ts`, qui porte la même garde et le même
 * jeton.
 *
 * ## Pourquoi `agenda:read:*` et non plus `@AuthAtLeast('STAFF')` — #1200
 *
 * La question à laquelle cette route répond est « ma cliente dit n'avoir rien
 * reçu — le message est-il parti ? ». Elle se pose au comptoir, au téléphone,
 * pendant que la cliente attend, et elle se pose aussi bien à la praticienne
 * qu'à la gérante : fermer la route à `MANAGER` l'aurait rendue inaccessible aux
 * personnes qui décrochent. Le rang `STAFF` ouvrait donc la bonne porte — mais
 * il ouvrait **tout le salon** derrière elle.
 *
 * C'est le constat de #1200, relevé par la campagne QA `20260922-complet` : un
 * praticien y lisait les 89 lignes de l'établissement, dont 32 rendez-vous de
 * son collègue, `appointmentId` et `recipientUserId` compris. Ces identifiants
 * sont exactement ceux par lesquels le contournement de #1135 a été monté ;
 * #1135 a fermé la conséquence, celui-ci ferme l'exposition.
 *
 * Le défaut n'était pas dans le seuil, il était dans sa **forme**, et c'est le
 * raisonnement même d'ADR 0013 : ce qui sépare le praticien de la gérante n'est
 * pas un cran de capacité mais un **ensemble d'objets**. Les deux lisent un
 * journal d'envois ; l'un celui de ses rendez-vous, l'autre celui du salon.
 * Aucun rang n'ordonne cela.
 *
 * ## Pourquoi aucune permission nouvelle
 *
 * `agenda:read:own` et `agenda:read:all` **portent déjà cette frontière**, posée
 * par #812 sur l'arbitrage du PO du 16/09 : « le praticien ne voit que son
 * propre planning ». Un journal d'envois n'est rien d'autre qu'une seconde
 * lecture du même agenda — il nomme les mêmes rendez-vous et les mêmes
 * destinataires, par une autre porte, exactement comme l'écran d'encaissement
 * dont l'ADR dit qu'il « est un agenda complet par une autre porte ».
 *
 * Créer `notifications:read:all` aurait donc écrit **une seconde fois** une
 * décision déjà prise, et la seconde écriture est celle qui diverge : le jour où
 * le PO rouvrirait l'agenda du salon au praticien, une des deux resterait
 * fermée sans que rien ne le dise. Une permission par module n'est pas un
 * vocabulaire de droits, c'est une table des matières.
 *
 * ## Les deux permissions sur la même route, et ce que cela veut dire
 *
 * « L'une d'elles », jamais « toutes » — c'est la lecture qu'ADR 0013 donne de
 * plusieurs permissions citées, et c'est ce que réclame une route à double
 * portée. La garde décide de l'**accès** et ne consulte aucune ressource ; c'est
 * ensuite `ownScopeFor(actor, 'agenda:read:all')` qui décide du **contenu**.
 * Même montage que `GET /v1/customers` chez `crm`, au mot près — et depuis
 * #1205 la même fonction, exposée par `identity/permissions.ts`, parce que deux
 * écritures d'une décision déjà tranchée par la matrice pouvaient diverger. Le
 * nom de la permission large reste nommé ici : c'est la route qui sait par
 * quelle porte on entre.
 *
 * `CLIENT` n'a ni l'une ni l'autre et reste refusé en 403, comme sous le rang.
 *
 * ## Le compte, jamais la fiche praticien
 *
 * La portée retenue est `actor.userId`, issu d'un jeton **vérifié**, et c'est
 * lui qui traverse jusqu'au prédicat du dépôt. Un identifiant de fiche `staff`
 * aurait demandé une lecture de plus et n'aurait rien prouvé de mieux ; surtout,
 * il aurait pu venir d'ailleurs que du jeton, ce qui est la définition d'une
 * fuite (tenant-isolation §2).
 *
 * `agenda:read:all` l'emporte quand les deux sont portées : une gérante qui
 * donne aussi des soins lit le journal entier, comme avant.
 *
 * ## Pourquoi une liste vide et non un 403 `OWN_SCOPE_ONLY`
 *
 * Parce que cette route rend une **liste**, et qu'une liste bornée à son
 * périmètre ne refuse rien : elle rend ce qui s'y trouve. Le 403 de portée est
 * la réponse juste quand l'appelant **désigne** une ressource et se voit
 * opposer un refus — `PATCH /appointments/:id` chez `appointments`. Ici,
 * `?appointmentId=<celui d'une collègue>` rend une liste vide, ce que la route
 * rendait déjà pour un rendez-vous inconnu ou celui d'un autre salon : trois
 * situations indiscernables, et c'est très bien ainsi. Distinguer la première
 * aurait fait de la route un oracle qui confirme, un identifiant à la fois, la
 * composition de l'agenda du salon — le raisonnement qu'ADR 0013 tient pour la
 * fiche cliente hors périmètre, qui rend 404 et non 403.
 *
 * Le contraste avec `reporting` reste délibéré : là-bas, `reporting:read`, parce
 * qu'un rapport rend la performance de l'établissement. Ici, rien de tel — le
 * journal ne dit pas combien le salon gagne, il dit si un e-mail est parti.
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
  public constructor(
    private readonly notifications: NotificationsService,
    private readonly reminders: ReminderSweepService,
    private readonly deliveryEvents: DeliveryEventService,
  ) {}

  @Get()
  @AuthWith('agenda:read:own', 'agenda:read:all')
  @ApiOperation({
    summary: 'Lire le journal d’envois de l’établissement',
    description:
      'Les traces d’envoi, du plus récent au plus ancien. Aucune coordonnée ni ' +
      'contenu de message : la table n’en porte pas. Avec `agenda:read:own` seul, ' +
      'le journal est borné aux envois des rendez-vous de l’appelant ; ceux de ses ' +
      'collègues n’y figurent pas, pas même par leur identifiant.',
  })
  @ApiOkResponse({ type: NotificationListDto })
  @ApiBadRequestResponse({ description: 'Filtre invalide — le champ fautif est nommé.' })
  public async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListDto> {
    return toNotificationListDto(
      await this.notifications.list({
        ...toNotificationSearch(query),
        ownedByUserId: ownScopeFor(actor, 'agenda:read:all'),
      }),
    );
  }

  /**
   * Le balayage horaire du rappel J-1 — la seule route **interne** du module.
   *
   * ## Pourquoi elle existe
   *
   * La sélection a besoin du schéma, du client Prisma et de la définition de
   * « rendez-vous vivant » ; la publication SQS a besoin du SDK AWS, que l'API
   * n'embarque pas et n'a pas à embarquer. Cette route est la couture entre les
   * deux : elle rend les enveloppes, la Lambda les publie. La même division du
   * travail que pour la Lambda d'envoi de #67 — « elle est le transport, elle
   * n'est pas l'expéditeur ».
   *
   * ## Pourquoi `POST` alors qu'elle ne modifie rien
   *
   * Elle ne fait qu'écrire dans le journal, et pourtant ce n'est pas une
   * lecture : c'est un **ordre**, daté de l'instant où il est reçu, dont la
   * réponse est différente à chaque appel et ne doit être ni mise en cache, ni
   * préchargée, ni rejouée par un intermédiaire. `GET` aurait invité tout cela.
   *
   * ## Pourquoi ni `@AuthAtLeast`, ni portée de tenant
   *
   * L'appelant est une fonction Lambda sans compte, sans rôle et sans
   * établissement ; le balayage, lui, les traverse tous. Voir
   * `internal-caller.guard.ts`, qui explique pourquoi un jeton partagé est ici
   * la forme juste et pourquoi la comparaison est à temps constant.
   *
   * ## Elle n'écrit rien et n'envoie rien
   *
   * Aucune ligne de `notifications` n'est créée ici : la prise de droit
   * appartient à l'autre bout de la file. Un balayage rejoué republie les mêmes
   * enveloppes — mêmes `dedupeKey`, déterministes — et le second lot est ignoré
   * à l'envoi par `notifications_live_once` (#68).
   */
  @Post('reminders/sweep')
  @HttpCode(200)
  @UseGuards(InternalCallerGuard)
  @ApiHeader({
    name: INTERNAL_TOKEN_HEADER,
    required: true,
    description: 'Jeton partagé de la chaîne de notifications. Route réservée à l’infrastructure.',
  })
  @ApiOperation({
    summary: 'Sélectionner les rappels J-1 dus (route interne)',
    description:
      'Rend les enveloppes à publier sur la file d’envoi pour les rendez-vous qui commencent ' +
      'entre 24 et 25 heures après l’instant de l’appel, en UTC. N’écrit rien et n’envoie rien.',
  })
  @ApiOkResponse({ type: ReminderSweepDto })
  @ApiUnauthorizedResponse({ description: 'Jeton d’appel interne absent ou invalide.' })
  @ApiServiceUnavailableResponse({
    description: 'Aucun jeton d’appel interne n’est configuré sur cette API.',
  })
  public async sweepReminders(): Promise<ReminderSweepDto> {
    return toReminderSweepDto(await this.reminders.sweep());
  }

  /**
   * L'ingestion d'un événement de remise SES — la seconde route **interne** du
   * module (#73).
   *
   * ## Pourquoi elle existe
   *
   * SES publie ses rebonds et ses plaintes sur un topic SNS ; une file SQS s'y
   * abonne et une Lambda la dépile. Le traitement, lui, a besoin du schéma, du
   * client Prisma scopé et de la frontière de tenant : c'est cette route qui est
   * la couture entre les deux. La Lambda est le transport, elle n'est pas le
   * traitement — la même division du travail que pour le balayage du rappel J-1
   * et pour la Lambda d'envoi.
   *
   * ## Pourquoi ni `@AuthAtLeast`, ni portée de tenant
   *
   * L'appelant est une fonction Lambda sans compte, sans rôle et sans
   * établissement ; l'ingestion, elle, les traverse tous — un rebond désigne une
   * adresse, et la même adresse peut être cliente de plusieurs salons. C'est
   * exactement la situation du balayage, et la même garde y répond
   * (`internal-caller.guard.ts`).
   *
   * ## Pourquoi le corps n'est pas validé
   *
   * Parce qu'il ne nous appartient pas : c'est le JSON de SES, débarrassé de son
   * enveloppe SNS par la remise brute. Le valider contre un schéma de notre cru
   * ferait rejeter en 400 le premier rebond qu'AWS enrichirait d'un champ, et ce
   * rebond finirait en file d'attente morte. La lecture est donc défensive
   * (`delivery-event.ts`), et ce qui ne se lit pas rend `unreadable` — jamais une
   * erreur. Voir l'en-tête de `dto/delivery-event.dto.ts`.
   *
   * ## Pourquoi elle rend toujours 200
   *
   * Y compris sur une charge illisible, et c'est délibéré : un statut d'échec
   * ferait rejouer le message jusqu'à la file d'attente morte, et l'alarme de
   * profondeur signalerait une panne là où il n'y a qu'un message inattendu que
   * rien ne réparera. Le verdict se lit dans `outcome`, que la Lambda journalise.
   * Ce qui **doit** faire rejouer — une base injoignable, une écriture refusée —
   * lève et sort en 5xx, comme partout ailleurs.
   */
  @Post('delivery-events')
  @HttpCode(200)
  @UseGuards(InternalCallerGuard)
  @ApiHeader({
    name: INTERNAL_TOKEN_HEADER,
    required: true,
    description: 'Jeton partagé de la chaîne de notifications. Route réservée à l’infrastructure.',
  })
  @ApiOperation({
    summary: 'Traiter un événement de remise SES (route interne)',
    description:
      'Classe l’événement — rebond permanent, plainte, échec transitoire, sans objet — et, ' +
      'quand il condamne l’adresse, la marque comme supprimée dans tous les établissements où ' +
      'elle est connue. Le corps est le JSON de SES tel quel ; il n’est pas validé contre un ' +
      'schéma, il est lu défensivement.',
  })
  @ApiBody({
    description: 'La charge utile SES, enveloppe SNS retirée par la remise brute.',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiOkResponse({ type: DeliveryEventDto })
  @ApiUnauthorizedResponse({ description: 'Jeton d’appel interne absent ou invalide.' })
  @ApiServiceUnavailableResponse({
    description: 'Aucun jeton d’appel interne n’est configuré sur cette API.',
  })
  public async ingestDeliveryEvent(@Body() payload: unknown): Promise<DeliveryEventDto> {
    return toDeliveryEventDto(await this.deliveryEvents.ingest(payload));
  }
}
