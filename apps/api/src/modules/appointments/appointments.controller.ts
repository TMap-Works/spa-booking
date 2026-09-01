import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { MyAppointmentsQueryDto, toListInput } from './dto/my-appointments.dto';

/**
 * Les rendez-vous **derrière un jeton** — le comptoir (#40) et l'espace client
 * (#47).
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /appointments/mine` | toute identité vérifiée |
 * | `POST /appointments/:id/cancel` | staff et au-dessus |
 *
 * Les deux cohabitent parce qu'elles désignent l'établissement de la **même**
 * façon — le jeton, et lui seul — ce qui est le critère qui a fait séparer ce
 * contrôleur du tunnel public. Ce qui les distingue, le rang de l'appelant, se
 * déclare par route : `@Auth()` pour la cliente qui lit son propre historique,
 * `@AuthAtLeast('STAFF')` pour le comptoir qui écrit dans l'agenda du salon.
 * C'est la même conduite que `UsersController`, où `PATCH /users/me` voisine avec
 * des routes d'administration sans rien leur ouvrir.
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
