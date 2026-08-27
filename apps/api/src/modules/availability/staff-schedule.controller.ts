import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { SetStaffScheduleDto, StaffScheduleDto } from './dto/staff-schedule.dto';
import { StaffScheduleService } from './staff-schedule.service';

/**
 * Horaires récurrents d'un praticien — CDC §1.4, gestion du personnel.
 *
 * Mêmes seuils que le catalogue, et pour la même raison : la lecture au rang
 * `STAFF` — un praticien doit pouvoir consulter son planning et celui de
 * l'équipe pour s'organiser —, l'écriture au rang `MANAGER`, parce que fixer les
 * heures de quelqu'un est une décision de gestion.
 *
 * ## Pourquoi `PUT` et pas de `DELETE`
 *
 * La ressource est la **semaine**, pas la plage. Un `PUT` la remplace en entier :
 * c'est la seule forme où l'invariante « aucune plage ne se recouvre » se
 * vérifie sur ce que l'utilisateur voit à l'écran, et non sur un état
 * intermédiaire qui dépendrait de l'ordre des appels. Retirer une plage, c'est
 * renvoyer la semaine sans elle ; vider la semaine, c'est envoyer `entries: []`.
 *
 * Le chemin est `staff/:staffId/schedule` : l'horaire n'existe pas sans le
 * praticien qu'il décrit, et une route `/schedules/:id` obligerait le
 * back-office à connaître un identifiant de plus que celui qu'il affiche déjà.
 */
@ApiTags('availability')
@Controller({ path: 'staff/:staffId/schedule', version: '1' })
export class StaffScheduleController {
  public constructor(private readonly schedules: StaffScheduleService) {}

  /**
   * La semaine de travail d'un praticien.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'un praticien
   * d'un autre établissement : distinguer les deux confirmerait l'existence du
   * second (tenant-isolation §4).
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire les horaires récurrents d’un praticien' })
  @ApiOkResponse({ type: StaffScheduleDto })
  @ApiNotFoundResponse({
    description: 'Aucun praticien de cet établissement ne porte cet identifiant.',
  })
  public async byStaff(
    @Param('staffId', ParseUUIDPipe) staffId: string,
  ): Promise<StaffScheduleDto> {
    return this.schedules.forStaff(staffId);
  }

  @Put()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Remplacer la semaine de travail d’un praticien' })
  @ApiOkResponse({ type: StaffScheduleDto })
  @ApiNotFoundResponse({
    description: 'Aucun praticien de cet établissement ne porte cet identifiant.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Deux plages du même jour se recouvrent.',
  })
  public async replace(
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Body() body: SetStaffScheduleDto,
  ): Promise<StaffScheduleDto> {
    return this.schedules.replace(staffId, body.entries);
  }
}
