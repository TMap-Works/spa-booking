import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from './auth.decorator';
import { TenantDto, UpdateTenantDto } from './dto/tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * Paramétrage de l'établissement depuis le back-office — CDC §1.4, #343.
 *
 * ## Pourquoi `/tenant` au singulier, et sans identifiant
 *
 * Il n'y a **qu'un** établissement joignable par cette route : celui du jeton.
 * Un chemin `/tenants/:id` aurait ouvert la question « et si l'identifiant est
 * celui d'un autre salon ? » à chaque méthode, et cette question n'a pas à
 * exister ici (tenant-isolation §2). Aucune méthode ne prend d'identifiant
 * d'établissement, et il n'y a pas de champ pour en glisser un : le
 * `ValidationPipe` global refuse tout champ non déclaré au DTO.
 *
 * ## Le seuil, et pourquoi il est haut
 *
 * `ADMIN` en lecture comme en écriture. L'adresse et les horaires publiés sont
 * ce que le monde entier voit du salon : les modifier n'est pas une décision de
 * planning mais d'identité de l'établissement, au même titre que son nom, son
 * fuseau et sa devise — que la même charge utile porte. Ouvrir la lecture plus
 * bas que l'écriture aurait par ailleurs offert au rang `MANAGER` un formulaire
 * qu'il ne peut pas soumettre.
 */
@ApiTags('identity')
@Controller({ path: 'tenant', version: '1' })
export class TenantSettingsController {
  public constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @AuthAtLeast('ADMIN')
  @ApiOperation({ summary: 'Lire les réglages de l’établissement' })
  @ApiOkResponse({ type: TenantDto })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  public async current(): Promise<TenantDto> {
    return this.settings.currentTenant();
  }

  /**
   * Modification partielle : **absent** vaut « ne touche pas », `null` vaut
   * « efface ». `PATCH` et non `PUT` pour cette raison exacte — un `PUT`
   * obligerait l'écran de réglages à renvoyer des champs qu'il n'affiche pas,
   * et le premier oubli les effacerait.
   *
   * Les horaires font exception à l'intérieur du `PATCH` : ils se remplacent en
   * entier, parce que leur seule invariante — aucune plage ne se recouvre —
   * porte sur l'ensemble. `openingHours: []` efface la semaine publiée.
   */
  @Patch()
  @AuthAtLeast('ADMIN')
  @ApiOperation({ summary: 'Modifier les réglages de l’établissement' })
  @ApiOkResponse({ type: TenantDto })
  @ApiBadRequestResponse({ description: 'Charge utile invalide.' })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  @ApiUnprocessableEntityResponse({
    description:
      'Plage d’ouverture incohérente : fermeture antérieure à l’ouverture, ou ' +
      'deux plages du même jour qui se recouvrent.',
  })
  public async update(@Body() body: UpdateTenantDto): Promise<TenantDto> {
    return this.settings.update(body);
  }
}
