import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LOCALES, type Locale } from '@spa/shared';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { TEMPLATE_VARIABLES } from '../notification-template';
import {
  NOTIFICATION_TEMPLATE_ORIGINS,
  type NotificationChannel,
  type NotificationTemplatePreview,
  type NotificationTemplateSource,
  type NotificationTemplateView,
  type NotificationType,
} from '../notifications.types';
import {
  NOTIFICATION_CHANNEL_FILTERS,
  NOTIFICATION_TYPE_FILTERS,
  toDomainChannel,
  toDomainType,
} from './list-notifications.dto';

/**
 * Les modèles de messages du back-office — `/api/v1/notification-templates` (#69).
 *
 * Écart assumé, tranché en #554 : ces formes appartiennent au contrat d'API, et #510 n'a pas pu les
 * y prendre pour la raison la plus simple qui soit : le contrat **ne les décrit
 * pas**. `packages/shared/src/schemas/notification.ts` porte la notification, ses
 * préférences et le filtre du journal, mais ni le modèle de message, ni son
 * contenu, ni le coût qu'il représente sur le canal SMS. Il n'y a donc pas
 * d'import à faire mais des schémas à écrire, dans un paquet hors de l'empreinte
 * de ce ticket — et l'écriture n'est pas mécanique : elle demande de trancher la
 * casse des types et des canaux, que la colonne écrit en majuscules et que le
 * contrat nomme en minuscules (premier point de vigilance de #510, même constat
 * que dans `list-notifications.dto.ts`).
 *
 * ## Ce que ce contrat porte, et qui n'est pas anodin
 *
 * Le **contenu** des messages, avec ses balises. C'est la seule surface du module
 * qui expose autre chose qu'un statut, et c'est sans risque pour une raison de
 * fond : un modèle porte `{{client}}`, jamais un nom de cliente. Il n'y a aucune
 * donnée personnelle à protéger ici, contrairement au journal d'envois voisin.
 *
 * Il porte aussi le **coût** du modèle sur le canal SMS. Ce n'est pas une
 * commodité d'affichage : c'est ce qui rend visible qu'une apostrophe
 * typographique vient de faire passer le message de un segment à deux, donc de
 * doubler la facture du salon (notifications §5).
 */

/**
 * Les origines telles que la **réponse** les nomme — le vocabulaire du contrat.
 *
 * En minuscules, comme les types et les canaux, et **dérivées** de la liste du
 * domaine plutôt que recopiées : une troisième origine s'y répercuterait sans
 * qu'on y pense.
 */
export const NOTIFICATION_TEMPLATE_ORIGIN_VALUES = NOTIFICATION_TEMPLATE_ORIGINS.map((origin) =>
  origin.toLowerCase(),
) as readonly string[];

/**
 * Le message, le canal et la **langue**, tels que l'URL les désigne.
 *
 * Une classe de paramètres plutôt que trois `@Param()` nus : `ValidationPipe` la
 * traverse, et un `booking_confirmations` mal orthographié rend alors un 400 qui
 * nomme le champ, là où une conversion à la main aurait produit un `undefined`
 * silencieux jusqu'au dépôt.
 *
 * ## Pourquoi la langue est dans le **chemin** et non en paramètre de requête
 *
 * Parce qu'elle fait partie de l'identité de la ressource depuis #854 : un modèle
 * n'est plus « la confirmation par e-mail », c'est « la confirmation par e-mail
 * en anglais ». L'unique de la table le dit — `(tenant_id, type, channel, locale)` —
 * et un `PUT` dont la cible dépendrait d'un paramètre de requête aurait rendu
 * l'idempotence de l'opération confuse : deux URL différentes,
 * `?locale=fr` et rien du tout, auraient écrit la même ligne ou deux, selon le
 * défaut retenu.
 *
 * La langue est écrite en **minuscules**, comme dans le contrat (`LOCALES`) et
 * comme la colonne la stocke. Il n'y a donc rien à convertir, à la différence du
 * type et du canal que la base écrit en majuscules.
 */
