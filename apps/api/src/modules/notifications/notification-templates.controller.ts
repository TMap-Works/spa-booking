import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  NotificationTemplateDto,
  NotificationTemplateListDto,
  NotificationTemplateParamsDto,
  SaveNotificationTemplateDto,
  toNotificationTemplateDto,
  toNotificationTemplateListDto,
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
 * | `GET /notification-templates/:type/:channel` | `STAFF` | le modèle effectif d'un message |
 * | `PUT /notification-templates/:type/:channel` | `MANAGER` | écrit la personnalisation |
 * | `DELETE /notification-templates/:type/:channel` | `MANAGER` | revient au modèle par défaut |
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
      'défaut de la plateforme sinon —, accompagnés de la liste close des variables ' +
      'substituables. Un message sans aucun modèle n’y figure pas.',
  })
  @ApiOkResponse({ type: NotificationTemplateListDto })
  @ApiUnauthorizedResponse({ description: 'Jeton absent ou invalide.' })
  @ApiForbiddenResponse({ description: 'Rôle insuffisant.' })
  public async list(): Promise<NotificationTemplateListDto> {
    return toNotificationTemplateListDto(await this.templates.list());
  }

  @Get(':type/:channel')
  @AuthAtLeast('STAFF')
  @ApiOperation({
    summary: 'Lire le modèle effectif d’un message',
    description:
      'Le modèle qui partira réellement pour ce message et ce canal, avec son origine. Sur le ' +
      'canal SMS, la réponse porte le coût mesuré du modèle en segments.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({ description: 'Type ou canal inconnu — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description:
      'Ni personnalisation, ni modèle par défaut pour ce message — le cas de l’avis ' +
      'd’annulation tant qu’aucun modèle de plateforme ne le sert.',
  })
  public async get(@Param() params: NotificationTemplateParamsDto): Promise<NotificationTemplateDto> {
    const { type, channel } = toTemplateTarget(params);

    return toNotificationTemplateDto(await this.templates.get(type, channel));
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
  @Put(':type/:channel')
  @AuthAtLeast('MANAGER')
  @ApiOperation({
    summary: 'Personnaliser le modèle d’un message',
    description:
      'Remplace le modèle d’un bloc. Les variables se notent `{{nom}}` et sont échappées au ' +
      'rendu HTML ; `{{#nom}}…{{/nom}}` garde un fragment seulement si la variable est ' +
      'renseignée. La version texte brut est obligatoire. Sur le canal SMS, l’objet et le ' +
      'corps HTML sont ignorés et stockés vides.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Variable inconnue, section non refermée, champ manquant, ou modèle de SMS dépassant le ' +
      'plafond de segments — la réponse nomme la cause.',
  })
  @ApiUnauthorizedResponse({ description: 'Jeton absent ou invalide.' })
  @ApiForbiddenResponse({ description: 'Rôle insuffisant — l’écriture demande `MANAGER`.' })
  public async save(
    @Param() params: NotificationTemplateParamsDto,
    @Body() body: SaveNotificationTemplateDto,
  ): Promise<NotificationTemplateDto> {
    const { type, channel } = toTemplateTarget(params);

    return toNotificationTemplateDto(
      await this.templates.save(type, channel, toTemplateSource(body)),
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
  @Delete(':type/:channel')
  @AuthAtLeast('MANAGER')
  @ApiOperation({
    summary: 'Revenir au modèle par défaut',
    description:
      'Efface la personnalisation de l’établissement. Le modèle de la plateforme reprend ' +
      'effet, et la réponse le porte.',
  })
  @ApiOkResponse({ type: NotificationTemplateDto })
  @ApiBadRequestResponse({ description: 'Type ou canal inconnu — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description:
      'La personnalisation a été effacée, mais aucun modèle par défaut ne prend le relais pour ' +
      'ce message.',
  })
  public async reset(
    @Param() params: NotificationTemplateParamsDto,
  ): Promise<NotificationTemplateDto> {
    const { type, channel } = toTemplateTarget(params);

    return toNotificationTemplateDto(await this.templates.reset(type, channel));
  }
}
