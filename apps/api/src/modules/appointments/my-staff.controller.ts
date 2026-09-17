import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import {
  MyStaffAgendaDto,
  MyStaffProfileDto,
  MyStaffRangeQueryDto,
  MyStaffScheduleDto,
  myStaffRangeQuery,
  toMyStaffRangeInput,
  type MyStaffRangeQueryBody,
} from './dto/my-staff.dto';
import { MyStaffService } from './my-staff.service';

/**
 * L'espace du **praticien connecté** — `GET /api/v1/me/*` (#811, CDC §1.3
 * « Comptes staff, rôles, disponibilités »).
 *
 * | Route | Ce qu'elle rend |
 * |---|---|
 * | `GET /me/staff-profile` | la fiche praticien du compte, ou 404 |
 * | `GET /me/appointments` | ses rendez-vous, sur la fenêtre demandée |
 * | `GET /me/schedule` | ses horaires récurrents, ses absences, les jours de fermeture |
 *
 * ## Pourquoi `me` et non `staff/{id}` — et pourquoi ce n'est pas un détail
 *
 * Parce qu'un identifiant dans le chemin est un identifiant que l'appelant
 * choisit. `GET /staff/{id}/appointments` aurait exigé, à chaque route, une
 * comparaison entre la fiche demandée et celle du jeton — et il n'aurait
 * suffi d'un oubli pour qu'un praticien lise l'agenda d'un collègue. Ici il n'y
 * a **rien à comparer** : le chemin ne porte aucun identifiant, les schémas de
 * requête sont `.strict()` et n'en déclarent aucun, et le service résout la
 * fiche par `(tenantId, userId)` du jeton vérifié (tenant-isolation §2).
 *
 * C'est la conduite de `GET /appointments/mine`, déjà servie par
 * `AppointmentsController` pour la cliente. La différence est le **sens de la
 * dérivation** : là-bas le jeton donne un `clientId`, ici il donne un `staffId`
 * — par une lecture de `staff` qu'aucun code ne faisait jusqu'à ce ticket.
 *
 * ## Pourquoi ce contrôleur est dans `appointments` et non dans `catalog`
 *
 * Parce que la matière principale de cette surface est l'agenda, et que ce
 * module la possède. La fiche praticien vient bien du catalogue et l'emploi du
 * temps de la disponibilité, mais aucun des deux ne peut assembler les trois
 * sans importer les autres : l'espace praticien est une **surface**, servie par
 * le module qui détient ce qu'elle montre le plus. Les deux emprunts passent par
 * les portes exportées (`StaffScheduleService`, `StaffTimeOffService`), jamais
 * par un repository voisin (api-module §3).
 *
 * ## Pourquoi `@AuthAtLeast('STAFF')` sur les trois
 *
 * C'est le rang de la conduite de la journée, celui de l'agenda du comptoir. La
 * clientèle n'a rien à faire ici — elle n'a pas de fiche praticien, et la route
 * rendrait 404 de toute façon ; le seuil évite que ce 404 devienne une sonde à
 * bon marché depuis un compte client. Au-dessus, un `MANAGER` ou un `ADMIN` qui
 * donne aussi des soins y trouve son propre agenda : la hiérarchie des rôles est
 * emboîtée, et avoir une fiche praticien n'est pas une question de rang.
 *
 * ## Ce que ces routes ne peuvent pas faire, par construction
 *
 * Lire l'agenda d'un autre établissement. Aucun `tenantId` n'entre — ni dans le
 * chemin, ni dans la requête —, et le client Prisma est déjà borné par le
 * contexte de requête. Un praticien du salon B ne trouve rien du salon A : ses
 * lignes ne sont pas *interdites*, elles sont **introuvables** (§4).
 */
@ApiTags('Espace praticien')
@Controller('me')
@AuthAtLeast('STAFF')
export class MyStaffController {
  public constructor(private readonly me: MyStaffService) {}

