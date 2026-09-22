import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Locale } from '@spa/shared';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  ListNotificationTemplatesQueryDto,
  NotificationTemplateDto,
  NotificationTemplateListDto,
  NotificationTemplateParamsDto,
  NotificationTemplatePreviewDto,
  PreviewNotificationTemplateDto,
  SaveNotificationTemplateDto,
  toNotificationTemplateDto,
  toNotificationTemplateListDto,
  toNotificationTemplatePreviewDto,
  toPreviewDraft,
  toTemplateSource,
  toTemplateTarget,
} from './dto/notification-template.dto';
import { NotificationTemplatesService } from './notification-templates.service';

/**
 * La personnalisation des messages de l'établissement — #69, CDC §1.4.
 *
 * | Route | Rôle | Ce qu'elle fait |
 * |---|---|---|
 * | `GET /notification-templates` | `STAFF` | les modèles effectifs, et le vocabulaire des variables |
 * | `GET /notification-templates/:type/:channel/:locale` | `STAFF` | le modèle effectif d'un message |
 * | `PUT /notification-templates/:type/:channel/:locale` | `MANAGER` | écrit la personnalisation |
 * | `DELETE /notification-templates/:type/:channel/:locale` | `MANAGER` | revient au modèle par défaut |
 * | `POST /notification-templates/:type/:channel/:locale/preview` | `STAFF` | l'aperçu rendu, du modèle effectif ou d'un brouillon |
 *
 * ## La langue est entrée dans le chemin — #854
 *
 * Un modèle est désormais désigné par **trois** coordonnées, et non deux : c'est
 * ce que dit l'unique `(tenant_id, type, channel, locale)`. Les trois routes
 * unitaires portent donc `:locale`, et la forme sans langue n'existe plus — elle
 * aurait dû choisir un défaut, et ce défaut se serait glissé silencieusement dans
 * un `PUT`.
 *
 * `GET /notification-templates` garde sa forme nue et rend **les deux langues**,
 * avec un filtre `?locale=` facultatif pour l'écran qui n'en édite qu'une.
 *
 * ## L'aperçu, et pourquoi `POST` sur une opération sans effet
 *
 * Parce qu'il porte un **corps** : le brouillon qu'on veut voir avant de
 * l'enregistrer. Un `GET` ne peut pas le transporter, et le passer en paramètre
 * de requête aurait mis vingt mille caractères de HTML dans une URL — donc dans
 * les journaux d'accès. `POST` sans écriture est la forme retenue par la même
 * logique ailleurs dans le produit ; le `200` plutôt qu'un `201` dit qu'aucune
 * ressource n'a été créée.
 *
 * Il se lit à `STAFF`, comme les deux lectures : voir ce qui partira est une
 * question de comptoir. Ce n'est pas une écriture, même avec un brouillon —
 * rien n'est enregistré, et le brouillon ne vient de nulle part ailleurs que du
 * corps de la requête.
 *
 * ## Pourquoi lire à `STAFF` et écrire à `MANAGER`
 *
 * C'est le partage déjà en vigueur chez `catalog` et chez les jours de fermeture
 * d'`availability`, et il tient ici pour la même raison. Lire répond à une
 * question de comptoir — « qu'est-ce que ma cliente a reçu, exactement ? » — qui
 * se pose au téléphone, pendant qu'elle attend. Écrire engage l'établissement
 * auprès de **toutes** ses clientes à venir : c'est un geste de responsable, au
 * même titre que changer le prix d'une prestation.
 *
 * Ce n'est pas `ADMIN`, à la différence de `PATCH /tenant` : le fuseau horaire et
 * la devise d'un salon sont structurels — les changer réinterprète tout un
 * agenda —, alors qu'une formule de politesse se corrige et se re-corrige.
 *
 * ## Une route séparée du journal d'envois, et non un sous-chemin
 *
 * `GET /notifications` rend des **traces** ; celle-ci rend de la
 * **configuration**. Les deux n'ont ni le même cycle de vie, ni le même volume,
 * ni les mêmes droits, et `/notifications/templates` aurait laissé croire qu'un
 * modèle est un envoi.
 *
 * ## Ni `:tenantId`, ni identifiant de ligne
 *
 * L'établissement vient du jeton vérifié, jamais du chemin (tenant-isolation §2),
 * et un modèle se désigne par ce qu'il est — un message, un canal — et non par
 * l'identifiant d'une ligne qui peut ne pas exister. C'est ce qui rend `PUT`
 * naturel : la ressource est le couple, pas la ligne.
 *
 * ## Pourquoi `PUT` et non `PATCH`
 *
 * Parce que le corps est **complet** : objet, HTML et texte partent ensemble. Un
 * `PATCH` aurait permis de réécrire le HTML sans son texte, c'est-à-dire de
 * laisser un e-mail dont les deux versions disent des choses différentes — ce que
 * personne ne relit avant l'envoi. La ressource est remplacée d'un bloc, et
 * l'opération est idempotente.
 */
