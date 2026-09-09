import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, Max, Min, ValidateNested } from 'class-validator';

import type { IsoWeekday } from '../availability.schedule';
import type { StaffScheduleEntryView, StaffScheduleView } from '../availability.types';
import { IsAfterLocalTime, IsLocalTime, IsScheduleEndTime } from './validation';

/**
 * DTO des horaires récurrents du personnel (#32).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans le corps, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). Aucun DTO d'entrée du module ne déclare de `tenantId`,
 * et aucun DTO de sortie n'en porte : l'établissement vient du jeton vérifié.
 *
 * `timezone` non plus n'est jamais accepté en entrée : il appartient à
 * l'établissement (`tenants.timezone`), pas à la charge utile. Le laisser
 * soumettre reviendrait à laisser un client décaler l'agenda d'un salon.
 *
 * Écart assumé, tranché en #554 : `setStaffScheduleRequestSchema` de
 * `packages/shared/src/schemas/availability.ts` décrit exactement ce corps —
 * mêmes bornes, même motif d'heure murale, même refus d'une fin antérieure au
 * début —, et #510 n'a pourtant pas pu le monter. L'écart n'est pas de règle
 * mais de **code de réponse** : le schéma refuse le recouvrement de deux plages
 * du même jour par un `.refine()`, donc en **400**, là où cette route rend un
 * **422 `OVERLAPPING_SCHEDULE_RANGES`** avec les deux plages fautives dans
 * `details`. C'est délibéré — chaque plage est bien écrite, c'est leur mise en
 * présence qui ne veut rien dire —, et l'écran de planning affiche les deux
 * refus différemment. Monter le schéma changerait donc le code que le
 * back-office lit, et lui retirerait au passage le `details` dont il a besoin
 * pour désigner les plages à corriger.
 *
 * Reste à faire, côté contrat : sortir `staffScheduleEntriesOverlap` du
 * `.refine()` de `setStaffScheduleRequestSchema` — la fonction est déjà exportée
 * séparément — pour que le service reste seul juge du recouvrement. Même
 * constat, mot pour mot, sur `updateTenantRequestSchema` dans
 * `identity/dto/tenant-settings.dto.ts`.
 *
 * ## Une seule classe pour l'entrée et la sortie
 *
 * `StaffScheduleEntryDto` sert des deux côtés, contrairement à l'usage du module
 * `catalog`. La forme est ici rigoureusement identique — trois champs, aucun
 * dérivé, aucun champ interne à masquer — et deux classes jumelles n'auraient
 * fait que se désynchroniser. Les décorateurs de validation sont sans effet sur
 * une réponse.
 */
export class StaffScheduleEntryDto implements StaffScheduleEntryView {
  @ApiProperty({
    minimum: 1,
    maximum: 7,
    description:
      'Jour de la semaine en numérotation ISO 8601 : 1 lundi … 7 dimanche. ' +
      'Le 0-dimanche de `Date.getDay` n’est pas accepté.',
    example: 2,
  })
  @IsInt()
  @Min(1)
  @Max(7)
  public weekday!: IsoWeekday;

  @ApiProperty({
    example: '09:00',
    description:
      'Heure murale, dans le fuseau de l’établissement. Jamais un instant : ' +
      'la conversion en UTC se fait à la volée, date par date.',
  })
  @IsLocalTime()
  public startsAt!: string;

  @ApiProperty({
    example: '12:00',
    description:
      'Heure murale de fin, **exclue** — `12:00` et `12:00` décrivent deux ' +
      'plages adjacentes, pas un chevauchement. `24:00` pour minuit. ' +
      'Strictement postérieure à `startsAt`.',
  })
  @IsScheduleEndTime()
  // Sans ce contrôle, `09:00 → 08:00` traverse le DTO — chaque borne est bien
  // écrite — et va heurter `staff_schedules_minutes_check` en base : 500 sur une
  // saisie fautive, là où le contrat annonce 400.
  @IsAfterLocalTime('startsAt')
  public endsAt!: string;
}

/**
 * Nombre maximal de plages dans une semaine de travail.
 *
 * Quatre coupures par jour laissent la place à la coupure méridienne du CDC — et
 * au salon qui rouvre en soirée — tout en bornant le coût du calcul de créneaux,
 * qui parcourt ces plages pour chaque journée demandée. Même valeur que
 * `MAX_STAFF_SCHEDULE_ENTRIES` du contrat partagé.
 */
export const MAX_STAFF_SCHEDULE_ENTRIES = 28;

/**
 * Remplacement **intégral** de la semaine de travail.
 *
 * Un `PUT` de la semaine entière, et non un CRUD plage par plage : la seule
 * invariante qui compte — aucune plage ne se recouvre — porte sur l'ensemble, et
 * la vérifier à chaque ajout ferait dépendre le résultat de l'ordre des appels.
 * Un tableau vide est licite : c'est ainsi qu'un praticien cesse d'être
 * proposable sans être désactivé.
 */
export class SetStaffScheduleDto {
  @ApiProperty({ type: [StaffScheduleEntryDto], maxItems: MAX_STAFF_SCHEDULE_ENTRIES })
  @IsArray()
  @ArrayMaxSize(MAX_STAFF_SCHEDULE_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => StaffScheduleEntryDto)
  public entries!: StaffScheduleEntryDto[];
}

/**
 * La semaine de travail telle qu'elle sort de l'API.
 *
 * **Sans `tenantId`** : c'est une information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4).
 */
export class StaffScheduleDto implements StaffScheduleView {
  @ApiProperty({ format: 'uuid' })
  public staffId!: string;

  @ApiProperty({
    example: 'Europe/Paris',
    description:
      'Fuseau IANA de l’établissement — celui dans lequel lire les heures ' +
      'murales ci-dessous. Rendu, jamais accepté en entrée.',
  })
  public timezone!: string;

  // `readonly` comme la vue qu'il reflète : une réponse ne se modifie pas après
  // coup, et c'est ce qui rend `StaffScheduleView` assignable sans copie.
  @ApiProperty({ type: [StaffScheduleEntryDto] })
  public entries!: readonly StaffScheduleEntryDto[];
}
