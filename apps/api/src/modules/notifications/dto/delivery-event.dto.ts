import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { DELIVERY_EVENT_OUTCOMES, DELIVERY_EVENT_TYPES } from '../delivery-event';
import { EMAIL_SUPPRESSION_REASONS, type DeliveryEventIngestion } from '../notifications.types';

/**
 * La réponse de l'ingestion d'un événement de remise —
 * `POST /api/v1/notifications/delivery-events` (#73).
 *
 * ## Pourquoi il n'y a pas de DTO de **requête**
 *
 * Parce que le corps n'est pas notre contrat : c'est le JSON de SES, tel que
 * l'enveloppe SNS l'a laissé après remise brute. Nous ne le dessinons pas, nous
 * ne le versionnons pas, et AWS y ajoute des champs sans nous prévenir. Le
 * valider par `class-validator` reviendrait à figer aujourd'hui la forme d'un
 * document qui appartient à quelqu'un d'autre — et le premier champ ajouté
 * ferait rejeter en 400 des rebonds parfaitement lisibles, qui partiraient alors
 * en file d'attente morte.
 *
 * La lecture se fait donc **défensivement**, dans `delivery-event.ts` : chaque
 * champ est cherché, vérifié et normalisé, et ce qui ne se lit pas rend
 * `unreadable` plutôt que de lever. C'est la même conduite que le webhook Stripe,
 * pour la même raison — un corps qui vient d'un tiers se lit, il ne se valide
 * pas contre un schéma qu'on aurait inventé.
 *
 * La route est de toute façon **interne** : elle n'est atteignable qu'avec le
 * jeton partagé de la chaîne, et son seul appelant est la Lambda d'ingestion.
 *
 * ## Aucune adresse ne ressort d'ici
 *
 * Des compteurs, un type d'événement, un sous-type filtré et l'accusé opaque de
 * SES. Les adresses que l'événement portait ne figurent dans **aucun** champ de
 * cette réponse : elle est journalisée par la Lambda, et notifications §7
 * interdit qu'une coordonnée finisse dans un journal. C'est aussi ce qui rend la
 * réponse lisible en supervision — `suppressed` répond à la seule question qui
 * s'y pose, « combien de fiches viennent de cesser d'être sollicitées ».
 */
export class DeliveryEventDto {
  @ApiProperty({
    enum: DELIVERY_EVENT_OUTCOMES,
    description:
      'Ce que l’événement a commandé : `suppress` (l’adresse est condamnée), `transient` ' +
      '(l’envoi a échoué cette fois), `ignored` (l’événement ne dit rien de l’adresse), ' +
      '`unreadable` (ni JSON d’événement SES, ni type reconnu — le rejouer n’y changerait rien).',
  })
  public outcome!: string;

  @ApiPropertyOptional({
    enum: DELIVERY_EVENT_TYPES,
    description: 'Le type d’événement reconnu, normalisé. Absent quand la charge était illisible.',
  })
  public eventType?: string;

  @ApiPropertyOptional({
    description: 'Sous-type SES retenu (`General`, `MailboxFull`, `abuse`…), filtré et borné.',
    example: 'General',
  })
  public detail?: string;

  @ApiPropertyOptional({
    description: 'L’accusé opaque de SES (`mail.messageId`) — non personnel, journalisable.',
  })
  public messageId?: string;

  @ApiPropertyOptional({
    enum: EMAIL_SUPPRESSION_REASONS,
    description: 'Le motif inscrit sur les fiches, quand il y a eu suppression.',
  })
  public reason?: string;

  @ApiProperty({
    example: 1,
    description: 'Nombre d’adresses distinctes que l’événement désignait. Jamais les adresses.',
  })
  public recipientCount!: number;

  @ApiProperty({ example: 3, description: 'Nombre d’établissements visités.' })
  public tenantCount!: number;

  @ApiProperty({
    example: 2,
    description:
      'Nombre de fiches passées en supprimé. Zéro n’est pas une anomalie : l’adresse peut ' +
      'n’être connue d’aucun établissement, ou avoir déjà été supprimée par une livraison ' +
      'que SQS rejoue.',
  })
  public suppressed!: number;
}

/**
 * Le résultat de l'ingestion, sérialisé.
 *
 * Les champs nuls sont **omis** plutôt que rendus à `null` — la convention de
 * `toReminderMessageDto` et de `toNotificationDto`.
 */
export function toDeliveryEventDto(result: DeliveryEventIngestion): DeliveryEventDto {
  return {
    outcome: result.outcome,
    ...(result.eventType === null ? {} : { eventType: result.eventType }),
    ...(result.detail === null ? {} : { detail: result.detail }),
    ...(result.messageId === null ? {} : { messageId: result.messageId }),
    ...(result.reason === null ? {} : { reason: result.reason }),
    recipientCount: result.recipientCount,
    tenantCount: result.tenantCount,
    suppressed: result.suppressed,
  };
}