export class NotificationTemplateParamsDto {
  @ApiProperty({ enum: NOTIFICATION_TYPE_FILTERS })
  @IsIn(NOTIFICATION_TYPE_FILTERS, { message: 'type : valeur inconnue' })
  public type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNEL_FILTERS })
  @IsIn(NOTIFICATION_CHANNEL_FILTERS, { message: 'channel : valeur inconnue' })
  public channel!: string;

  @ApiProperty({ enum: LOCALES })
  @IsIn(LOCALES, { message: `locale : langue attendue parmi ${LOCALES.join(', ')}` })
  public locale!: string;
}

/** Le triplet désigné, dans le vocabulaire du domaine. */
export function toTemplateTarget(params: NotificationTemplateParamsDto): {
  type: NotificationType;
  channel: NotificationChannel;
  locale: Locale;
} {
  return {
    type: toDomainType(params.type),
    channel: toDomainChannel(params.channel),
    // Aucune conversion de casse : `LOCALES` est déjà le vocabulaire de la
    // colonne, et `@IsIn` vient de garantir que la valeur en fait partie.
    locale: params.locale as Locale,
  };
}

/**
 * Le filtre de la liste — `GET /notification-templates?locale=en`.
 *
 * Facultatif, et l'absence n'est pas un défaut implicite : elle rend **les deux
 * langues**. Un écran de réglages qui n'en montrerait qu'une laisserait croire
 * que l'autre n'existe pas, ce qui est précisément l'erreur que #854 corrige.
 */
export class ListNotificationTemplatesQueryDto {
  @ApiPropertyOptional({
    enum: LOCALES,
    description:
      'Restreint la liste à une langue. Absent, la réponse porte les modèles des ' +
      'deux langues — chacun avec la sienne dans `locale`.',
  })
  @IsOptional()
  @IsIn(LOCALES, { message: `locale : langue attendue parmi ${LOCALES.join(', ')}` })
  public locale?: string;
}

/** Largeur de `notification_templates.subject`, telle que le schéma la déclare. */
const SUBJECT_MAX = 200;

/**
 * Borne applicative des corps — `body_html` et `body_text` sont des `TEXT`.
 *
 * La colonne n'impose rien ; cette borne existe pour que la requête soit refusée
 * avant d'atteindre la base, et non pour économiser de la place. Vingt mille
 * caractères laissent largement la place à une mise en page d'e-mail complète et
 * arrêtent net un corps qui ne peut être qu'un collage accidentel.
 */
const BODY_MAX = 20_000;

/**
 * Ce qu'un salon écrit — le corps de
 * `PUT /notification-templates/:type/:channel/:locale`.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas, en particulier un `tenantId` glissé dans le
 * corps, qui est le scénario de fuite le plus direct (tenant-isolation §2).
 * L'établissement vient du jeton vérifié, et de lui seul.
 *
 * Ni `type`, ni `channel`, ni `locale` : les trois sont dans le chemin. Les
 * accepter aussi dans le corps aurait ouvert la question de savoir lequel gagne.
 */
export class SaveNotificationTemplateDto {
  // Facultatif **ici**, et exigé par le service sur le canal e-mail : la
  // contrainte dépend du canal, qui est dans le chemin et non dans le corps. La
  // déclarer obligatoire refuserait tous les modèles de SMS, qui n'ont pas
  // d'objet.
  @ApiPropertyOptional({
    maxLength: SUBJECT_MAX,
    description:
      'Objet de l’e-mail — **obligatoire** sur le canal e-mail, où un `Subject` vide fait ' +
      'un message que personne ne sait relire. Ignoré, et stocké vide, sur le canal SMS.',
    // Le défaut de la plateforme, au mot près (#911). Un exemple d'OpenAPI est
    // ce qu'un intégrateur recopie : y laisser l'ancien « est confirmé » aurait
    // remis en circulation la phrase que ce ticket retire.
    example: 'À confirmer par le salon : votre rendez-vous du {{date}} — {{salon}}',
  })
  @IsOptional()
  @IsString({ message: 'subject : chaîne attendue' })
  @MaxLength(SUBJECT_MAX, { message: `subject : ${SUBJECT_MAX} caractères au plus` })
  public subject?: string;

