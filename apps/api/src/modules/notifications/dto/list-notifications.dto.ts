import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

import { NOTIFICATION_LIST_MAX, type NotificationSearch } from '../notifications.service';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationStatus,
  type NotificationTrace,
  type NotificationType,
} from '../notifications.types';

/**
 * Le journal d'envois du back-office — `GET /api/v1/notifications` (#70).
 *
 * Écart assumé, tranché en #554 : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/notification.ts` (`notificationSchema`,
 * `notificationListQuerySchema`), et #510 n'a pu monter ni l'une ni l'autre.
 * Deux empêchements, un par sens :
 *
 * 1. **la requête.** `notificationListQuerySchema` déclare
 *    `statuses: z.array(...)` sans coercition, là où Express rend une `string`
 *    pour `?statuses=sent` et un tableau pour la forme répétée. Le filtre le
 *    plus courant du comptoir — un seul statut — sortirait donc en 400. Aucun
 *    schéma de requête du contrat ne coerce, `myAppointmentsQuerySchema`
 *    excepté, et c'est le même constat que sur `appointmentListQuerySchema` ;
 * 2. **la réponse.** `notificationSchema` porte type, canal et statut **en
 *    minuscules**, là où cette route émet la casse de l'énumération PostgreSQL.
 *    C'est le premier point de vigilance de #510, et une assertion de
 *    compilation contre `z.input<...>` ne se pose donc pas ici : les
 *    énumérations du contrat sont des `z.enum`, dont le type d'entrée est
 *    l'union en minuscules, et non `string` comme celui des schémas de réception
 *    (`receivedAppointmentStatusSchema`). Reste à faire côté contrat : donner à
 *    ce module ses trois schémas de réception, comme `appointments` et
 *    `identity` ont les leurs.
 *
 * ## Ce que ce contrat ne porte pas
 *
 * **Aucune coordonnée, aucun contenu de message.** Ni l'adresse à laquelle le
 * message est parti, ni ce qu'il disait. La table n'en contient pas — c'est la
 * règle du module depuis #68 — et cette réponse ne pourrait donc pas en
 * produire, quand bien même un écran le demanderait (CDC §5.1,
 * notifications §7).
 *
 * **Ni `dedupe_key`, ni `provider_message_id`.** La première est une mécanique
 * d'idempotence interne, la seconde une référence AWS. Ce qu'un comptoir a
 * besoin de savoir est « quel message, sur quel canal, parti ou non, quand, et
 * sinon pourquoi » ; le reste appartient au diagnostic d'exploitation, qui lit
 * les journaux.
 */

/**
 * Les types tels que la **requête** les nomme — le vocabulaire du contrat.
 *
 * En minuscules, à la différence de `NOTIFICATION_TYPES` du module, qui porte la
 * casse de l'énumération PostgreSQL. Même raison qu'`APPOINTMENT_STATUS_FILTERS`
 * chez `appointments` : c'est ce que le front envoie, parce que c'est ce que
 * `notificationTypeSchema` de `@spa/shared` déclare.
 *
 * **Dérivées** et non recopiées : un quatrième message ajouté à l'énumération se
 * répercuterait ici sans qu'on y pense, là où une copie aurait laissé la requête
 * refuser un type que la réponse peut rendre.
 */
export const NOTIFICATION_TYPE_FILTERS = NOTIFICATION_TYPES.map((type) =>
  type.toLowerCase(),
) as readonly string[];

/** Les canaux, même régime. */
export const NOTIFICATION_CHANNEL_FILTERS = NOTIFICATION_CHANNELS.map((channel) =>
  channel.toLowerCase(),
) as readonly string[];

/** Les statuts, même régime. */
export const NOTIFICATION_STATUS_FILTERS = NOTIFICATION_STATUSES.map((status) =>
  status.toLowerCase(),
) as readonly string[];

/**
 * Le vocabulaire du contrat, remis dans celui du domaine.
 *
 * Une mise en majuscules et rien d'autre — `reminder_24h` devient
 * `REMINDER_24H`. La conversion vit **à la frontière HTTP**, pour la raison qui
 * vaut chez `appointments` : passé ce point, aucune couche n'a plus à se
 * demander dans quelle casse elle compare un type.
 */
export function toDomainType(filter: string): NotificationType {
  return filter.toUpperCase() as NotificationType;
}

/** Idem pour un canal. */
export function toDomainChannel(filter: string): NotificationChannel {
  return filter.toUpperCase() as NotificationChannel;
}

/** Idem pour un statut. */
export function toDomainStatus(filter: string): NotificationStatus {
  return filter.toUpperCase() as NotificationStatus;
}

/**
 * Ce qu'un comptoir peut demander du journal — et rien de plus.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas, en particulier un `tenantId` glissé
 * dans la chaîne de requête, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). L'établissement vient du jeton vérifié, et de lui seul.
 *
 * Il n'y a pas non plus de `recipientUserId` : `notificationListQuerySchema` ne
 * le déclare pas, et l'ajouter unilatéralement ferait diverger l'API de son
 * contrat. Filtrer le journal par cliente est un besoin réel — la fiche client
 * du back-office — mais il commence par une évolution du paquet partagé.
 */