  /**
   * La fiche praticien du compte connecté — premier critère de #811.
   *
   * **200** avec la fiche, **404 `STAFF_PROFILE_NOT_FOUND`** quand le compte n'en
   * a pas. Le second cas est ordinaire, pas exceptionnel : un manager qui tient
   * le salon sans y donner de soins n'a pas d'agenda, et c'est ce que l'écran
   * doit apprendre pour proposer autre chose qu'une page vide.
   *
   * 404 et non 403 : le rang est suffisant — la garde l'a jugé —, c'est la
   * ressource qui n'existe pas.
   */
  @Get('staff-profile')
  @ApiOperation({ summary: 'Lire sa propre fiche praticien' })
  @ApiOkResponse({ type: MyStaffProfileDto })
  @ApiNotFoundResponse({
    description: 'Aucune fiche praticien rattachée à ce compte — `STAFF_PROFILE_NOT_FOUND`.',
  })
  public async staffProfile(@CurrentUser() user: AuthenticatedUser): Promise<MyStaffProfileDto> {
    return this.me.profile(user.userId);
  }

  /**
   * Les rendez-vous du praticien connecté — deuxième critère.
   *
   * **200**, et le corps porte la fenêtre **résolue** à côté de la liste :
   * l'appelant qui n'a rien demandé doit savoir quelle journée le salon lui a
   * servie, et celle-ci n'est pas forcément celle de son navigateur.
   *
   * **400** sur un champ inconnu — `?staffId=` compris, et c'est le quatrième
   * critère du ticket. **422 `APPOINTMENT_RANGE_TOO_WIDE`** sur une fenêtre
   * inversée ou au-delà de trente et un jours : chaque date est bien écrite,
   * c'est leur écart qui n'est pas servable.
   */
  @Get('appointments')
  @ApiOperation({ summary: 'Lister ses propres rendez-vous sur une fenêtre' })
  @ApiOkResponse({ type: MyStaffAgendaDto })
  @ApiBadRequestResponse({
    description:
      'Paramètre de requête invalide ou **inconnu** — un `staffId` en fait ' +
      'partie : le périmètre vient du jeton, il ne se choisit pas.',
  })
  @ApiNotFoundResponse({
    description: 'Aucune fiche praticien rattachée à ce compte — `STAFF_PROFILE_NOT_FOUND`.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fenêtre inversée ou trop large — `APPOINTMENT_RANGE_TOO_WIDE`.',
  })
  // Déclaré explicitement : la chaîne de requête est validée par le contrat
  // partagé et le paramètre est typé par un alias, dont `@nestjs/swagger` ne
  // peut plus rien déduire (ADR 0008).
  @ApiQuery({ type: MyStaffRangeQueryDto })
  public async appointments(
    @CurrentUser() user: AuthenticatedUser,
    @Query(myStaffRangeQuery) query: MyStaffRangeQueryBody,
  ): Promise<MyStaffAgendaDto> {
    // Le praticien vient du jeton, jamais de la requête : `toMyStaffRangeInput`
    // est la seule à les réunir, et elle ne reçoit le compte que d'ici.
    return this.me.agenda(toMyStaffRangeInput(query, user.userId));
  }

  /**
   * L'emploi du temps du praticien connecté — troisième critère.
   *
   * **200** avec ses plages récurrentes, ses absences sur la fenêtre et les jours
   * de fermeture du salon. Les trois ensemble parce qu'aucune ne se lit sans les
   * deux autres : un écran qui n'aurait que les plages afficherait « lundi 9 h –
   * 18 h » sur un lundi fermé.
   *
   * Mêmes refus que la route précédente, pour les mêmes raisons.
   */
  @Get('schedule')
  @ApiOperation({ summary: 'Lire ses horaires, ses absences et les jours de fermeture' })
  @ApiOkResponse({ type: MyStaffScheduleDto })
  @ApiBadRequestResponse({
    description: 'Paramètre de requête invalide ou inconnu — `staffId` compris.',
  })
  @ApiNotFoundResponse({
    description: 'Aucune fiche praticien rattachée à ce compte — `STAFF_PROFILE_NOT_FOUND`.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fenêtre inversée ou trop large — `APPOINTMENT_RANGE_TOO_WIDE`.',
  })
  @ApiQuery({ type: MyStaffRangeQueryDto })
  public async schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Query(myStaffRangeQuery) query: MyStaffRangeQueryBody,
  ): Promise<MyStaffScheduleDto> {
    return this.me.schedule(toMyStaffRangeInput(query, user.userId));
  }
}