  @ApiPropertyOptional({
    maxLength: BODY_MAX,
    description:
      'Corps HTML. Les variables y sont échappées au rendu. Ignoré — et stocké vide — sur le ' +
      'canal SMS. Vide sur le canal e-mail produit un message en texte seul, ce qui est licite.',
  })
  @IsOptional()
  @IsString({ message: 'html : chaîne attendue' })
  @MaxLength(BODY_MAX, { message: `html : ${BODY_MAX} caractères au plus` })
  public html?: string;

  @ApiProperty({
    maxLength: BODY_MAX,
    description:
      'Version texte brut — obligatoire. Elle accompagne systématiquement le HTML : un e-mail ' +
      'qui n’a que du HTML est pénalisé par les filtres anti-spam. C’est aussi le corps du SMS.',
    example: '{{salon}} : rendez-vous du {{date}} ({{fuseau}}) enregistré, à confirmer par le salon.',
  })
  @IsString({ message: 'text : chaîne attendue' })
  // Le corps texte n'est jamais facultatif, sur aucun canal : c'est le quatrième
  // critère d'acceptation de #69, et l'invariant que la colonne `body_text`
  // suppose. `MinLength(1)` plutôt qu'un `@IsNotEmpty()` : ce dernier accepte
  // une chaîne d'espaces, qui ferait un e-mail vide.
  @MinLength(1, { message: 'text : la version texte brut est obligatoire' })
  @MaxLength(BODY_MAX, { message: `text : ${BODY_MAX} caractères au plus` })
  public text!: string;
}

/** Le contenu soumis, dans le vocabulaire du domaine. */
export function toTemplateSource(dto: SaveNotificationTemplateDto): NotificationTemplateSource {
  return { subject: dto.subject ?? '', html: dto.html ?? '', text: dto.text ?? '' };
}

/** Ce qu'un modèle de SMS coûtera — la mesure, pas une estimation de style. */
export class SmsCostDto {
  @ApiProperty({
    enum: ['gsm_7', 'ucs_2'],
    description:
      'L’encodage retenu par l’opérateur. `ucs_2` dès qu’un caractère sort de l’alphabet ' +
      'GSM-7 — une apostrophe typographique suffit — et la capacité tombe alors de 160 à 70.',
  })
  public encoding!: string;

  @ApiProperty({
    example: 124,
    description: 'Septets en GSM-7, unités de code UTF-16 en UCS-2. Les deux ne se comparent pas.',
  })
  public units!: number;

  @ApiProperty({ example: 1, description: 'Nombre de SMS réellement facturés.' })
  public segments!: number;
}

/** Un modèle effectif, tel que le back-office le lit. */
export class NotificationTemplateDto {
  @ApiProperty({ enum: NOTIFICATION_TYPE_FILTERS })
  public type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNEL_FILTERS })
  public channel!: string;

  @ApiProperty({
    enum: LOCALES,
    description:
      'La langue de ce modèle. Un message a un texte par langue, et `origin` se lit par ' +
      'langue aussi : un salon peut avoir réécrit son français et laissé son anglais au défaut.',
  })
  public locale!: string;

  @ApiProperty({
    enum: NOTIFICATION_TEMPLATE_ORIGIN_VALUES,
    description:
      '`platform` : le modèle par défaut, versionné avec l’application. `tenant` : ce que ' +
      'l’établissement a écrit. Seul un `tenant` peut être ramené au défaut.',
  })
  public origin!: string;

  @ApiProperty({ description: 'Objet de l’e-mail. Vide sur le canal SMS.' })
  public subject!: string;

  @ApiProperty({ description: 'Corps HTML. Vide sur le canal SMS.' })
  public html!: string;

  @ApiProperty({ description: 'Version texte brut — doublon de l’e-mail, corps du SMS.' })
  public text!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Dernière écriture par l’établissement, UTC. Absent sur un modèle de plateforme.',
  })
  public updatedAt?: string;

  @ApiPropertyOptional({
    type: SmsCostDto,
    description: 'Coût mesuré du modèle. Absent sur le canal e-mail, où il n’y a pas de facture.',
  })
  public sms?: SmsCostDto;
}

