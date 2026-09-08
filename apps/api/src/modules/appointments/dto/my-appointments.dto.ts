import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DEFAULT_APPOINTMENT_SCOPE,
  MY_APPOINTMENTS_DEFAULT_LIMIT,
  MY_APPOINTMENTS_MAX_LIMIT,
  type MyAppointmentsQuery,
  appointmentScopeSchema,
  myAppointmentsQuerySchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { AppointmentScope, ListClientAppointmentsInput } from '../appointments.types';

/**
 * DTO de l'historique de la cliente connectée (#47), **validé par le contrat
 * partagé** (#510).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `myAppointmentsQuerySchema` de `@spa/shared` décrit cette forme, et c'est lui
 * qui juge la chaîne de requête, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 *
 * C'est le **seul DTO de chaîne de requête du dépôt** que la substitution
 * atteint, et pour une raison précise : `myAppointmentsQuerySchema` est le seul
 * schéma de requête du contrat qui **coerce** (`z.coerce.number()` sur `limit`).
 * Une chaîne de requête ne transporte que des chaînes, et un schéma sans
 * coercition refuserait `?limit=5` pour cause de type — c'est ce qui retient la
 * substitution des filtres de catalogue, de paiements et d'agenda.
 *
 * ## Les écarts constatés avant de substituer : aucun
 *
 * | Champ | Le DTO validait | Le contrat valide | Effet |
 * |---|---|---|---|
 * | `scope` | `@IsIn(['upcoming', 'past'])` | `appointmentScopeSchema` — la même énumération | identique |
 * | `limit` | `@Transform(Number)` + `@IsInt` + `@Min(1)` + `@Max(100)` | `z.coerce.number().int().min(1).max(MY_APPOINTMENTS_MAX_LIMIT)` | identique — `Number('5x')` et `z.coerce` rendent tous deux `NaN`, refusé de part et d'autre |
 *
 * Les trois bornes — la moitié par défaut, la limite par défaut, le plafond —
 * viennent elles aussi du contrat et sont réexportées d'ici pour le contrôleur
 * et les suites qui les lisaient à cette adresse.
 *
 * **Aucun `clientId`, et c'est tout le propos.** La cliente est celle du jeton
 * vérifié ; un champ ici l'aurait laissée à la main de l'appelant, et une
 * requête suffirait à lire l'historique de quelqu'un d'autre — nom du praticien,
 * prestations, montants. L'agenda du back-office a bien un filtre `clientId`
 * (`appointmentListQuerySchema`), mais il vit derrière une garde `STAFF` et sur
 * une autre surface. Le `.strict()` du contrat remplace `forbidNonWhitelisted` :
 * un champ non déclaré est **refusé en 400**, ce qui rend l'omission exécutoire
 * (tenant-isolation §2).
 *
 * **Aucun `from`/`to` non plus.** Le CDC §1.4 demande « l'historique de ses
 * rendez-vous », pas une recherche par période : deux moitiés et un plafond
 * couvrent l'écran, et une fenêtre de dates ouvrirait un chemin d'exploration
 * dont personne n'a l'usage ici.
 */

/**
 * Le pipe des filtres d'historique — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const myAppointmentsQuery = new ZodValidationPipe(myAppointmentsQuerySchema);

/** Les filtres, tels que le contrat les rend au contrôleur. */
export type MyAppointmentsQueryBody = MyAppointmentsQuery;

/** Les deux moitiés de l'historique — `appointmentScopeSchema` du contrat. */
export const APPOINTMENT_SCOPES = appointmentScopeSchema.options;

/** La moitié servie quand la requête n'en désigne aucune. */
export { DEFAULT_APPOINTMENT_SCOPE };

/** Nombre de rendez-vous rendus quand la requête ne demande rien de particulier. */
export { MY_APPOINTMENTS_DEFAULT_LIMIT };

/**
 * Plafond dur du nombre de rendez-vous rendus en une fois.
 *
 * Une cliente fidèle accumule des centaines de lignes ; une réponse non bornée
 * finirait par coûter plus cher à construire qu'à lire. La pagination complète
 * relève du back-office ; ici, un plafond suffit — l'espace client montre les
 * prochains rendez-vous et les dernières visites, pas un registre.
 */
export { MY_APPOINTMENTS_MAX_LIMIT };

/**
 * Ce qu'une cliente peut demander de son historique — la documentation de
 * `myAppointmentsQuerySchema`.
 *
 * Elle n'a plus **aucun** décorateur `class-validator` : la typer sur un
 * paramètre de handler viderait la chaîne de requête (ADR 0008).
 */
export class MyAppointmentsQueryDto {
  @ApiPropertyOptional({
    enum: APPOINTMENT_SCOPES,
    default: DEFAULT_APPOINTMENT_SCOPE,
    description:
      '`upcoming` : ce qu’il reste à honorer — l’intervalle n’est pas terminé et ' +
      'le rendez-vous tient encore son créneau. `past` : tout le reste, ' +
      'annulations comprises. Les deux moitiés sont disjointes et complémentaires.',
  })
  public scope?: AppointmentScope;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MY_APPOINTMENTS_MAX_LIMIT,
    default: MY_APPOINTMENTS_DEFAULT_LIMIT,
    description: 'Nombre maximal de rendez-vous rendus.',
  })
  public limit?: number;
}

/**
 * Le DTO complété de ses défauts, sous la forme que le service reçoit.
 *
 * Les défauts sont appliqués **ici** et non dans le schéma : un `.default()`
 * deviendrait indiscernable d'une valeur envoyée, et la frontière ne pourrait
 * plus dire ce que l'appelant a réellement demandé. Le `clientId` est ajouté par
 * le contrôleur, depuis le jeton — il n'entre jamais par ce chemin.
 */
export function toListInput(
  query: MyAppointmentsQueryBody,
  clientId: string,
): ListClientAppointmentsInput {
  return {
    clientId,
    scope: query.scope ?? DEFAULT_APPOINTMENT_SCOPE,
    limit: query.limit ?? MY_APPOINTMENTS_DEFAULT_LIMIT,
  };
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte — la garde de compilation du patron de `book-appointment.dto.ts`.
 */
type AssertNever<T extends never> = T;

type _MyAppointmentsQueryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyAppointmentsQueryDto, keyof z.input<typeof myAppointmentsQuerySchema>>
  | Exclude<keyof z.input<typeof myAppointmentsQuerySchema>, keyof MyAppointmentsQueryDto>
>;
