import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type AppointmentStatus as ContractAppointmentStatus,
  type ChangeAppointmentStatusRequest,
  REASON_MAX_LENGTH,
  changeAppointmentStatusRequestSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { ChangeAppointmentStatusInput } from '../appointments.types';
import { APPOINTMENT_STATUS_FILTERS, toDomainStatus } from './list-appointments.dto';

/**
 * Le changement de statut au back-office (#461, cinquième critère de #50),
 * **validé par le contrat partagé** (#510).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `changeAppointmentStatusRequestSchema` de `@spa/shared` décrit cette forme, et
 * c'est lui qui juge le corps, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La classe ne porte plus que ses `@ApiProperty` — et **typer un paramètre de
 * handler par elle viderait le corps de la requête**, le `ValidationPipe` global
 * appliquant `whitelist` à une classe qui n'a plus rien à mettre sur sa liste
 * blanche.
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : le corps ne porte
 * donc qu'une destination et, facultatif, un motif — jamais l'horodatage, jamais
 * l'auteur, jamais le statut d'origine. Ce dernier point n'est pas un détail :
 * le statut de départ est **relu en base**, et c'est lui qui fait de l'écriture
 * un test-et-pose atomique. Le laisser entrer par le corps aurait rendu la
 * garantie dépendante de ce que l'appelant croit savoir de l'agenda.
 *
 * ## Le vocabulaire des statuts : l'écart redouté n'existe pas ici
 *
 * `changeAppointmentStatusRequestSchema` déclare les statuts **en minuscules** —
 * `appointmentStatusSchema` de `@spa/shared` —, là où l'énumération PostgreSQL
 * porte la casse inverse. C'est le point de vigilance de #510, et c'est
 * précisément pourquoi il fallait le vérifier avant de substituer : monter le
 * schéma sur une route qui aurait accepté `CONFIRMED` aurait changé le contrat
 * du fil sans qu'aucun test ne le dise.
 *
 * Il se trouve que cette route **acceptait déjà** le vocabulaire du contrat :
 * `@IsIn(APPOINTMENT_STATUS_FILTERS)` jugeait la même liste de mots, dans la
 * même casse (#461). La substitution ne déplace donc rien pour l'appelant — elle
 * supprime la seconde écriture de la liste, pas la liste. La conversion vers la
 * casse du domaine reste où elle était, dans `toDomainStatus`, qui est celle du
 * filtre de l'agenda : une seule, pour que les deux surfaces ne puissent pas
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
 */

/**
 * Le pipe de la demande de changement de statut — c'est **lui** qui valide, et
 * non la classe ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const changeAppointmentStatusBody = new ZodValidationPipe(
  changeAppointmentStatusRequestSchema,
);

/** La demande de changement de statut, telle que le contrat la rend au contrôleur. */
export type ChangeAppointmentStatusBody = ChangeAppointmentStatusRequest;

/**
 * La demande de changement de statut — la documentation de
 * `changeAppointmentStatusRequestSchema`.
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
  public status!: ContractAppointmentStatus;

  @ApiPropertyOptional({
    description:
      'Motif, facultatif. Consigné **sur une annulation seulement** — c’est la ' +
      'colonne `cancellation_reason`, et il n’y a pas de colonne pour motiver un ' +
      'no-show ou un soin honoré. Le contrat partagé le porte sur toutes les ' +
      'transitions, et cette route le suit plutôt que d’en refuser la moitié. ' +
      'Élagué à la frontière : une saisie réduite à des espaces compte pour absente.',
    maxLength: REASON_MAX_LENGTH,
    example: 'Cliente injoignable',
  })
  public reason?: string;
}

/**
 * La demande sous la forme que le service attend.
 *
 * Le motif suit la règle de `toCancellationReason` : le contrat distingue
 * « absent » de « vide », le domaine ne connaît que `null`. Un `body.reason ?? null`
 * seul ne suffirait pas — `reasonSchema` élague, donc ramène `"   "` à `""`, qui
 * irait s'inscrire tel quel en base et compterait comme une annulation motivée.
 */
export function toStatusChangeInput(
  appointmentId: string,
  body: ChangeAppointmentStatusBody,
): ChangeAppointmentStatusInput {
  const reason = body.reason ?? '';

  return {
    appointmentId,
    status: toDomainStatus(body.status),
    reason: reason === '' ? null : reason,
  };
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte — la garde de compilation du patron de `book-appointment.dto.ts`.
 */
type AssertNever<T extends never> = T;

type _ChangeAppointmentStatusDtoHasTheContractKeys = AssertNever<
  | Exclude<
      keyof ChangeAppointmentStatusDto,
      keyof z.input<typeof changeAppointmentStatusRequestSchema>
    >
  | Exclude<
      keyof z.input<typeof changeAppointmentStatusRequestSchema>,
      keyof ChangeAppointmentStatusDto
    >
>;
