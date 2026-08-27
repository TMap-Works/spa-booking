import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  CreateStaffTimeOffDto,
  ListStaffTimeOffQueryDto,
  StaffTimeOffDto,
  UpdateStaffTimeOffDto,
} from './dto/staff-time-off.dto';
import { StaffTimeOffService } from './staff-time-off.service';

/**
 * Plages bloquées et congés du personnel — CDC §2.3, #33.
 *
 * ## Seuils d'accès
 *
 * Lecture au rang `STAFF`, écriture au rang `MANAGER` — les mêmes seuils que le
 * catalogue, et pour la même raison : un praticien doit voir le planning
 * d'absences pour s'organiser, poser une absence est une décision de gestion.
 * **Aucune route publique** : cette ressource porte des motifs internes, et le
 * parcours client n'a rien à savoir de la raison pour laquelle un créneau
 * manque — il ne voit que le créneau manquant.
 *
 * ## Un `DELETE`, contrairement au catalogue
 *
 * Une prestation se désactive parce que des rendez-vous passés la référencent et
 * que le reporting doit continuer à savoir ce qui a été vendu. Une absence
 * annulée n'a **aucune valeur d'historique** : personne ne compte les congés qui
 * n'ont pas eu lieu, et aucune ligne ne la référence. Lui donner un `isActive`
 * obligerait chaque lecture du moteur de créneaux à filtrer dessus — un filtre
 * oublié rendrait un praticien indisponible pour un congé qu'il a annulé.
 *
 * Le chemin est `staff-time-off` : « time off » couvre l'absence d'une heure
 * comme celle de trois semaines, là où `leaves` ou `holidays` auraient laissé
 * croire à deux ressources distinctes pour un seul intervalle.
 */
@ApiTags('availability')
@Controller({ path: 'staff-time-off', version: '1' })
export class StaffTimeOffController {
  public constructor(private readonly timeOff: StaffTimeOffService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les absences sur une fenêtre' })
  @ApiOkResponse({ type: [StaffTimeOffDto] })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre vide, inversée ou de plus d’un an.' })
  public async list(@Query() query: ListStaffTimeOffQueryDto): Promise<StaffTimeOffDto[]> {
    return this.timeOff.list(
      { from: new Date(query.from), to: new Date(query.to) },
      query.staffId,
    );
  }

  /**
   * Une absence, par identifiant.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'une absence
   * d'un autre établissement : distinguer les deux confirmerait l'existence de
   * la seconde (tenant-isolation §4).
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire une absence' })
  @ApiOkResponse({ type: StaffTimeOffDto })
  @ApiNotFoundResponse({ description: 'Aucune absence de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<StaffTimeOffDto> {
    return this.timeOff.byId(id);
  }

  /**
   * Pose une plage bloquée ou un congé.
   *
   * Une seule route pour les deux : c'est le même intervalle, seule sa durée
   * change. Le praticien d'un autre établissement rend **404**, refusé par la
   * clé étrangère composite `(tenant_id, staff_id)` et non par un contrôle
   * applicatif qui aurait eu à choisir entre 403 et 404.
   */
  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Poser une plage bloquée ou un congé' })
  @ApiCreatedResponse({ type: StaffTimeOffDto })
  @ApiNotFoundResponse({ description: 'Aucun praticien de cet établissement ne porte cet identifiant.' })
  @ApiUnprocessableEntityResponse({ description: 'Fin avant début, ou absence de plus d’un an.' })
  public async create(@Body() body: CreateStaffTimeOffDto): Promise<StaffTimeOffDto> {
    return this.timeOff.create({
      staffId: body.staffId,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      // Étalé plutôt que posé à `undefined` : sous `exactOptionalPropertyTypes`,
      // un champ **présent et à `undefined`** n'est pas un champ absent, et le
      // service distingue les deux — c'est ce qui fait qu'un motif omis ne
      // s'écrit pas comme un motif effacé.
      ...(body.reason !== undefined && { reason: body.reason }),
    });
  }

  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Déplacer une absence, ou en changer le motif' })
  @ApiOkResponse({ type: StaffTimeOffDto })
  @ApiNotFoundResponse({ description: 'Aucune absence de cet établissement ne porte cet identifiant.' })
  @ApiUnprocessableEntityResponse({ description: 'Fin avant début, ou absence de plus d’un an.' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStaffTimeOffDto,
  ): Promise<StaffTimeOffDto> {
    return this.timeOff.update(id, {
      ...(body.startsAt !== undefined && { startsAt: new Date(body.startsAt) }),
      ...(body.endsAt !== undefined && { endsAt: new Date(body.endsAt) }),
      ...(body.reason !== undefined && { reason: body.reason }),
    });
  }

  /** Retire une absence — le praticien redevient proposable sur ces créneaux. */
  @Delete(':id')
  @AuthAtLeast('MANAGER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirer une absence' })
  @ApiNoContentResponse({ description: 'Absence retirée.' })
  @ApiNotFoundResponse({ description: 'Aucune absence de cet établissement ne porte cet identifiant.' })
  public async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.timeOff.remove(id);
  }
}
