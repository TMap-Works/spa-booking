import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type RescheduleAppointmentRequest,
  rescheduleAppointmentRequestSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';

/**
 * Le report, **validé par le contrat partagé** (#510) — la route publique (#39)
 * et celle du comptoir (#461) partagent ce corps.
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `rescheduleAppointmentRequestSchema` de
 * `packages/shared/src/schemas/appointment.ts` décrit exactement cette forme, et
 * c'est lui qui juge désormais le corps, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La classe survit parce que le schéma OpenAPI de `/api/docs` sort des
 * décorateurs `@nestjs/swagger`, que Zod ne porte pas.
 *
 * La conséquence à connaître avant de toucher à ce fichier : **typer un
 * paramètre de handler par `RescheduleAppointmentDto` viderait le corps de la
 * requête**, le `ValidationPipe` global appliquant `whitelist` à une classe qui
 * n'a plus aucun décorateur `class-validator` à mettre sur sa liste blanche. Le
 * handler prend `RescheduleAppointmentBody`, et déclare la classe par
 * `@ApiBody({ type: RescheduleAppointmentDto })`.
 *
 * ## Le `.strict()` du contrat remplace `forbidNonWhitelisted`
 *
 * C'est ce qui rend structurellement impossible ce qu'un report ne doit pas
 * pouvoir faire — changer la prestation, la cliente, le prix ou le statut. Le
 * corps ne porte qu'un instant et, facultatif, un praticien ; tout le reste est
 * recopié du rendez-vous d'origine côté serveur. Un `tenantId` glissé dans le
 * corps est refusé par le schéma au lieu de l'être par le pipe global
 * (tenant-isolation §2), et `ZodValidationPipe` refuse au montage un schéma
 * d'entrée qui ne serait pas `.strict()`.
 *
 * ## Les écarts constatés avant de substituer, et ce qu'ils changent
 *
 * Aucun sur le fond, ce qui est le cas rare et vaut d'être dit :
 *
 * | Champ | Le DTO validait | Le contrat valide | Effet |
 * |---|---|---|---|
 * | `startsAt` | `@IsOffsetDateTime()` — le même prédicat, importé de `@spa/shared` | `offsetDateTimeSchema` | même refus, et la **normalisation en UTC** passe du contrôleur à la frontière |
 * | `staffId` | `@IsUUID('4')` | `uuidSchema`, resserré sur la v4 par #403 | inchangé |
 *
 * Le seul déplacement est celui de la conversion : `offsetDateTimeSchema`
 * *transforme*, si bien que `body.startsAt` est déjà l'instant UTC normalisé
 * quand le contrôleur le lit. Le `new Date(...)` qui suit ne peut donc plus
 * produire ni une date invalide, ni une date-heure interprétée dans le fuseau de
 * la machine — `__tests__/date-time.validation.spec.ts` tient ce trajet, du corps
 * HTTP jusqu'à l'instant remis au service.
 */

/**
 * Le pipe de la demande de report — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const rescheduleAppointmentBody = new ZodValidationPipe(rescheduleAppointmentRequestSchema);

/** La demande de report, telle que le contrat la rend au contrôleur. */
export type RescheduleAppointmentBody = RescheduleAppointmentRequest;

/**
 * La demande de report — la documentation de
 * `rescheduleAppointmentRequestSchema`.
 */
export class RescheduleAppointmentDto {
  @ApiProperty({
    description:
      'Nouveau début du **soin** — l’instant proposé par le calendrier, tel qu’il ' +
      's’est affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une ' +
      'date-heure nue obligerait le serveur à deviner un fuseau. Normalisé en UTC ' +
      'à la frontière.',
    example: '2026-09-02T14:00:00Z',
  })
  public startsAt!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Nouveau praticien. Absent, le rendez-vous reste chez le même — le salon ' +
      'change couramment de praticien à l’occasion d’un report, mais ce n’est ' +
      'pas le cas courant.',
  })
  public staffId?: string;
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte.
 *
 * Sans cette garde, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui refuse
 * ce qu'elle annonce. Elle ne coûte rien à l'exécution et échoue au `tsc`.
 */
type AssertNever<T extends never> = T;

type _RescheduleAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<
      keyof RescheduleAppointmentDto,
      keyof z.input<typeof rescheduleAppointmentRequestSchema>
    >
  | Exclude<
      keyof z.input<typeof rescheduleAppointmentRequestSchema>,
      keyof RescheduleAppointmentDto
    >
>;