/** L'enveloppe de la liste — un objet, jamais un tableau nu. */
export class NotificationTemplateListDto {
  @ApiProperty({ type: [NotificationTemplateDto] })
  public items!: NotificationTemplateDto[];

  @ApiProperty({
    type: [String],
    example: [...TEMPLATE_VARIABLES],
    description:
      'Les variables substituables, sous la forme `{{nom}}`. La liste est close : un modèle ' +
      'qui en nomme une autre est refusé à l’enregistrement.',
  })
  public variables!: string[];
}

/**
 * Un modèle du domaine, sérialisé.
 *
 * Les instants sortent en ISO 8601 UTC suffixés `Z`, et les champs nuls sont
 * **omis** plutôt que rendus à `null` : c'est la règle du contrat d'API, et un
 * `null` explicite échouerait à la validation côté front.
 */
export function toNotificationTemplateDto(
  template: NotificationTemplateView,
): NotificationTemplateDto {
  return {
    type: template.type.toLowerCase(),
    channel: template.channel.toLowerCase(),
    // Déjà en minuscules : la langue est le seul des trois vocabulaires que la
    // base et le contrat écrivent de la même façon (#844).
    locale: template.locale,
    origin: template.origin.toLowerCase(),
    subject: template.source.subject,
    html: template.source.html,
    text: template.source.text,
    ...(template.updatedAt === null ? {} : { updatedAt: template.updatedAt.toISOString() }),
    ...(template.sms === null
      ? {}
      : {
          sms: {
            encoding: template.sms.encoding.toLowerCase(),
            units: template.sms.units,
            segments: template.sms.segments,
          },
        }),
  };
}

/** La liste, sérialisée, accompagnée du vocabulaire des variables. */
export function toNotificationTemplateListDto(
  templates: readonly NotificationTemplateView[],
): NotificationTemplateListDto {
  return {
    items: templates.map(toNotificationTemplateDto),
    variables: [...TEMPLATE_VARIABLES],
  };
}

/**
 * Le corps — facultatif — de l'aperçu, `POST …/:type/:channel/:locale/preview`.
 *
 * ## Un brouillon se reconnaît à la présence de `text`
 *
 * Corps vide, ou corps sans `text` : l'aperçu porte sur le modèle **effectif**,
 * celui qui partirait maintenant. Corps avec `text` : il porte sur ce
 * brouillon-là, sans rien écrire en base.
 *
 * Le critère est `text` et non « un champ quelconque », et ce n'est pas
 * arbitraire : la version texte brut est obligatoire sur les deux canaux — c'est
 * le quatrième critère d'acceptation de #69, et l'invariant que la colonne
 * `body_text` suppose. Un brouillon qui n'en porterait pas ne serait pas
 * enregistrable, donc n'est pas un brouillon.
 *
 * Les trois champs sont facultatifs **ici** parce qu'un corps vide est une
 * demande valide. Ce qui est exigé d'un brouillon l'est dans le service, qui lui
 * fait traverser exactement la validation de `save` : un aperçu plus permissif
 * que l'écriture montrerait un message que l'écriture refuse.
 */
export class PreviewNotificationTemplateDto {
  @ApiPropertyOptional({
    maxLength: SUBJECT_MAX,
    description: 'Objet du brouillon. Ignoré si `text` est absent.',
  })
  @IsOptional()
  @IsString({ message: 'subject : chaîne attendue' })
  @MaxLength(SUBJECT_MAX, { message: `subject : ${SUBJECT_MAX} caractères au plus` })
  public subject?: string;

  @ApiPropertyOptional({
    maxLength: BODY_MAX,
    description: 'Corps HTML du brouillon. Ignoré si `text` est absent.',
  })
  @IsOptional()
  @IsString({ message: 'html : chaîne attendue' })
  @MaxLength(BODY_MAX, { message: `html : ${BODY_MAX} caractères au plus` })
  public html?: string;