export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restreint le journal à un rendez-vous. C’est le filtre du tiroir de ' +
      'rendez-vous du back-office, et l’usage dominant de cette route.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'appointmentId : identifiant invalide' })
  public appointmentId?: string;

  @ApiPropertyOptional({ enum: NOTIFICATION_TYPE_FILTERS })
  @IsOptional()
  @IsIn(NOTIFICATION_TYPE_FILTERS, { message: 'type : valeur inconnue' })
  public type?: string;

  @ApiPropertyOptional({ enum: NOTIFICATION_CHANNEL_FILTERS })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNEL_FILTERS, { message: 'channel : valeur inconnue' })
  public channel?: string;

  @ApiPropertyOptional({
    enum: NOTIFICATION_STATUS_FILTERS,
    isArray: true,
    description:
      'Un ou plusieurs statuts. `?statuses=failed` isole ce qui n’est pas parti — ' +
      'la question que le comptoir se pose vraiment.',
  })
  @IsOptional()
  // Une valeur unique en chaîne de requête arrive en `string`, plusieurs en
  // `string[]`. La conversion est explicite parce que le pipe global ne convertit
  // pas implicitement — sans elle, `?statuses=failed` échouerait sur `@IsArray`.
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(NOTIFICATION_STATUS_FILTERS, { each: true, message: 'statuses : valeur inconnue' })
  public statuses?: string[];
}

/** Les filtres de la requête, dans le vocabulaire du domaine. */
export function toNotificationSearch(dto: ListNotificationsQueryDto): NotificationSearch {
  return {
    ...(dto.appointmentId === undefined ? {} : { appointmentId: dto.appointmentId }),
    ...(dto.type === undefined ? {} : { type: toDomainType(dto.type) }),
    ...(dto.channel === undefined ? {} : { channel: toDomainChannel(dto.channel) }),
    ...(dto.statuses === undefined ? {} : { statuses: dto.statuses.map(toDomainStatus) }),
  };
}

/**
 * La trace d'un envoi, telle que le back-office la lit.
 *
 * Les instants sortent en ISO 8601 UTC suffixés `Z` — c'est la règle du contrat
 * d'API, sans exception. La conversion au fuseau du salon est un geste
 * d'**affichage**, et elle a lieu là où l'affichage a lieu : dans le
 * back-office, qui connaît déjà le fuseau de l'établissement. Rendre ici une
 * heure locale obligerait chaque consommateur à deviner de quel fuseau elle
 * relève.
 */
export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Le rendez-vous annoncé, s’il y en a un.' })
  public appointmentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Le compte destinataire.' })
  public recipientUserId?: string;

  @ApiProperty({ enum: NOTIFICATION_TYPE_FILTERS })
  public type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNEL_FILTERS })
  public channel!: string;

  @ApiProperty({ enum: NOTIFICATION_STATUS_FILTERS })
  public status!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Instant d’envoi voulu, UTC. Absent hors rappel planifié.',
  })
  public scheduledFor?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Instant d’envoi effectif, UTC.' })
  public sentAt?: string;

  @ApiProperty({ example: 1, description: 'Nombre de tentatives, reprises comprises.' })
  public attemptCount!: number;

  @ApiPropertyOptional({
    description: 'Motif du dernier échec, tronqué à 500 caractères. Absent si rien n’a échoué.',
  })
  public failureReason?: string;

  @ApiProperty({ format: 'date-time' })
  public createdAt!: string;
}

/** L'enveloppe de la liste — un objet, jamais un tableau nu. */
export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] })
  public items!: NotificationDto[];

  @ApiProperty({
    example: NOTIFICATION_LIST_MAX,
    description: 'Plafond serveur appliqué à cette lecture.',
  })
  public limit!: number;
}

/**
 * Une trace du domaine, sérialisée.
 *
 * Les champs nuls sont **omis** plutôt que rendus à `null` : le contrat partagé
 * les déclare `.optional()`, et un `null` explicite y échouerait à la validation
 * côté front.
 */
export function toNotificationDto(trace: NotificationTrace): NotificationDto {
  return {
    id: trace.id,
    ...(trace.appointmentId === null ? {} : { appointmentId: trace.appointmentId }),
    ...(trace.recipientUserId === null ? {} : { recipientUserId: trace.recipientUserId }),
    type: trace.type.toLowerCase(),
    channel: trace.channel.toLowerCase(),
    status: trace.status.toLowerCase(),
    ...(trace.scheduledFor === null ? {} : { scheduledFor: trace.scheduledFor.toISOString() }),
    ...(trace.sentAt === null ? {} : { sentAt: trace.sentAt.toISOString() }),
    attemptCount: trace.attemptCount,
    ...(trace.failureReason === null ? {} : { failureReason: trace.failureReason }),
    createdAt: trace.createdAt.toISOString(),
  };
}

/** La liste, sérialisée. */
export function toNotificationListDto(
  traces: readonly NotificationTrace[],
): NotificationListDto {
  return { items: traces.map(toNotificationDto), limit: NOTIFICATION_LIST_MAX };
}
