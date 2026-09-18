import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationType,
} from '../notifications.types';

/**
 * Le corps de `POST /api/v1/interne/notifications/dispatch` — la route d'envoi
 * interne (#799).
 *
 * ## Ce contrat ne se décide pas ici
 *
 * Il est écrit dans `infra/terraform/modules/notifications/README.md`, section
 * « Le contrat de `dispatch_url` » : « `POST` d'un corps `{ messageId, message }`,
 * où `message` est l'enveloppe `NotificationMessage` telle que le producteur l'a
 * publiée ». La Lambda d'envoi le sert déjà — `lambda/dispatcher/index.mjs`
 * compose exactement cet objet. Ce fichier **s'y conforme**, il ne le
 * redéfinit pas : le sixième critère d'acceptation le dit au mot près.
 *
 * ## La casse est celle du domaine, pas celle du contrat front
 *
 * `BOOKING_CONFIRMATION`, `EMAIL` — en majuscules, comme
 * `dto/reminder-sweep.dto.ts` et pour la même raison : le destinataire de cette
 * route est une fonction Lambda qui recopie l'enveloppe telle qu'elle est sortie
 * de SQS, et la Lambda valide elle-même contre `NOTIFICATION_TYPES` et
 * `NOTIFICATION_CHANNELS` en majuscules. Traduire en minuscules ici pour
 * retraduire là-bas aurait ajouté deux conversions et un endroit de plus où se
 * tromper, sur un chemin qu'aucun navigateur ne voit.
 *
 * Les valeurs sont **dérivées** des constantes du domaine et non recopiées : un
 * quatrième message ajouté à l'énumération serait accepté ici sans qu'on y
 * pense, là où une copie l'aurait fait refuser en 400 — donc acquitter et
 * perdre, la Lambda comptant tout autre `4xx` en échec permanent.
 *
 * ## Un corps refusé est un message **perdu**, et c'est voulu
 *
 * `ValidationPipe` est global avec `whitelist` et `forbidNonWhitelisted` : un
 * champ non déclaré ici fait sortir la requête en 400, que la Lambda acquitte en
 * `PermanentFailures`. C'est la bonne conduite — « un JSON invalide ne se répare
 * pas en le relisant » — et c'est la raison pour laquelle cette validation doit
 * rester **exactement** aussi stricte que le contrat et pas davantage.
 *
 * ## Aucune coordonnée n'y figure, et il n'y a pas de place pour une
 *
 * Sept champs, tous des identifiants, un type, un canal et une échéance. C'est
 * la règle de `NotificationMessage` : « le message ne porte rien qui puisse
 * dériver ; il désigne, et l'expéditeur relit ». Un corps qui porterait une
 * adresse l'aurait fait transiter par SQS puis par les journaux d'une Lambda
 * (CDC §5.1, notifications §7) — et `forbidNonWhitelisted` la refuserait.
 */

export class DispatchMessageDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'L’établissement dont la portée s’ouvre pour traiter ce message. La seule chose de ' +
      'l’enveloppe qui ne se relise pas : le consommateur n’a ni jeton ni requête dont hériter.',
  })
  @IsUUID('4', { message: 'message.tenantId : identifiant invalide' })
  public tenantId!: string;

  @ApiProperty({
    description: 'Clé d’idempotence de la livraison, déterministe pour un message et un canal.',
    example: 'appointment:0f0a…:BOOKING_CONFIRMATION:EMAIL',
  })
  @IsString()
  @IsNotEmpty({ message: 'message.dedupeKey : obligatoire' })
  // La colonne `notifications.dedupe_key` est bornée au schéma ; refuser ici ce
  // que la base refuserait à l'écriture évite une erreur Prisma en 500 — que la
  // Lambda rejouerait cinq fois pour rien.
  @MaxLength(255, { message: 'message.dedupeKey : trop longue' })
  public dedupeKey!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Le rendez-vous annoncé. **Absent ou nul pour `PASSWORD_RESET`**, qui n’en annonce aucun ' +
      '(#809) ; obligatoire pour les trois messages du CDC §1.4.',
  })
  // `@IsOptional` couvre l'absence comme le nul, pour la raison qui vaut déjà
  // pour `scheduledFor` : une enveloppe sérialisée par `JSON.stringify` porte
  // `null`, là où un producteur qui omet le champ n'envoie rien. Refuser l'une
  // des deux formes perdrait la moitié des messages en 400, que la Lambda
  // compterait en échec permanent.
  //
  // La validation ne peut pas exiger le champ « selon le type » : ce serait une
  // règle métier dans un DTO, et elle vivrait ici en second exemplaire de ce que
  // le renderer décide déjà. Un message de rendez-vous sans rendez-vous échoue
  // donc au rendu, en `NotificationContextGoneError` — 404, acquitté,
  // `PermanentFailures`, exactement le sort d'un rendez-vous disparu.
  @IsOptional()
  @IsUUID('4', { message: 'message.appointmentId : identifiant invalide' })
  public appointmentId?: string | null;

  @ApiProperty({
    format: 'uuid',
    description: 'Le compte destinataire ; l’adresse se relit dessus au moment d’envoyer.',
  })
  @IsUUID('4', { message: 'message.recipientUserId : identifiant invalide' })
  public recipientUserId!: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES })
  @IsIn(NOTIFICATION_TYPES, { message: 'message.type : valeur inconnue' })
  public type!: NotificationType;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  @IsIn(NOTIFICATION_CHANNELS, { message: 'message.channel : valeur inconnue' })
  public channel!: NotificationChannel;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description:
      'Échéance voulue de l’envoi, UTC — le début du rendez-vous moins 24 heures pour un ' +
      'rappel. Absente ou nulle pour un message immédiat.',
  })
  // `@IsOptional` couvre **l'absence comme le nul**, et les deux arrivent : le
  // balayage du rappel J-1 omet le champ (`toReminderMessageDto`), là où une
  // enveloppe d'abonné sérialisée par `JSON.stringify` porte `null`. Refuser
  // l'une des deux formes aurait perdu la moitié des messages en 400.
  @IsOptional()
  @IsISO8601({}, { message: 'message.scheduledFor : date ISO 8601 attendue' })
  public scheduledFor?: string | null;

  @ApiPropertyOptional({
    description:
      'Le jeton de réinitialisation en clair — **`PASSWORD_RESET` uniquement**, et la seule ' +
      'valeur de cette enveloppe qui ne soit pas un identifiant (#809). Il ne se relit pas : la ' +
      'base n’en garde que l’empreinte SHA-256, par exigence du deuxième critère d’acceptation. ' +
      'Il se périme en trente minutes, meurt au premier usage, et n’est journalisé par aucun ' +
      'chemin de la chaîne.',
    maxLength: 4096,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'message.passwordResetToken : vide' })
  // Bornée comme tout jeton reçu, et pour la même raison que
  // `AcceptInvitationDto` : un corps arbitrairement long n'a pas à atteindre une
  // vérification de signature. La borne est celle du contrat partagé.
  @MaxLength(4096, { message: 'message.passwordResetToken : trop long' })
  public passwordResetToken?: string;
}

