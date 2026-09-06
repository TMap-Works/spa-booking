import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  AppointmentVolumeQueryDto,
  AppointmentVolumeReportDto,
  toAppointmentVolumeReportDto,
} from './dto/appointment-volume.dto';
import { NoShowReportDto, toNoShowReportDto } from './dto/no-show-report.dto';
import { ReportWindowQueryDto, toReportWindow } from './dto/report-window.dto';
import { DailyRevenueReportDto, toDailyRevenueReportDto } from './dto/revenue-report.dto';
import { ReportingService } from './reporting.service';

/**
 * Le reporting de base — CDC §1.4, « synthèse du revenu quotidien, volume de
 * rendez-vous, suivi des no-shows ».
 *
 * | Route | Rôle | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /reports/revenue` | `MANAGER` | le revenu quotidien, ventilé par moyen de paiement |
 * | `GET /reports/appointments` | `MANAGER` | le volume, par jour, par praticien ou par prestation |
 * | `GET /reports/no-shows` | `MANAGER` | le nombre et le taux de no-shows |
 *
 * ## Pourquoi `MANAGER` et non `STAFF`
 *
 * Ces trois routes rendent la **performance de l'établissement** : son chiffre
 * d'affaires jour par jour, et le rendement de chaque praticien. Ce n'est pas
 * une donnée de comptoir — la personne qui décroche le téléphone n'a besoin ni
 * du chiffre d'affaires du mois, ni de savoir combien de clientes son collègue a
 * vues. Le seuil est celui de `GET /customers/:id/export` chez `crm` et de
 * `PATCH /customers/:id/status` : ce qui relève de la conduite du salon plutôt
 * que de sa tenue quotidienne.
 *
 * Le mettre à `ADMIN` aurait été trop haut : le CDC range explicitement le
 * reporting dans le back-office, et un gérant de salon n'est pas toujours
 * l'administrateur du compte.
 *
 * **Aucune route publique.** Un rapport est un agrégat d'exploitation ; une
 * surface anonyme, même bornée, donnerait le chiffre d'affaires d'un salon à qui
 * connaît son slug.
 *
 * ## Ni `:tenantId`, ni identifiant en chemin
 *
 * L'établissement vient du jeton vérifié, jamais du chemin
 * (tenant-isolation §2). Ce module va plus loin que ses voisins : il ne prend
 * **aucun** identifiant, nulle part. Il n'y a donc rien à confondre entre deux
 * salons, et pas un seul 404 de traversée à écrire — le seul 404 de ce
 * contrôleur est celui de l'établissement disparu sous la requête.
 *
 * ## Trois codes d'erreur, et pas un de plus
 *
 * | Code | Quand |
 * |---|---|
 * | 400 | une borne mal formée — le `ValidationPipe` nomme le champ |
 * | 422 | fenêtre inversée, vide, ou de plus d'un an |
 * | 404 | l'établissement du jeton n'existe plus |
 *
 * Le 422 n'est pas un 400 déguisé : les deux bornes sont individuellement bien
 * formées, c'est leur relation ou leur étendue qui est refusée (api-module §5).
 */
@ApiTags('reporting')
@Controller({ path: 'reports', version: '1' })
export class ReportingController {
  public constructor(private readonly reporting: ReportingService) {}

  /**
   * Le revenu quotidien de la fenêtre, ventilé par moyen de paiement.
   *
   * Les journées sont découpées dans le fuseau du salon, et le fuseau employé
   * est rendu avec le rapport : un écran n'a pas à le supposer, et deux
   * établissements de fuseaux différents ne se lisent pas de la même façon.
   *
   * Les jours sans recette sont **absents** de la liste plutôt que rendus à
   * zéro : un rapport ne fabrique pas les jours où le salon était fermé, et
   * c'est l'écran qui décide s'il veut une ligne vide au calendrier.
   */
  @Get('revenue')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Revenu quotidien ventilé par moyen de paiement' })
  @ApiOkResponse({ type: DailyRevenueReportDto })
  @ApiBadRequestResponse({ description: 'Borne mal formée — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre inversée, vide, ou de plus d’un an.' })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  public async revenue(@Query() query: ReportWindowQueryDto): Promise<DailyRevenueReportDto> {
    return toDailyRevenueReportDto(await this.reporting.dailyRevenue(toReportWindow(query)));
  }

  /**
   * Le volume de rendez-vous de la fenêtre, sur l'axe demandé.
   *
   * `groupBy` vaut `day` par défaut — la lecture la plus courante d'un tableau
   * de bord, et la seule qui ne suppose aucune connaissance du catalogue ni de
   * l'équipe.
   *
   * La fenêtre porte sur la **date du rendez-vous**, pas sur celle de sa prise :
   * « combien de rendez-vous en mars » se lit sur mars.
   */
  @Get('appointments')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Volume de rendez-vous par période, praticien ou prestation' })
  @ApiOkResponse({ type: AppointmentVolumeReportDto })
  @ApiBadRequestResponse({ description: 'Borne ou axe invalide — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre inversée, vide, ou de plus d’un an.' })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  public async appointments(
    @Query() query: AppointmentVolumeQueryDto,
  ): Promise<AppointmentVolumeReportDto> {
    return toAppointmentVolumeReportDto(
      await this.reporting.appointmentVolume(toReportWindow(query), query.groupBy ?? 'day'),
    );
  }

  /**
   * Le nombre et le taux de no-shows de la fenêtre.
   *
   * Le taux est celui des rendez-vous **arrivés à échéance** — annulations
   * exclues du dénominateur, rendez-vous à venir également. Les quatre comptes
   * sont rendus à côté pour qu'un écran qui préfère une autre définition la
   * calcule lui-même.
   */
  @Get('no-shows')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Nombre et taux de no-shows' })
  @ApiOkResponse({ type: NoShowReportDto })
  @ApiBadRequestResponse({ description: 'Borne mal formée — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre inversée, vide, ou de plus d’un an.' })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  public async noShows(@Query() query: ReportWindowQueryDto): Promise<NoShowReportDto> {
    return toNoShowReportDto(await this.reporting.noShows(toReportWindow(query)));
  }
}