@ApiTags('notifications')
@Controller({ path: 'notification-templates', version: '1' })
export class NotificationTemplatesController {
  public constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({
    summary: 'Lire les modèles de messages de l’établissement',
    description:
      'Les modèles effectifs — la personnalisation du salon quand il y en a une, le modèle par ' +
      'défaut de la plateforme sinon —, dans les deux langues, accompagnés de la liste close ' +
      'des variables substituables. `?locale=` restreint à une langue. Un message sans aucun ' +
      'modèle n’y figure pas.',
  })
  @ApiOkResponse({ type: NotificationTemplateListDto })
  @ApiBadRequestResponse({ description: 'Langue inconnue — le champ fautif est nommé.' })
  @ApiUnauthorizedResponse({ description: 'Jeton absent ou invalide.' })
  @ApiForbiddenResponse({ description: 'Rôle insuffisant.' })
  public async list(
    @Query() query: ListNotificationTemplatesQueryDto,
  ): Promise<NotificationTemplateListDto> {
    return toNotificationTemplateListDto(await this.templates.list(query.locale as Locale | undefined));
  }

  @Get(':type/:channel/:locale')
  @AuthAtLeast('STAFF')
  @ApiOperation({
    summary: 'Lire le modèle effectif d’un message, dans une langue',
    description:
      'Le modèle qui partira réellement pour ce message, ce canal et cette langue, avec son ' +
      'origine. Sur le canal SMS, la réponse porte le coût mesuré du modèle en segments — ' +
      'mesuré sur le rendu de référence de **cette** langue.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({
    description: 'Type, canal ou langue inconnu — le champ fautif est nommé.',
  })
  @ApiNotFoundResponse({
    description:
      'Ni personnalisation, ni modèle par défaut pour ce message dans cette langue. Le modèle ' +
      'de l’autre langue n’est jamais servi à sa place.',
  })
  public async get(@Param() params: NotificationTemplateParamsDto): Promise<NotificationTemplateDto> {
    const { type, channel, locale } = toTemplateTarget(params);

    return toNotificationTemplateDto(await this.templates.get(type, channel, locale));
  }

  /**
   * L'aperçu rendu d'un modèle — #854.
   *
   * Sans corps, il montre ce qui partirait aujourd'hui ; avec un brouillon, ce
   * que ce brouillon produirait, **sans rien écrire**. Les valeurs substituées
   * sont celles de référence : aucune cliente réelle n'apparaît dans un écran de
   * configuration.
   */
  @Post(':type/:channel/:locale/preview')
  @HttpCode(200)
  @AuthAtLeast('STAFF')
  @ApiOperation({
    summary: 'Voir le message tel qu’il partira',
    description:
      'Rend le modèle avec ses variables substituées et ses dates formatées dans la langue ' +
      'demandée — ce que la lecture ne montre pas, puisqu’elle rend les balises. Corps vide : ' +
      'le modèle effectif. Corps portant `text` : ce brouillon-là, validé comme à ' +
      'l’enregistrement mais **non enregistré**.',
  })
  @ApiOkResponse({ type: NotificationTemplatePreviewDto })
  @ApiBadRequestResponse({
    description:
      'Type, canal ou langue inconnu, ou brouillon invalide — variable inconnue, section non ' +
      'refermée, objet manquant sur le canal e-mail, plafond de segments dépassé.',
  })
  @ApiUnauthorizedResponse({ description: 'Jeton absent ou invalide.' })
  @ApiForbiddenResponse({ description: 'Rôle insuffisant.' })
  @ApiNotFoundResponse({
    description: 'Aucun modèle pour ce message dans cette langue, et aucun brouillon soumis.',
  })
  public async preview(
    @Param() params: NotificationTemplateParamsDto,
    @Body() body: PreviewNotificationTemplateDto,
  ): Promise<NotificationTemplatePreviewDto> {
    const { type, channel, locale } = toTemplateTarget(params);

    return toNotificationTemplatePreviewDto(
      await this.templates.preview(type, channel, locale, toPreviewDraft(body)),
    );
  }