export class DispatchNotificationDto {
  @ApiProperty({
    description:
      'L’identifiant SQS de la livraison. Sert de corrélation entre le journal de la Lambda ' +
      'et celui de l’API — il n’est ni la clé d’idempotence, ni stocké.',
    example: '059f36b4-87a3-44ab-83d2-661975830a7d',
  })
  @IsString()
  @IsNotEmpty({ message: 'messageId : obligatoire' })
  @MaxLength(255, { message: 'messageId : trop long' })
  public messageId!: string;

  @ApiProperty({ type: DispatchMessageDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DispatchMessageDto)
  public message!: DispatchMessageDto;
}

/**
 * L'enveloppe validée, dans le vocabulaire du domaine.
 *
 * La seule conversion est celle de l'échéance : le domaine manipule des `Date`,
 * le transport des chaînes ISO. `undefined` et `null` deviennent tous deux
 * `null` — `NotificationMessage.scheduledFor` ne connaît pas l'absence, et un
 * message immédiat n'a pas d'échéance à porter.
 */
export function toNotificationMessage(dto: DispatchMessageDto): NotificationMessage {
  return {
    tenantId: dto.tenantId,
    dedupeKey: dto.dedupeKey,
    // `undefined` et `null` deviennent tous deux `null`, comme pour l'échéance :
    // `NotificationMessage.appointmentId` ne connaît pas l'absence, et « pas de
    // rendez-vous » est ce que `null` veut dire depuis #809.
    appointmentId: dto.appointmentId ?? null,
    recipientUserId: dto.recipientUserId,
    type: dto.type,
    channel: dto.channel,
    scheduledFor:
      dto.scheduledFor === undefined || dto.scheduledFor === null
        ? null
        : new Date(dto.scheduledFor),
    // Omis plutôt que posé à `undefined` : sous `exactOptionalPropertyTypes`, un
    // `undefined` explicite n'est pas la même chose qu'une propriété absente, et
    // le type déclare la seconde.
    ...(dto.passwordResetToken === undefined
      ? {}
      : { passwordResetToken: dto.passwordResetToken }),
  };
}

/**
 * Ce que la route rend quand le message est parti.
 *
 * Un seul champ, et il n'est pas lu par l'appelant réel : la Lambda décide sur
 * le **statut** seul, et annule le corps sans le désérialiser pour rendre la
 * connexion au pool. Il existe pour qui recette la route à la main, et pour que
 * la réponse ne soit pas un `200` muet dont on ne sait pas ce qu'il a fait.
 *
 * Ni identifiant de notification, ni accusé du fournisseur : le premier est une
 * mécanique interne, le second une référence AWS que le journal d'expédition
 * porte déjà. Un corps de réponse est ce qui traverse le plus de journaux
 * intermédiaires ; il n'a à porter que ce dont son lecteur a besoin.
 */
export class DispatchResultDto {
  @ApiProperty({ example: 'sent', enum: ['sent'] })
  public outcome!: string;
}
