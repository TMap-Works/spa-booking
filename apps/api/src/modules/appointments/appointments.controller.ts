import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { Auth, AuthAtLeast } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { AppointmentsService } from './appointments.service';
import { AppointmentDto } from './dto/book-appointment.dto';
import { CancelAppointmentDto, toCancellationReason } from './dto/cancel-appointment.dto';
import {
  ChangeAppointmentStatusDto,
  toStatusChangeInput,
} from './dto/change-appointment-status.dto';
import { CreateAppointmentDto, toCreateInput } from './dto/create-appointment.dto';
import {
  AgendaAppointmentDto,
  AppointmentListQueryDto,
  toAgendaInput,
} from './dto/list-appointments.dto';
import { MyAppointmentsQueryDto, toListInput } from './dto/my-appointments.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

/**
 * Les rendez-vous **derrière un jeton** — le comptoir (#40) et l'espace client
 * (#47).
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /appointments` | staff et au-dessus |
 * | `GET /appointments/mine` | toute identité vérifiée |
 * | `POST /appointments` | staff et au-dessus |
 * | `POST /appointments/:id/reschedule` | staff et au-dessus |
 * | `POST /appointments/:id/status` | staff et au-dessus |
 * | `POST /appointments/:id/cancel` | staff et au-dessus |
 *
 * Les trois cohabitent parce qu'elles désignent l'établissement de la **même**
 * façon — le jeton, et lui seul — ce qui est le critère qui a fait séparer ce
 * contrôleur du tunnel public. Ce qui les distingue, le rang de l'appelant, se
 * déclare par route : `@Auth()` pour la cliente qui lit son propre historique,
 * `@AuthAtLeast('STAFF')` pour le comptoir qui lit et écrit dans l'agenda du
 * salon. C'est la même conduite que `UsersController`, où `PATCH /users/me`
 * voisine avec des routes d'administration sans rien leur ouvrir.
 *
 * ## Deux lectures de rendez-vous, et pourquoi elles ne fusionnent pas (#444)
 *
 * `GET /appointments` sert l'agenda du comptoir, `GET /appointments/mine`
 * l'historique de la cliente. Elles ne diffèrent pas par un filtre mais par leur
 * **nature** : la première laisse choisir la période et la fiche cliente, et rend
 * des noms, la note interne du praticien et le motif d'annulation ; la seconde ne
 * connaît qu'un porteur, celui du jeton, et ne rend que ce qu'une cliente peut
 * voir. Les fondre aurait fait dépendre d'un `if` sur le rôle ce qui dépend
 * aujourd'hui de la porte — la façon la plus sûre de servir un jour une note
 * interne à la cliente qu'elle décrit.
 *
 * ## Pourquoi un second contrôleur plutôt qu'une route de plus sur le public
 *
 * Parce que les deux surfaces n'ont ni le même appelant, ni la même façon de
 * désigner l'établissement, ni le même régime de garde — et que les mêler
 * obligerait à distinguer par le corps deux appelants qui n'ont pas les mêmes
 * droits, la façon la plus sûre de se tromper.
 *
 * Le tunnel public résout l'établissement depuis le **slug d'URL**, et n'exige
 * aucun jeton : on réserve sans compte, donc on annule sans compte. Ici,
 * l'établissement vient du **jeton vérifié** et de lui seul (tenant-isolation
 * §2) — il n'y a aucun `:tenantId` dans le chemin, et il ne doit pas y en avoir :
 * une route `/tenants/:tenantId/appointments/:id/cancel` laisserait le client
 * désigner l'agenda qu'il veut modifier, et il ne resterait qu'à espérer qu'une
 * comparaison quelque part le rattrape. Ici il n'y a rien à comparer : le client
 * Prisma est déjà borné.
 *
 * ## Pourquoi `STAFF` et non `MANAGER`
 *
 * Parce qu'annuler est un geste de **tenue d'agenda**, pas de gestion de
 * l'établissement. Le praticien dont la cliente ne s'est pas présentée, ou qui
 * apprend au téléphone qu'elle ne viendra pas, doit pouvoir libérer le créneau
 * dans la minute : c'est même tout l'intérêt de le libérer, puisqu'il redevient
 * vendable. Exiger un manager ferait rester des créneaux fantômes bloqués
 * jusqu'à ce que quelqu'un d'autre soit disponible — l'inverse exact du résultat
 * cherché. Le CDC §1.4 réserve à l'encadrement la **configuration** de
 * l'établissement, pas la conduite de la journée.
 *
 * Le geste n'est pas silencieux pour autant : `cancelled_by`, `cancelled_at` et
 * le motif sont inscrits sur la ligne, et l'événement `appointment.cancelled`
 * part avec eux.
 *
 * ## Les trois écritures de comptoir, ajoutées par #461
 *
 * Poser, déplacer et solder un rendez-vous — les trois gestes que le tiroir de
 * #50 a écrits contre le contrat partagé avant qu'aucune route ne les serve.
 * Elles rendent toutes trois `AgendaAppointmentDto`, c'est-à-dire
 * `appointmentSchema` : le calendrier doit pouvoir replacer le bloc qu'il vient
 * de toucher sans une requête de plus, et cela demande les noms de la cliente,
 * du praticien et de la prestation — que la forme publique ne porte pas.
 *
 * Elles vivent **ici** et non sur le tunnel public, pour la raison qui a fait
 * séparer les deux contrôleurs : leur établissement vient du jeton, et leur
 * cliente est une fiche déjà au fichier. Une prise de rendez-vous publique qui
 * accepterait un `clientId` réserverait au nom d'un autre.
 *
 * ## Aucun `DELETE`, et ce n'est pas un oubli
 *
 * Un rendez-vous ne se supprime pas : il change de statut. Le reporting du CDC
 * §1.4 compte les annulations et les no-shows, et une ligne effacée ne se compte
 * pas. C'est aussi ce que les clés étrangères `Restrict` du schéma imposent en
 * base — un encaissement ou une notification référencent le rendez-vous.
 */