  /**
   * Écrit la personnalisation d'un message.
   *
   * Le modèle est validé **avant** d'être écrit : variables connues, sections
   * refermées, et — sur le canal SMS — coût borné. Un modèle refusé n'a pas
   * touché la base, sans quoi un salon pourrait enregistrer un modèle que la
   * chaîne d'envoi refuserait ensuite de rendre, privant ses clientes de leurs
   * confirmations.
   */
  @Put(':type/:channel/:locale')
  @AuthAtLeast('MANAGER')
  @ApiOperation({
    summary: 'Personnaliser le modèle d’un message, dans une langue',
    description:
      'Remplace le modèle d’un bloc, pour cette langue et elle seule — l’autre langue ne ' +
      'bouge pas. Les variables se notent `{{nom}}` et sont échappées au rendu HTML ; ' +
      '`{{#nom}}…{{/nom}}` garde un fragment seulement si la variable est renseignée. La ' +
      'version texte brut est obligatoire. Sur le canal SMS, l’objet et le corps HTML sont ' +
      'ignorés et stockés vides, et le coût est mesuré sur le rendu de référence de cette langue.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Variable inconnue, section non refermée, champ manquant, langue inconnue, ou modèle de ' +
      'SMS dépassant le plafond de segments — la réponse nomme la cause.',
  })
  @ApiUnauthorizedResponse({ description: 'Jeton absent ou invalide.' })
  @ApiForbiddenResponse({ description: 'Rôle insuffisant — l’écriture demande `MANAGER`.' })
  public async save(
    @Param() params: NotificationTemplateParamsDto,
    @Body() body: SaveNotificationTemplateDto,
  ): Promise<NotificationTemplateDto> {
    const { type, channel, locale } = toTemplateTarget(params);

    return toNotificationTemplateDto(
      await this.templates.save(type, channel, locale, toTemplateSource(body)),
    );
  }

  /**
   * Revient au modèle par défaut de la plateforme.
   *
   * `200` et non `204` : la réponse porte le modèle **désormais** effectif, qui
   * est ce qu'un écran a besoin d'afficher juste après le clic. Un `204` aurait
   * obligé le front à relire aussitôt ce qu'il vient de changer.
   *
   * Idempotent : effacer une personnalisation qui n'existe pas laisse
   * l'établissement dans l'état demandé.
   */
  @Delete(':type/:channel/:locale')
  @AuthAtLeast('MANAGER')
  @ApiOperation({
    summary: 'Revenir au modèle par défaut, dans une langue',
    description:
      'Efface la personnalisation de l’établissement pour cette langue — l’autre langue ne ' +
      'bouge pas. Le modèle de la plateforme de cette langue reprend effet, et la réponse le ' +
      'porte.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({
    description: 'Type, canal ou langue inconnu — le champ fautif est nommé.',
  })
  @ApiNotFoundResponse({
    description:
      'La personnalisation a été effacée, mais aucun modèle par défaut ne prend le relais pour ' +
      'ce message dans cette langue.',
  })
  public async reset(
    @Param() params: NotificationTemplateParamsDto,
  ): Promise<NotificationTemplateDto> {
    const { type, channel, locale } = toTemplateTarget(params);

    return toNotificationTemplateDto(await this.templates.reset(type, channel, locale));
  }
}
