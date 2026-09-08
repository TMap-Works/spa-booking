import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { ClosingDaysService } from './closing-days.service';
import {
  ClosingDaysDto,
  type SetClosingDaysBody,
  SetClosingDaysDto,
  setClosingDaysBody,
} from './dto/closing-days.dto';

/**
 * Jours de fermeture récurrents de l'établissement.
 *
 * Lecture au rang `STAFF`, écriture au rang `MANAGER` : savoir quand le salon
 * est fermé fait partie du travail de chacun, décider de la fermeture est une
 * décision de gestion.
 *
 * Une **seule ressource** — la liste — et donc un `PUT` sans identifiant : il
 * n'y a qu'une liste de jours fermés par établissement, et l'établissement vient
 * du jeton. Rouvrir un jour, c'est renvoyer la liste sans lui ; ouvrir toute la
 * semaine, c'est envoyer `weekdays: []`. Aucun `DELETE` n'a donc de sens ici.
 *
 * Le chemin est `closing-days` et non `tenant/closing-days` : toutes les routes
 * à jeton de l'API portent déjà sur l'établissement de l'appelant, et le répéter
 * dans l'URL laisserait croire qu'on peut en désigner un autre.
 */
@ApiTags('availability')
@Controller({ path: 'closing-days', version: '1' })
export class ClosingDaysController {
  public constructor(private readonly closingDays: ClosingDaysService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les jours de fermeture de l’établissement' })
  @ApiOkResponse({ type: ClosingDaysDto })
  public async list(): Promise<ClosingDaysDto> {
    return this.closingDays.list();
  }

  @Put()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Remplacer les jours de fermeture de l’établissement' })
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `SetClosingDaysDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: SetClosingDaysDto })
  @ApiOkResponse({ type: ClosingDaysDto })
  public async replace(
    @Body(setClosingDaysBody) body: SetClosingDaysBody,
  ): Promise<ClosingDaysDto> {
    return this.closingDays.replace(body.weekdays);
  }
}
