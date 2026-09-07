import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { ReminderSweepResult } from '../reminder-sweep.service';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationMessage,
} from '../notifications.types';

/**
 * La réponse du balayage horaire du rappel J-1 —
 * `POST /api/v1/notifications/reminders/sweep` (#71).
 *
 * ## Ce contrat n'est pas celui du front, et n'a pas la même casse
 *
 * `list-notifications.dto.ts` parle le vocabulaire du contrat partagé, en
 * minuscules, parce que son destinataire est un écran de back-office. Celui-ci a
 * pour destinataire la **Lambda de balayage**, qui recopie chaque enveloppe
 * telle quelle dans un message SQS — que la Lambda d'envoi de #67 valide ensuite
 * contre `NOTIFICATION_TYPES` et `NOTIFICATION_CHANNELS`, en majuscules.
 *
 * Traduire ici en minuscules pour retraduire là-bas aurait ajouté deux
 * conversions et un endroit de plus où se tromper, sur un chemin qu'aucun
 * navigateur ne voit. Les valeurs sont donc celles du domaine, et le sont
 * **dérivées** plutôt que recopiées.
 *
 * ## Aucune donnée personnelle n'y figure
 *
 * Des identifiants, un type, un canal, une échéance. Ni nom, ni adresse, ni
 * numéro : c'est la règle de `NotificationMessage`, et cette réponse n'est que
 * sa sérialisation. Une enveloppe qui porterait une coordonnée la ferait
 * transiter par SQS puis par un journal de Lambda (CDC §5.1, notifications §7).
 */
export class ReminderMessageDto {
  @ApiProperty({ format: 'uuid', description: 'L’établissement dont le consommateur ouvrira la portée.' })
  public tenantId!: string;

  @ApiProperty({
    description: 'Clé d’idempotence de la livraison, déterministe pour un rendez-vous et un canal.',
    example: 'appointment:0f0a…:REMINDER_24H:EMAIL',
  })
  public dedupeKey!: string;

  @ApiProperty({ format: 'uuid' })
  public appointmentId!: string;

  @ApiProperty({ format: 'uuid', description: 'Le compte destinataire ; l’adresse se relit dessus à l’envoi.' })
  public recipientUserId!: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES })
  public type!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  public channel!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Échéance voulue de l’envoi, UTC — le début du rendez-vous moins 24 heures.',
  })
  public scheduledFor?: string;
}

/** Ce qu'un balayage a produit, et de quoi le superviser. */
export class ReminderSweepDto {
  @ApiProperty({ format: 'date-time', description: 'Instant de référence du balayage, UTC.' })
  public sweptAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Borne basse **incluse** de la fenêtre, UTC.' })
  public from!: string;

  @ApiProperty({ format: 'date-time', description: 'Borne haute **exclue** de la fenêtre, UTC.' })
  public to!: string;

  @ApiProperty({ example: 3, description: 'Nombre d’établissements visités.' })
  public tenantCount!: number;

  @ApiProperty({ example: 7, description: 'Nombre de rendez-vous retenus.' })
  public appointmentCount!: number;

  @ApiProperty({
    example: false,
    description:
      'Vrai si le plafond serveur a arrêté le balayage avant la fin — l’appelant doit le ' +
      'journaliser comme une anomalie, des rappels manquent.',
  })
  public truncated!: boolean;

  @ApiProperty({ type: [ReminderMessageDto] })
  public messages!: ReminderMessageDto[];
}

/**
 * Une enveloppe du domaine, sérialisée.
 *
 * `scheduledFor` nul est **omis** plutôt que rendu à `null` : c'est la
 * convention de `toNotificationDto`, et la validation de la Lambda d'envoi
 * accepte l'absence comme le nul.
 */
export function toReminderMessageDto(message: NotificationMessage): ReminderMessageDto {
  return {
    tenantId: message.tenantId,
    dedupeKey: message.dedupeKey,
    appointmentId: message.appointmentId,
    recipientUserId: message.recipientUserId,
    type: message.type,
    channel: message.channel,
    ...(message.scheduledFor === null ? {} : { scheduledFor: message.scheduledFor.toISOString() }),
  };
}

/** Le résultat du balayage, sérialisé. */
export function toReminderSweepDto(result: ReminderSweepResult): ReminderSweepDto {
  return {
    sweptAt: result.sweptAt.toISOString(),
    from: result.from.toISOString(),
    to: result.to.toISOString(),
    tenantCount: result.tenantCount,
    appointmentCount: result.appointmentCount,
    truncated: result.truncated,
    messages: result.messages.map(toReminderMessageDto),
  };
}
