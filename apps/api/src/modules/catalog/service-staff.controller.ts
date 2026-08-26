import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { AssignServiceStaffDto, ServiceStaffMemberDto } from './dto/service-staff.dto';
import { ServiceStaffService } from './service-staff.service';

/**
 * Affectation des praticiens aux prestations — la surface de back-office de #25.
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /services/:serviceId/staff` | staff et au-dessus |
 * | `POST /services/:serviceId/staff` | manager et au-dessus |
 * | `DELETE /services/:serviceId/staff/:staffId` | manager et au-dessus |
 *
 * ## Lire au rang `STAFF`, écrire au rang `MANAGER`
 *
 * Mêmes rangs que le catalogue lui-même, et pour la même raison : un praticien a
 * besoin de savoir qui pratique quoi — c'est ce qui décide de son agenda —, mais
 * décider des affectations est un geste de gestion. Un praticien qui pourrait
 * s'affecter lui-même à une prestation se rendrait réservable sur un soin qu'il
 * ne pratique pas.
 *
 * ## Une sous-ressource de la prestation, et non une route à plat
 *
 * `/services/:serviceId/staff` plutôt que `/service-staff?serviceId=…` : la
 * prestation est le contexte du geste, l'écran de back-office qui l'exerce est
 * la fiche d'une prestation, et le chemin le dit. La conséquence utile est que
 * `serviceId` est **toujours** présent — donc toujours vérifié — là où un
 * paramètre de requête facultatif aurait ouvert la question de ce que rend son
 * absence.
 *
 * Le geste symétrique — remplacer en bloc les prestations d'un praticien — est
 * décrit par le contrat partagé (`setStaffServicesRequestSchema`) et appartient
 * à la fiche praticien, qui n'a pas encore de module. Il n'est pas implémenté
 * ici : le poser sur cette route obligerait l'écran d'une prestation à envoyer
 * la liste complète à chaque clic, et donc à écraser ce qu'un collègue vient
 * d'ajouter.
 *
 * ## Pourquoi aucun `:tenantId` nulle part
 *
 * L'établissement vient du jeton vérifié, jamais du chemin (tenant-isolation
 * §2). Les deux identifiants du chemin sont ceux d'une prestation et d'une fiche
 * praticien, et le client Prisma est déjà borné quand ils l'atteignent : un
 * identifiant d'ailleurs est simplement introuvable.
 */
@ApiTags('catalog')
@Controller({ path: 'services/:serviceId/staff', version: '1' })
@ApiParam({ name: 'serviceId', format: 'uuid', description: 'Prestation de l’établissement.' })
export class ServiceStaffController {
  public constructor(private readonly assignments: ServiceStaffService) {}

  /**
   * Les praticiens affectés à la prestation.
   *
   * Y compris les **désactivés** : l'affectation leur survit, et la masquer
   * ferait croire à une affectation perdue — pour se heurter au conflit
   * d'unicité en tentant de la recréer. Le catalogue public, lui, ne montre que
   * les actifs.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les praticiens qui pratiquent une prestation' })
  @ApiOkResponse({ type: [ServiceStaffMemberDto] })
  @ApiNotFoundResponse({
    description: 'Aucune prestation de cet établissement ne porte cet identifiant.',
  })
  public async list(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<ServiceStaffMemberDto[]> {
    return this.assignments.list(serviceId);
  }

  /**
   * Affecte un praticien à la prestation.
   *
   * **404** si la prestation ou le praticien n'est pas de cet établissement — le
   * même code que pour un identifiant inconnu, parce que distinguer les deux
   * confirmerait l'existence de la ressource voisine (tenant-isolation §4).
   * **409** si l'affectation existe déjà.
   */
  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Affecter un praticien à une prestation' })
  @ApiCreatedResponse({ type: ServiceStaffMemberDto })
  @ApiNotFoundResponse({
    description: 'Ni la prestation ni le praticien ne sont désignés dans cet établissement.',
  })
  @ApiConflictResponse({ description: 'Ce praticien est déjà affecté à cette prestation.' })
  public async assign(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() body: AssignServiceStaffDto,
  ): Promise<ServiceStaffMemberDto> {
    return this.assignments.assign(serviceId, body.staffId);
  }

  /**
   * Retire l'affectation.
   *
   * `DELETE` sur la sous-ressource plutôt qu'un drapeau dans le corps du `POST` :
   * les deux gestes sont distincts, et l'un ne doit pas pouvoir se produire par
   * inadvertance en envoyant le mauvais champ.
   *
   * **204 sans corps** : il n'y a plus de ressource à rendre. Rendre la liste
   * restante ferait de chaque retrait une lecture de plus, que l'écran ne
   * demande pas toujours.
   *
   * C'est bien une suppression, là où le reste du module désactive : une ligne
   * d'affectation n'est référencée par aucun rendez-vous — ceux-ci portent leur
   * propre `staff_id`, figé à la réservation — et la retirer n'efface rien de ce
   * qui a été vendu.
   */
  @Delete(':staffId')
  @AuthAtLeast('MANAGER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirer un praticien d’une prestation' })
  @ApiParam({ name: 'staffId', format: 'uuid', description: 'Praticien à retirer.' })
  @ApiNoContentResponse({ description: 'L’affectation a été retirée.' })
  @ApiNotFoundResponse({
    description: 'La prestation n’existe pas ici, ou ce praticien n’y est pas affecté.',
  })
  public async remove(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Param('staffId', ParseUUIDPipe) staffId: string,
  ): Promise<void> {
    return this.assignments.remove(serviceId, staffId);
  }
}
