import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';

import type { ChangeAppointmentStatusInput } from '../appointments.types';
import { APPOINTMENT_STATUS_FILTERS, toDomainStatus } from './list-appointments.dto';
import { CANCELLATION_REASON_MAX_LENGTH, OptionalPresent, Trim } from './validation';

/**
 * DTO du changement de statut au back-office (#461, cinquième critère de #50).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas. Le corps ne porte donc qu'une destination
 * et, facultatif, un motif — jamais l'horodatage, jamais l'auteur, jamais le
 * statut d'origine. Ce dernier point n'est pas un détail : le statut de départ
 * est **relu en base**, et c'est lui qui fait de l'écriture un test-et-pose
 * atomique. Le laisser entrer par le corps aurait rendu la garantie dépendante
 * de ce que l'appelant croit savoir de l'agenda.
 *
 * ## Le vocabulaire est celui du contrat, en minuscules
 *
 * `appointmentStatusSchema` de `@spa/shared` déclare `pending`, `confirmed`,
 * `completed`, `cancelled`, `no_show` ; l'énumération PostgreSQL porte la casse
 * inverse. C'est le front qui envoie, donc c'est la casse du contrat qui entre —
 * accepter celle de Prisma ferait refuser en 400 la requête que le contrat
 * décrit. La conversion vit à la frontière, dans `toDomainStatus`, qui est celle
 * du filtre de l'agenda : une seule, pour que les deux surfaces ne puissent pas
 * diverger.
 *
 * ## Les cinq statuts sont acceptés en entrée, et le cycle de vie en refuse trois
 *
 * La liste n'est pas restreinte à `confirmed` / `completed` / `no_show`, bien que
 * ce soient les seuls que le comptoir déclenche. Ce qui décide de ce qui est
 * atteignable est `AppointmentLifecycleService`, et lui seul (booking-engine §5)
 * : `pending` n'est la destination d'aucune transition, `completed` depuis
 * `pending` non plus, et un statut vers lui-même n'en est pas une. Tous sortent
 * en **422 `INVALID_STATE_TRANSITION`**, avec `from` et `to` dans `details` — ce
 * qu'un 400 sur une valeur d'énumération n'aurait pas su dire, et ce dont le
 * tiroir a besoin pour expliquer le refus plutôt que de le présenter comme une
 * saisie invalide.
 *
 * `cancelled` est accepté et **route vers l'annulation** : voir
 * `AppointmentsService.changeStatus`. C'est la seule écriture qui pose
 * `cancelled_at`, `cancelled_by` et le motif, sans lesquels le reporting du CDC
 * §1.4 compterait une annulation muette.
 *
 * TODO(#26) : `changeAppointmentStatusRequestSchema` de
 * `packages/shared/src/schemas/appointment.ts` décrit la même forme et devra
 * être importé le jour où `apps/api` dépendra du paquet — même TODO que dans
 * `book-appointment.dto.ts`.
 */
export class ChangeAppointmentStatusDto {
  @ApiProperty({
    enum: APPOINTMENT_STATUS_FILTERS,
    description:
      'Statut visé, dans le vocabulaire du contrat partagé — en minuscules. Une ' +
      'transition que le cycle de vie n’autorise pas sort en 422 ' +
      '`INVALID_STATE_TRANSITION`, jamais en 400 : la valeur est connue, c’est le ' +
      'passage qui ne l’est pas.',
    example: 'completed',
  })
  @IsString()
  @IsIn(APPOINTMENT_STATUS_FILTERS, {
    message: `status : valeurs acceptées — ${APPOINTMENT_STATUS_FILTERS.join(', ')}`,
  })
  public status!: string;

  @ApiPropertyOptional({
    description:
      'Motif, facultatif. Consigné **sur une annulation seulement** — c’est la ' +
      'colonne `cancellation_reason`, et il n’y a pas de colonne pour motiver un ' +
      'no-show ou un soin honoré. Le contrat partagé le porte sur toutes les ' +
      'transitions, et ce DTO le suit plutôt que d’en refuser la moitié.',
    maxLength: CANCELLATION_REASON_MAX_LENGTH,
    example: 'Cliente injoignable',
  })
  @OptionalPresent()
  @IsString()
  // Élagué avant que la borne ne juge : sans cela, `"   "` passerait pour un
  // motif — trois espaces font trois caractères.
  @Trim()
  @MaxLength(CANCELLATION_REASON_MAX_LENGTH)
  public reason?: string;
}

/**
 * La demande sous la forme que le service attend.
 *
 * Le motif suit la règle de `toCancellationReason` : le DTO distingue « absent »
 * de « vide », le domaine ne connaît que `null`. Un `dto.reason ?? null` seul ne
 * suffirait pas — `@Trim()` ramène `"   "` à `""`, qui irait s'inscrire tel quel
 * en base et compterait comme une annulation motivée.
 */
export function toStatusChangeInput(
  appointmentId: string,
  dto: ChangeAppointmentStatusDto,
): ChangeAppointmentStatusInput {
  const reason = dto.reason ?? '';

  return {
    appointmentId,
    status: toDomainStatus(dto.status),
    reason: reason === '' ? null : reason,
  };
}