@ApiTags('appointments')
@Controller({ path: 'appointments', version: '1' })
export class AppointmentsController {
  public constructor(private readonly appointments: AppointmentsService) {}

  /**
   * L'agenda de l'établissement sur une plage de jours — le calendrier du
   * comptoir (#444, CDC §1.4 « calendrier jour / semaine »).
   *
   * **200**, et le corps est la liste des rendez-vous de la plage, ordonnée par
   * instant de début. Chaque ligne porte la cliente, le praticien et la
   * prestation **imbriqués** : c'est ce qui permet à une grille d'afficher
   * « Camille — Massage 60 min » sans une requête par cellule.
   *
   * ## `@AuthAtLeast('STAFF')`, et pourquoi pas `MANAGER`
   *
   * Parce que consulter l'agenda est le geste d'ouverture de la journée, pas un
   * acte de gestion : le praticien qui regarde ce qui l'attend, la personne
   * d'accueil qui cherche le rendez-vous de 14 h. Exiger un manager rendrait
   * l'écran principal du back-office inaccessible à ceux qui l'utilisent toute la
   * journée. Le CDC §1.4 réserve à l'encadrement la **configuration** de
   * l'établissement, pas la conduite de la journée — même partage que
   * l'annulation ci-dessous.
   *
   * Ce que la garde interdit, en revanche, est net : **le parcours client n'y
   * accède pas**. Un jeton `CLIENT` reçoit 403, et la cliente qui veut ses
   * rendez-vous a `/appointments/mine`, qui ne lui montre que les siens.
   *
   * ## Ce que cette route ne peut pas faire, par construction
   *
   * Lire l'agenda d'un autre établissement. Il n'y a aucun `tenantId` dans le
   * chemin ni dans le DTO, et le `ValidationPipe` global refuserait celui qu'on
   * glisserait dans la chaîne de requête : l'établissement vient du jeton
   * vérifié, et le client Prisma est déjà borné (tenant-isolation §2). Un
   * `staffId`, un `clientId` ou un `serviceId` du voisin ne rend donc ni 403 ni
   * 404 — il ne correspond à aucune ligne, et la réponse est vide. C'est la seule
   * réponse qui n'apprenne rien : une erreur distincte aurait fait de cette route
   * une sonde d'annuaire (tenant-isolation §4).
   *
   * **422 `APPOINTMENT_RANGE_TOO_WIDE`** quand la plage est inversée ou dépasse
   * `MAX_APPOINTMENT_RANGE_DAYS`. Ce n'est pas un défaut de format — chaque date
   * est bien écrite —, c'est leur écart qui n'est pas servable.
   *
   * ## Pas de quota, comme les autres routes de ce contrôleur
   *
   * L'appelant a un jeton signé : le quota utile est l'authentification
   * elle-même. Ce qui borne le coût de la réponse est la **plage**, jugée avant
   * toute lecture — et un salon qui feuillette son calendrier toute la matinée
   * enchaîne légitimement les appels.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les rendez-vous de l’établissement sur une plage de jours' })
  @ApiOkResponse({ type: [AgendaAppointmentDto] })
  @ApiBadRequestResponse({
    description: 'Paramètre de requête invalide — le champ fautif est nommé.',
  })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  @ApiUnprocessableEntityResponse({
    description:
      'Plage inversée ou trop large — `APPOINTMENT_RANGE_TOO_WIDE`. ' +
      '`details` porte les bornes envoyées et le maximum.',
  })
  public async list(@Query() query: AppointmentListQueryDto): Promise<AgendaAppointmentDto[]> {
    // Aucun `@CurrentUser()` : à la différence de `mine`, cette route ne
    // s'intéresse pas à qui appelle mais à l'établissement du jeton, et celui-ci
    // est déjà dans le contexte de requête. Le rang de l'appelant a été jugé par
    // la porte.
    return this.appointments.listAgenda(toAgendaInput(query));
  }

  /**
   * L'historique de la cliente connectée — « à venir » ou « passés » (#47,
   * deuxième critère ; CDC §1.4 « compte client avec historique »).
   *
   * **200**, et le corps est une liste de rendez-vous sous la même forme que
   * celle du tunnel public : le front n'a donc qu'un seul type de rendez-vous à
   * savoir afficher, qu'il vienne d'une réservation, d'un report ou de cet
   * historique.
   *
   * `mine` est un chemin **littéral**, déclaré avant toute route à segment
   * dynamique : c'est l'ordre qui empêche un futur `GET /appointments/:id`
   * d'absorber cette route et de tenter de lire un rendez-vous nommé « mine ».
   *
   * ## `@Auth()` sans argument, et pourquoi pas un rôle
   *
   * Toute identité vérifiée, `CLIENT` compris : c'est la clientèle qui est
   * l'appelante attendue, et un seuil de rôle la priverait de la seule route par
   * laquelle elle relit ses rendez-vous. Lire son propre historique n'est pas un
   * privilège — il n'y a pas d'autre historique à atteindre depuis ici.
   *
   * ## Ce que cette route ne peut pas faire, par construction
   *
   * Lire l'historique de quelqu'un d'autre. La cliente vient de
   * `@CurrentUser().userId`, donc d'un jeton dont la signature a été vérifiée, et
   * `MyAppointmentsQueryDto` ne porte **aucun** `clientId` — il n'y a pas de
   * champ par lequel en désigner une autre, et le `ValidationPipe` global
   * refuserait celui qu'on glisserait dans la requête. L'établissement vient du
   * même jeton et borne déjà le client Prisma : un rendez-vous d'un autre salon
   * est introuvable, pas interdit (tenant-isolation §4).
   *
   * ## Pas de quota, pour la raison de l'annulation de back-office
   *
   * L'appelant a un jeton signé : le quota utile est l'authentification
   * elle-même. Le plafond qui compte ici est celui du DTO — cent lignes au plus
   * par appel — et il borne le coût de la réponse, pas la fréquence des appels.
   */
  @Get('mine')
  @Auth()
  @ApiOperation({ summary: 'Lister ses propres rendez-vous, à venir ou passés' })
  @ApiOkResponse({ type: [AppointmentDto] })
  @ApiBadRequestResponse({
    description: 'Paramètre de requête invalide — le champ fautif est nommé.',
  })
  public async mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyAppointmentsQueryDto,
  ): Promise<AppointmentDto[]> {
    // La cliente vient du jeton, jamais de la requête (tenant-isolation §2) :
    // c'est `toListInput` qui les réunit, et lui seul.
    return this.appointments.listForClient(toListInput(query, user.userId));
  }

  /**
   * Pose un rendez-vous au comptoir, pour une fiche cliente du salon (#461,
   * premier critère de #50).
   *
   * **201**, et le corps est la **ligne d'agenda** du rendez-vous créé —
   * `appointmentSchema` du contrat partagé, cliente, praticien et prestation
   * imbriqués. C'est ce qui permet au calendrier de placer le bloc sans relire
   * la période entière.
   *
   * **`staffId` est facultatif** : l'omettre, c'est l'option « premier
   * disponible » du CDC §1.4 (#36), et la réponse porte le praticien retenu.
   *
   * **`clientId` est obligatoire**, à la différence du contrat qui le déclare
   * facultatif : le porteur du jeton est un membre du personnel, il n'y a pas de
   * cliente à en déduire. Voir l'en-tête de `CreateAppointmentDto`.
   *
   * **400** couvre le corps invalide — et en particulier un `client` glissé dans
   * le corps : le `ValidationPipe` global refuse tout champ non déclaré, et
   * cette route ne crée aucune fiche. C'est le pendant, côté API, du `.strict()`
   * qui sépare les deux schémas de création dans `packages/shared`.
   *
   * **404** couvre trois choses, indistinctement : la prestation inconnue, la
   * prestation retirée du catalogue, et la fiche cliente inconnue **ou d'un
   * autre établissement**. Un refus qui séparerait la dernière des deux ferait
   * de cette route une sonde d'annuaire (tenant-isolation §4).
   *
   * **409 `SLOT_NO_LONGER_AVAILABLE`** couvre toutes les façons dont le créneau
   * n'est pas réservable — pris entre l'affichage et la validation, hors des
   * heures du praticien, pendant un congé, sous le préavis, ou chez un praticien
   * qui ne pratique pas ce soin. Le tiroir n'a qu'une conduite pour toutes :
   * recharger le planning et proposer autre chose.
   *
   * ## Pas de quota, comme les autres routes de ce contrôleur
   *
   * L'appelant a un jeton signé : le quota utile est l'authentification
   * elle-même. Un comptoir qui saisit une matinée d'appels enchaîne
   * légitimement les écritures, et un plafond par adresse pénaliserait le salon
   * dont tout le personnel partage la même sortie réseau.
   */
  @Post()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Poser un rendez-vous depuis le back-office' })
  @ApiCreatedResponse({ type: AgendaAppointmentDto })
  @ApiBadRequestResponse({
    description:
      'Corps invalide — le champ fautif est nommé. Couvre le champ `client`, que ' +
      'cette route refuse : le comptoir désigne une fiche, il n’en crée pas.',
  })
  @ApiNotFoundResponse({
    description:
      'Prestation introuvable ou retirée du catalogue, ou fiche cliente ' +
      'introuvable dans cet établissement.',
  })
  @ApiConflictResponse({
    description: 'Le créneau n’est pas — ou n’est plus — réservable (`SLOT_NO_LONGER_AVAILABLE`).',
  })
  public async create(@Body() body: CreateAppointmentDto): Promise<AgendaAppointmentDto> {
    // Aucun `@CurrentUser()` : l'établissement vient du jeton et est déjà dans le
    // contexte de requête, la cliente vient du corps, et le rang de l'appelant a
    // été jugé par la porte. Il n'y a rien de l'appelant à lire ici.
    return this.appointments.createAtDesk(toCreateInput(body));
  }

  /**
   * Déplace un rendez-vous — **côté salon** (#461, troisième critère de #50).
   *
   * **201**, et le corps porte la ligne d'agenda du **nouveau** rendez-vous,
   * identifiant compris : un report est une annulation suivie d'une création
   * liée, jamais une réécriture des bornes en place (booking-engine §5). Le
   * tiroir remplace donc celui qu'il gardait, et `rescheduledFromId` le relie à
   * son prédécesseur.
   *
   * Le corps ne porte qu'un instant et, facultatif, un praticien : le
   * `ValidationPipe` global refuse tout le reste, ce qui rend structurellement
   * impossible qu'un report change la prestation, la cliente ou le prix.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement.
   * **422 `INVALID_STATE_TRANSITION`** quand il est terminé, annulé ou no-show :
   * il n'y a plus de créneau à déplacer. **409** quand le créneau d'arrivée est
   * pris (`SLOT_NO_LONGER_AVAILABLE`) ou que le rendez-vous vient d'être modifié
   * par ailleurs (`CONFLICT`).
   *
   * Un report vers le créneau que le rendez-vous occupe déjà, chez le même
   * praticien, ne déplace rien et n'écrit rien : la réponse est le rendez-vous
   * tel qu'il est, avec son identifiant d'origine.
   *
   * ## Distincte de la route publique, et ce n'est pas un doublon
   *
   * `POST /public/:tenantSlug/appointments/:id/reschedule` sert la cliente qui
   * déplace son propre rendez-vous, sans compte, sur la seule connaissance de
   * son identifiant. Celle-ci sert le comptoir, derrière un jeton, et rend une
   * ligne d'agenda plutôt qu'une confirmation. Les fondre aurait fait dépendre
   * d'un `if` sur le rôle ce qui dépend aujourd'hui de la porte.
   */
  @Post(':appointmentId/reschedule')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Reporter un rendez-vous depuis le back-office' })
  @ApiParam({
    name: 'appointmentId',
    format: 'uuid',
    description: 'Le rendez-vous à déplacer, dans l’établissement du jeton.',
  })
  @ApiCreatedResponse({ type: AgendaAppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description: 'Rendez-vous introuvable dans cet établissement, ou prestation retirée.',
  })
  @ApiConflictResponse({
    description:
      'Le créneau d’arrivée n’est pas — ou n’est plus — réservable ' +
      '(`SLOT_NO_LONGER_AVAILABLE`), ou le rendez-vous vient d’être modifié par ' +
      'ailleurs (`CONFLICT`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Rendez-vous terminé, annulé ou no-show — plus rien à déplacer ' +
      '(`INVALID_STATE_TRANSITION`).',
  })
  public async reschedule(
    // `ParseUUIDPipe` pour la raison qu'expose `ServicesController` : un
    // identifiant mal formé est un 400 nommant le paramètre, jamais une requête
    // qui descend jusqu'au pilote PostgreSQL pour en revenir en 500.
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: RescheduleAppointmentDto,
  ): Promise<AgendaAppointmentDto> {
    return this.appointments.rescheduleAtDesk({
      appointmentId,
      // La chaîne a été validée comme instant à offset explicite par le DTO.
      startsAt: new Date(body.startsAt),
      // Le DTO distingue « absent » de « vide » ; le domaine ne connaît que
      // `null`, qui se lit « le même praticien qu'avant ».
      staffId: body.staffId ?? null,
    });
  }

  /**
   * Fait avancer un rendez-vous dans son cycle de vie (#461, cinquième critère
   * de #50).
   *
   * **200 et non 201** : rien n'est créé, un rendez-vous change d'état. Le corps
   * rend sa ligne d'agenda, statut à jour — l'identifiant, lui, ne bouge pas,
   * ce qui distingue cette route du report.
   *
   * **422 `INVALID_STATE_TRANSITION`** pour tout passage que le cycle de vie
   * n'autorise pas, `details` portant `from` et `to` : `pending → completed` en
   * particulier — on ne solde pas un soin qui n'a pas été confirmé —, tout
   * retour en arrière depuis un statut terminal, et un statut vers lui-même. Le
   * refus vient d'`AppointmentLifecycleService`, jamais de ce contrôleur.
   *
   * **400** quand le statut n'appartient pas au vocabulaire. Les deux refus ne
   * se confondent pas : le premier dit « ce mot n'existe pas », le second « ce
   * passage n'existe pas », et le tiroir n'affiche pas la même chose.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement.
   * **409 `CONFLICT`** quand deux transitions se croisent et que la seconde
   * arrive après que la première a écrit.
   *
   * ## `cancelled` est accepté, et part par l'annulation
   *
   * Le contrat accepte les cinq statuts, et le cycle de vie autorise bien
   * d'atteindre `cancelled`. Mais une ligne qui y passerait par un simple
   * changement de statut n'aurait ni horodatage, ni auteur, ni motif : le
   * service délègue donc cette transition-là à l'annulation, qui est la seule
   * écriture qui pose la trace. `reason` y devient le motif — c'est sa seule
   * destination, il n'y a pas de colonne pour motiver un no-show.
   *
   * Le tiroir de #50, lui, n'emprunte pas ce chemin : il a un bouton
   * d'annulation à part, avec sa propre confirmation, qui appelle
   * `POST /:id/cancel`.
   */
  @Post(':appointmentId/status')
  @HttpCode(200)
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Changer le statut d’un rendez-vous depuis le back-office' })
  @ApiParam({
    name: 'appointmentId',
    format: 'uuid',
    description: 'Le rendez-vous à faire avancer, dans l’établissement du jeton.',
  })
  @ApiOkResponse({ type: AgendaAppointmentDto })
  @ApiBadRequestResponse({
    description: 'Corps invalide — statut hors du vocabulaire, ou motif trop long.',
  })
  @ApiNotFoundResponse({ description: 'Rendez-vous introuvable dans cet établissement.' })
  @ApiConflictResponse({
    description: 'Le rendez-vous vient d’être modifié par ailleurs (`CONFLICT`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Le cycle de vie n’autorise pas ce passage — `INVALID_STATE_TRANSITION`, ' +
      '`details` portant `from` et `to`.',
  })
  public async changeStatus(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: ChangeAppointmentStatusDto,
  ): Promise<AgendaAppointmentDto> {
    return this.appointments.changeStatus(toStatusChangeInput(appointmentId, body));
  }

  /**
   * Annule un rendez-vous — **côté salon** (#40).
   *
   * **200 et non 201** : rien n'est créé, un rendez-vous change d'état. Le corps
   * rend ce rendez-vous au statut `CANCELLED`, `cancelledAt` et `cancelledBy`
   * posés — `cancelledBy` valant ici `STAFF`, quel que soit le rang exact de qui
   * a annulé : la question est de quel côté du comptoir la décision vient, pas
   * quel droit avait son auteur.
   *
   * Le créneau est **déjà réservable** quand cette réponse part, sans qu'aucune
   * libération n'ait été écrite : la ligne a quitté le filtre partiel de
   * `appointments_no_overlap` au `COMMIT`.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement,
   * indistinctement — un 403 confirmerait son existence (tenant-isolation §4).
   *
   * **422 `INVALID_STATE_TRANSITION`** quand le rendez-vous est terminé, déjà
   * annulé ou marqué no-show. Le refus vient d'`AppointmentLifecycleService`,
   * jamais de ce contrôleur : c'est le quatrième critère de #40.
   *
   * **409 `CONFLICT`** quand deux annulations se croisent et que la seconde
   * arrive après que la première a inscrit son auteur et son motif.
   *
   * ## Pas de quota, contrairement à la route publique
   *
   * `ThrottlerGuard` protège le tunnel public parce qu'il **écrit sans qu'on ait
   * à prouver quoi que ce soit**. Ici, l'appelant a un jeton signé, un
   * établissement et un rôle : le quota utile n'est pas le nombre d'appels par
   * minute, c'est l'authentification elle-même. Un comptoir qui traite une
   * journée de désistements après une fermeture exceptionnelle enchaîne
   * légitimement les annulations, et un plafond par adresse pénaliserait le
   * salon dont tout le personnel partage la même sortie réseau.
   */
  @Post(':appointmentId/cancel')
  @HttpCode(200)
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Annuler un rendez-vous depuis le back-office' })
  @ApiParam({
    name: 'appointmentId',
    format: 'uuid',
    description: 'Le rendez-vous à annuler, dans l’établissement du jeton.',
  })
  @ApiOkResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Rendez-vous introuvable dans cet établissement.' })
  @ApiConflictResponse({
    description: 'Le rendez-vous vient d’être modifié par ailleurs (`CONFLICT`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Rendez-vous terminé, déjà annulé ou no-show — plus rien à annuler ' +
      '(`INVALID_STATE_TRANSITION`).',
  })
  public async cancel(
    // `ParseUUIDPipe` pour la raison qu'expose `ServicesController` : un
    // identifiant mal formé est un 400 nommant le paramètre, jamais une requête
    // qui descend jusqu'au pilote PostgreSQL pour en revenir en 500.
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: CancelAppointmentDto,
  ): Promise<AppointmentDto> {
    return this.appointments.cancel({
      appointmentId,
      // Fixé par la **porte**, jamais lu du corps.
      cancelledBy: 'STAFF',
      // Absent ou réduit à rien par l'élagage : le domaine lit `null`.
      reason: toCancellationReason(body),
    });
  }
}
