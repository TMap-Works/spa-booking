import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
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
import {
  ReportExportDto,
  ReportExportParamsDto,
  toReportExportDto,
} from './dto/report-export.dto';
import { ReportWindowQueryDto, toReportWindow } from './dto/report-window.dto';
import { DailyRevenueReportDto, toDailyRevenueReportDto } from './dto/revenue-report.dto';
import { ReportExportService } from './export/report-export.service';
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
 * | `POST /reports/export` | `MANAGER` | produit le CSV des trois rapports et rend son URL présignée |
 * | `GET /reports/export/:exportId` | `MANAGER` | re-signe un export déjà produit |
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
 * ## Ni `:tenantId`, ni identifiant d'établissement en chemin
 *
 * L'établissement vient du jeton vérifié, jamais du chemin
 * (tenant-isolation §2). Les trois routes de lecture ne prennent **aucun**
 * identifiant, nulle part : il n'y a rien à confondre entre deux salons, et pas
 * un 404 de traversée à écrire.
 *
 * `GET /reports/export/:exportId` est la seule exception, et elle ne relâche
 * rien : l'identifiant désigne un export **dans le préfixe de l'appelant**, la
 * clé S3 étant recomposée à partir du `tenant_id` du jeton
 * (`export/report-export.key.ts`). Le même identifiant présenté par un salon
 * voisin désigne donc un objet qui n'existe pas chez lui — **404**, jamais 403,
 * jamais l'URL (tenant-isolation §4).
 *
 * ## Quatre codes d'erreur, et pas un de plus
 *
 * | Code | Quand |
 * |---|---|
 * | 400 | une borne ou un identifiant mal formés — le `ValidationPipe` nomme le champ |
 * | 422 | fenêtre inversée, vide, ou de plus d'un an |
 * | 404 | l'établissement du jeton n'existe plus, ou l'export n'est pas le sien |
 * | 503 | aucun bucket d'export n'est branché sur cet environnement |
 *
 * Le 422 n'est pas un 400 déguisé : les deux bornes sont individuellement bien
 * formées, c'est leur relation ou leur étendue qui est refusée (api-module §5).
 * Le 503 n'est pas un 500 déguisé non plus : le code fonctionne, c'est
 * l'environnement qui n'a pas d'entrepôt.
 */
@ApiTags('reporting')
@Controller({ path: 'reports', version: '1' })
export class ReportingController {
  public constructor(
    private readonly reporting: ReportingService,
    private readonly exports: ReportExportService,
  ) {}

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

  /**
   * Produit le CSV des trois rapports et rend son URL présignée — #563.
   *
   * ## Pourquoi `POST` et non `GET`
   *
   * Parce que l'appel **crée quelque chose** : un objet déposé dans le bucket,
   * sous une clé tirée au sort, que le cycle de vie purgera. Ce n'est pas une
   * lecture, et servir cela en `GET` aurait fait fabriquer un fichier à chaque
   * préchargement de navigateur, à chaque rejeu de cache et à chaque bouton
   * « précédent ».
   *
   * `201` et non `200`, pour la même raison — la réponse annonce une ressource
   * qui n'existait pas avant l'appel.
   *
   * La fenêtre reste sur la **chaîne de requête**, comme celle des trois routes
   * de lecture. Elle n'est pas la description d'un corps à créer : c'est le même
   * `from`/`to` que l'écran vient d'employer, et le passer en corps aurait obligé
   * l'appelant à connaître deux façons d'exprimer une période selon la route.
   *
   * ## Ce que la réponse contient, et ce qu'elle tait
   *
   * `{ id, url, expiresAt, filename }` — pas de clé, pas de bucket, pas de
   * `tenant_id`. L'URL est un **porteur** valable au plus quinze minutes ; un
   * écran l'ouvre et l'oublie.
   */
  @Post('export')
  @HttpCode(HttpStatus.CREATED)
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Produit l’export CSV du reporting et rend son URL présignée' })
  @ApiCreatedResponse({ type: ReportExportDto })
  @ApiBadRequestResponse({ description: 'Borne mal formée — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({ description: 'Fenêtre inversée, vide, ou de plus d’un an.' })
  @ApiNotFoundResponse({ description: 'Établissement introuvable.' })
  @ApiServiceUnavailableResponse({
    description: 'Aucun entrepôt d’export n’est branché sur cet environnement.',
  })
  public async createExport(@Query() query: ReportWindowQueryDto): Promise<ReportExportDto> {
    return toReportExportDto(await this.exports.create(toReportWindow(query)));
  }

  /**
   * Re-signe un export déjà produit — l'URL est éphémère, le fichier ne l'est
   * pas encore.
   *
   * `GET` cette fois, et sans ambiguïté : rien n'est créé, le même identifiant
   * rend le même fichier. C'est ce qui permet de rouvrir un lien périmé sans
   * reproduire l'export — donc sans déposer un second objet, et sans risquer un
   * fichier qui diffère du premier parce qu'une caisse est tombée entre-temps.
   *
   * **404 pour l'export d'un voisin**, jamais 403 : la clé est reconstruite sous
   * le préfixe de l'établissement du jeton, et un objet absent de ce préfixe est
   * indiscernable d'un objet qui n'a jamais existé. C'est la propriété que le
   * cinquième critère de #563 demande, et elle ne tient pas à une comparaison
   * d'identifiants mais à la forme même de la clé.
   */
  @Get('export/:exportId')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Re-signe un export déjà produit' })
  @ApiOkResponse({ type: ReportExportDto })
  @ApiBadRequestResponse({ description: 'Identifiant d’export mal formé.' })
  @ApiNotFoundResponse({ description: 'Aucun export à cet identifiant pour cet établissement.' })
  @ApiServiceUnavailableResponse({
    description: 'Aucun entrepôt d’export n’est branché sur cet environnement.',
  })
  public async resignExport(@Param() params: ReportExportParamsDto): Promise<ReportExportDto> {
    return toReportExportDto(await this.exports.resign(params.exportId));
  }
}
