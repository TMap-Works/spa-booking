import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';

import type { AppointmentScope, ListClientAppointmentsInput } from '../appointments.types';
import { OptionalPresent } from './validation';

/**
 * DTO de l'historique de la cliente connectée (#47).
 *
 * TODO(#26) : ces bornes sont celles de `myAppointmentsQuerySchema` de
 * `packages/shared/src/schemas/appointment.ts`, recopiées en attendant que
 * `apps/api` dépende du paquet partagé. Les noms sont **ceux du contrat**, pour
 * que la substitution ne change pas une borne en silence.
 */

/** Les deux moitiés de l'historique — `appointmentScopeSchema` du contrat. */
export const APPOINTMENT_SCOPES = ['upcoming', 'past'] as const satisfies readonly AppointmentScope[];

/** La moitié servie quand la requête n'en désigne aucune. */
export const DEFAULT_APPOINTMENT_SCOPE: AppointmentScope = 'upcoming';

/** Nombre de rendez-vous rendus quand la requête ne demande rien de particulier. */
export const MY_APPOINTMENTS_DEFAULT_LIMIT = 20;

/**
 * Plafond dur du nombre de rendez-vous rendus en une fois.
 *
 * Une cliente fidèle accumule des centaines de lignes ; une réponse non bornée
 * finirait par coûter plus cher à construire qu'à lire. La pagination complète
 * relève du back-office ; ici, un plafond suffit — l'espace client montre les
 * prochains rendez-vous et les dernières visites, pas un registre.
 */
export const MY_APPOINTMENTS_MAX_LIMIT = 100;

/**
 * Ce qu'une cliente peut demander de son historique — et rien de plus.
 *
 * **Aucun `clientId`, et c'est tout le propos.** La cliente est celle du jeton
 * vérifié ; un champ ici l'aurait laissée à la main de l'appelant, et une
 * requête suffirait à lire l'historique de quelqu'un d'autre — nom du praticien,
 * prestations, montants. L'agenda du back-office a bien un filtre `clientId`
 * (`appointmentListQuerySchema`), mais il vit derrière une garde `STAFF` et sur
 * une autre surface. Le `ValidationPipe` global — `whitelist` et
 * `forbidNonWhitelisted` — refuse en 400 tout champ non déclaré ici, ce qui rend
 * l'omission exécutoire.
 *
 * **Aucun `from`/`to` non plus.** Le CDC §1.4 demande « l'historique de ses
 * rendez-vous », pas une recherche par période : deux moitiés et un plafond
 * couvrent l'écran, et une fenêtre de dates ouvrirait un chemin d'exploration
 * dont personne n'a l'usage ici.
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
  @OptionalPresent()
  @IsIn(APPOINTMENT_SCOPES as readonly string[], {
    message: `scope : valeurs acceptées — ${APPOINTMENT_SCOPES.join(', ')}`,
  })
  public scope?: AppointmentScope;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MY_APPOINTMENTS_MAX_LIMIT,
    default: MY_APPOINTMENTS_DEFAULT_LIMIT,
    description: 'Nombre maximal de rendez-vous rendus.',
  })
  @OptionalPresent()
  // La valeur arrive d'une chaîne de requête : sans conversion, `?limit=5`
  // serait refusé pour cause de type, ce qui ferait passer une borne
  // parfaitement valide pour une erreur de saisie. `Number` et non `parseInt` :
  // `parseInt('5x')` rend `5`, `Number('5x')` rend `NaN`, que `@IsInt` refuse.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  )
  @IsInt({ message: 'limit : nombre entier attendu' })
  @Min(1, { message: 'limit : au moins 1' })
  @Max(MY_APPOINTMENTS_MAX_LIMIT, { message: `limit : au plus ${String(MY_APPOINTMENTS_MAX_LIMIT)}` })
  public limit?: number;
}

/**
 * Le DTO complété de ses défauts, sous la forme que le service reçoit.
 *
 * Les défauts sont appliqués **ici** et non par `@Transform` sur les champs :
 * un défaut posé à la validation deviendrait indiscernable d'une valeur envoyée,
 * et le DTO ne pourrait plus dire ce que l'appelant a réellement demandé. Le
 * `clientId` est ajouté par le contrôleur, depuis le jeton — il n'entre jamais
 * par ce chemin.
 */
export function toListInput(
  dto: MyAppointmentsQueryDto,
  clientId: string,
): ListClientAppointmentsInput {
  return {
    clientId,
    scope: dto.scope ?? DEFAULT_APPOINTMENT_SCOPE,
    limit: dto.limit ?? MY_APPOINTMENTS_DEFAULT_LIMIT,
  };
}
