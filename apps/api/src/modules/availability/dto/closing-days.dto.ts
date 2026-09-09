import { ApiProperty } from '@nestjs/swagger';
import {
  type SetClosingDaysRequest,
  closingDaysSchema,
  setClosingDaysRequestSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { IsoWeekday } from '../availability.schedule';
import type { ClosingDaysView } from '../availability.types';

/**
 * DTO des jours de fermeture récurrents de l'établissement (#32), **validé par
 * le contrat partagé** (#510).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `setClosingDaysRequestSchema` de `@spa/shared` décrit ce corps, et c'est lui
 * qui le juge, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * **Typer un paramètre de handler par la classe viderait le corps de la
 * requête.**
 *
 * ## Les écarts constatés avant de substituer : aucun
 *
 * | Règle | Le DTO validait | Le contrat valide | Effet |
 * |---|---|---|---|
 * | Sept jours au plus | `@ArrayMaxSize(7)` | `.max(7)` | identique, 400 des deux côtés |
 * | Aucun doublon | `@ArrayUnique()` | un `.refine()` sur la taille de l'ensemble | identique, 400 des deux côtés |
 * | Jour ISO 1–7 | `@IsInt({each})` + `@Min(1)` + `@Max(7)` | `isoWeekdaySchema` | identique |
 *
 * C'est le seul corps du module `availability` que la substitution atteint, et
 * la raison en est précise : c'est le seul dont **aucune règle ne sort en 422**.
 * Les trois autres — semaine de travail, absence, interrogation de créneaux —
 * portent des règles que le service traduit en `BusinessRuleError`, là où le
 * `.refine()` du contrat rendrait 400. Voir les notes d’écart de
 * `staff-schedule.dto.ts` et de `staff-time-off.dto.ts`.
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : un `tenantId`
 * glissé dans le corps est **refusé** — l'établissement est celui du jeton
 * vérifié, et le déclarer dans le corps serait exactement le paramètre que le
 * client contrôle (tenant-isolation §2).
 *
 * Le doublon reste tenu en base par l'unique `(tenant_id, weekday)`, qui est la
 * garantie : le refus du schéma n'est que le **message** — sans lui, un doublon
 * soumis produirait une violation de contrainte brute, donc un 500 là où le
 * contrat annonce un 400.
 */

/**
 * Le pipe du remplacement — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const setClosingDaysBody = new ZodValidationPipe(setClosingDaysRequestSchema);

/** Le remplacement demandé, tel que le contrat le rend au contrôleur. */
export type SetClosingDaysBody = SetClosingDaysRequest;

/** Sept jours dans une semaine — au-delà, un jour serait déclaré deux fois. */
const DAYS_IN_WEEK = 7;

/**
 * Remplacement intégral de la liste des jours fermés — la documentation de
 * `setClosingDaysRequestSchema`.
 *
 * Un tableau vide signifie « ouvert sept jours sur sept » : c'est ainsi qu'on
 * rouvre un jour, et il n'y a donc pas de suppression unitaire à écrire.
 */
export class SetClosingDaysDto {
  @ApiProperty({
    type: [Number],
    maxItems: DAYS_IN_WEEK,
    minimum: 1,
    maximum: DAYS_IN_WEEK,
    example: [7],
    description:
      'Jours fermés en numérotation ISO 8601 : 1 lundi … 7 dimanche. ' +
      'Liste vide = ouvert toute la semaine. Un jour déclaré deux fois est refusé.',
  })
  public weekdays!: number[];
}

/** Les jours de fermeture tels qu'ils sortent de l'API, croissants. */
export class ClosingDaysDto implements ClosingDaysView {
  // `readonly` comme la vue qu'il reflète — voir `StaffScheduleDto.entries`.
  @ApiProperty({ type: [Number], example: [7] })
  public weekdays!: readonly IsoWeekday[];
}

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;

/**
 * La classe qui documente `/api/docs` doit annoncer **exactement** les champs
 * que le pipe accepte, et la sortie exactement ceux que le contrat décrit.
 *
 * L'assignabilité champ par champ n'est pas posée sur la sortie : `weekdays` y
 * est `readonly` — la vue est servie telle quelle, et un lecteur qui la trierait
 * en place modifierait la réponse que le service garde par ailleurs —, et un
 * `ReadonlyArray<T>` n'est pas assignable à un `T[]`. Le jeu de clés, lui, tient
 * des deux côtés.
 */
type _SetClosingDaysDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof SetClosingDaysDto, keyof z.input<typeof setClosingDaysRequestSchema>>
  | Exclude<keyof z.input<typeof setClosingDaysRequestSchema>, keyof SetClosingDaysDto>
>;

type _ClosingDaysDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof ClosingDaysDto, keyof z.input<typeof closingDaysSchema>>
  | Exclude<keyof z.input<typeof closingDaysSchema>, keyof ClosingDaysDto>
>;