  @ApiPropertyOptional({
    maxLength: BODY_MAX,
    description:
      'Version texte brut du brouillon. **C’est elle qui distingue un aperçu de brouillon ' +
      'd’un aperçu du modèle effectif** : absente, l’aperçu porte sur ce qui partirait ' +
      'aujourd’hui.',
  })
  @IsOptional()
  @IsString({ message: 'text : chaîne attendue' })
  @MinLength(1, { message: 'text : la version texte brut ne peut pas être vide' })
  @MaxLength(BODY_MAX, { message: `text : ${BODY_MAX} caractères au plus` })
  public text?: string;
}

/**
 * Le brouillon soumis, ou `undefined` s'il n'y en a pas.
 *
 * `undefined` et non un objet vide : c'est la distinction que le service lit, et
 * un `{ subject: '', html: '', text: '' }` aurait été un brouillon vide — donc
 * refusé par la validation — au lieu d'une absence de brouillon.
 */
export function toPreviewDraft(
  dto: PreviewNotificationTemplateDto,
): NotificationTemplateSource | undefined {
  return dto.text === undefined
    ? undefined
    : { subject: dto.subject ?? '', html: dto.html ?? '', text: dto.text };
}

/** Le message rendu — ce qu'un aperçu montre. */
export class RenderedNotificationDto {
  @ApiProperty({ description: 'Objet de l’e-mail, variables substituées. Vide sur le canal SMS.' })
  public subject!: string;

  @ApiProperty({
    description:
      'Corps HTML, variables substituées et **échappées**. Vide sur le canal SMS — un ' +
      'expéditeur SNS ne lit que le texte.',
  })
  public html!: string;

  @ApiProperty({
    description:
      'Version texte brut. Sur le canal SMS, c’est le corps du message, déjà écourté au ' +
      'plafond de segments comme il le sera à l’envoi.',
  })
  public text!: string;
}

/** L'aperçu d'un modèle — #854. */
export class NotificationTemplatePreviewDto {
  @ApiProperty({ enum: NOTIFICATION_TYPE_FILTERS })
  public type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNEL_FILTERS })
  public channel!: string;

  @ApiProperty({ enum: LOCALES })
  public locale!: string;

  @ApiProperty({
    enum: NOTIFICATION_TEMPLATE_ORIGIN_VALUES,
    description:
      '`tenant` quand l’aperçu porte sur un brouillon ou sur la personnalisation du salon, ' +
      '`platform` quand il porte sur le modèle par défaut.',
  })
  public origin!: string;

  @ApiProperty({ type: RenderedNotificationDto })
  public rendered!: RenderedNotificationDto;

  @ApiPropertyOptional({
    type: SmsCostDto,
    description: 'Coût mesuré. Absent sur le canal e-mail, où il n’y a pas de facture.',
  })
  public sms?: SmsCostDto;
}

/**
 * Un aperçu du domaine, sérialisé.
 *
 * Les valeurs substituées sont celles **de référence** — une cliente fictive, un
 * rendez-vous fictif. Aucune donnée d'un rendez-vous réel n'apparaît dans cette
 * réponse, et c'est délibéré : un écran de configuration n'a pas à exposer une
 * cliente pour montrer la forme d'un message.
 */
export function toNotificationTemplatePreviewDto(
  preview: NotificationTemplatePreview,
): NotificationTemplatePreviewDto {
  return {
    type: preview.type.toLowerCase(),
    channel: preview.channel.toLowerCase(),
    locale: preview.locale,
    origin: preview.origin.toLowerCase(),
    rendered: {
      subject: preview.rendered.subject,
      html: preview.rendered.html,
      text: preview.rendered.text,
    },
    ...(preview.sms === null
      ? {}
      : {
          sms: {
            encoding: preview.sms.encoding.toLowerCase(),
            units: preview.sms.units,
            segments: preview.sms.segments,
          },
        }),
  };
}
