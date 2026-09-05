import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AvailabilityQueryService } from './availability.query.service';
import { AvailabilityDto, AvailabilityQueryDto } from './dto/availability.dto';
import { AuthAtLeast } from '../identity/auth.decorator';

/**
 * `GET /api/v1/availability` — les créneaux libres, côté back-office (#35).
 *
 * ## Deux surfaces pour un seul moteur
 *
 * Le premier critère de #35 nomme cette route ; le contexte du même ticket
 * nomme son autre appelant — « le tunnel de réservation interroge cet endpoint
 * en continu ». Or le tunnel n'a pas de jeton : on réserve sans compte (#37), et
 * l'établissement s'y désigne par un slug d'URL résolu par
 * `TenantScopeMiddleware`. Une seule route ne peut pas servir les deux, et la
 * faire dépendre de la présence d'un en-tête aurait mêlé deux appelants qui
 * n'ont pas les mêmes droits — la façon la plus sûre de se tromper.
 *
 * D'où deux contrôleurs, exactement comme le catalogue en a deux
 * (`ServicesController` et `PublicServicesController`) : celui-ci pour l'agenda
 * du back-office, `PublicAvailabilityController` pour le tunnel. Ils partagent
 * le service, le DTO et le cache ; ils ne partagent pas leur porte.
 *
 * ## Le seuil est `STAFF`, le plus bas
 *
 * Un praticien doit voir les créneaux libres pour caler un rendez-vous
 * téléphoné. Ce n'est pas une décision de gestion, c'est la lecture de l'agenda
 * — le même seuil que la liste des absences.
 *
 * ## Ce que cette route ne rend jamais
 *
 * Aucun `tenantId`, aucun motif d'absence, aucune identité de cliente : la
 * réponse ne porte que des instants et des identifiants de praticiens. C'est ce
 * qui permet à la route publique de servir exactement la même charge utile.
 */
@ApiTags('availability')
@Controller({ path: 'availability', version: '1' })
export class AvailabilityController {
  public constructor(private readonly availability: AvailabilityQueryService) {}

  /**
   * Les créneaux libres d'une prestation sur une plage de dates.
   *
   * **200** avec toutes les journées demandées, y compris vides. Une plage sans
   * le moindre créneau n'est pas un 404 : un salon complet existe, et son
   * calendrier doit pouvoir le dire.
   *
   * **404** si la prestation est inconnue, retirée du catalogue, ou appartient à
   * un autre établissement — les trois sont indiscernables, faute de quoi cette
   * route devient une sonde d'existence (tenant-isolation §4).
   *
   * **422 `AVAILABILITY_RANGE_TOO_WIDE`** si la plage est inversée ou dépasse
   * trente et un jours. Chaque date est bien écrite : c'est leur écart qui n'est
   * pas servable, et le calcul se faisant à la demande, une plage non bornée est
   * un déni de service à une seule requête.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les créneaux libres d’une prestation' })
  @ApiOkResponse({ type: AvailabilityDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description: 'Prestation introuvable, ou retirée du catalogue.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Plage inversée ou de plus de 31 jours (`AVAILABILITY_RANGE_TOO_WIDE`).',
  })
  public async slots(@Query() query: AvailabilityQueryDto): Promise<AvailabilityDto> {
    return this.availability.slotsFor({
      serviceId: query.serviceId,
      // Étalé plutôt que posé à `undefined` : sous `exactOptionalPropertyTypes`,
      // un champ présent et à `undefined` n'est pas un champ absent, et le
      // service distingue les deux — c'est ce qui sépare la clé de cache
      // « tous praticiens » de celle d'un praticien nommé.
      ...(query.staffId !== undefined && { staffId: query.staffId }),
      from: query.from,
      to: query.to,
      // Le report au comptoir vise nécessairement un créneau qui chevauche le
      // rendez-vous qu'il déplace (#442). L'étalement est celui du `staffId`
      // ci-dessus, et pour la même raison : c'est la présence du champ, et non
      // sa valeur, qui décide du contournement du cache.
      ...(query.excludeAppointmentId !== undefined && {
        excludeAppointmentId: query.excludeAppointmentId,
      }),
    });
  }
}
