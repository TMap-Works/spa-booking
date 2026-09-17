import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ISO_WEEKDAYS,
  LONG_TEXT_MAX_LENGTH,
  MAX_APPOINTMENT_RANGE_DAYS,
  NAME_MAX_LENGTH,
  REASON_MAX_LENGTH,
  UTC_OFFSET_MINUTES_MAX,
  UTC_OFFSET_MINUTES_MIN,
  myStaffAgendaSchema,
  myStaffAppointmentClientSchema,
  myStaffAppointmentSchema,
  myStaffProfileSchema,
  myStaffRangeQuerySchema,
  myStaffScheduleSchema,
  staffScheduleEntrySchema,
  staffTimeOffSchema,
  type MyStaffRangeQuery,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../appointment-status';
import type {
  MyStaffAgendaView,
  MyStaffAppointmentClientView,
  MyStaffAppointmentView,
  MyStaffRangeInput,
  MyStaffScheduleEntryView,
  MyStaffScheduleView,
  MyStaffTimeOffView,
  StaffProfileView,
} from '../appointments.types';

/**
 * DTO de l'espace du **praticien connecté** — `GET /v1/me/*` (#811).
 *
 * Comme `my-appointments.dto.ts`, ce fichier ne décrit pas la frontière : il la
 * **documente**. C'est `myStaffRangeQuerySchema` de `@spa/shared` qui juge la
 * chaîne de requête, monté par `ZodValidationPipe` (ADR 0008), et ce sont les
 * assertions de compilation en fin de fichier qui tiennent la sortie.
 *
 * ## Le quatrième critère du ticket est tenu par un `.strict()`, pas par un `if`
 *
 * > « Un `staffId` passé en paramètre est refusé en 400, comme champ inconnu :
 * > le périmètre ne se choisit pas. »
 *
 * `myStaffRangeQuerySchema` ne déclare que `from` et `to`, et il est `.strict()`
 * : `?staffId=…` sort en 400 sans qu'aucune ligne de code ne le mentionne — et
 * c'est bien le but. Un contrôle écrit à la main aurait dû nommer le champ à
 * refuser, donc être tenu à jour à chaque nouveau champ qu'on ne veut pas ; ici
 * le refus est le **défaut**, et seuls les deux champs déclarés passent. Le
 * `?tenantId=` du scénario de fuite le plus direct tombe par la même porte
 * (tenant-isolation §2).
 *
 * ## Pourquoi un schéma de requête du contrat ici, alors que l'agenda du
 * comptoir n'a pas pu
 *
 * `appointmentListQuerySchema` reste sous `class-validator` pour deux raisons —
 * `statuses` arrive en chaîne ou en tableau selon Express, et ses deux `refine`
 * changeraient le code d'erreur de la fenêtre. Ni l'une ni l'autre ne s'applique
 * ici : deux dates civiles, aucun tableau, et la fenêtre est jugée par le
 * service — en 422, comme là-bas.
 */

/**
 * Le pipe des deux routes à fenêtre — c'est **lui** qui valide, et non les
 * classes ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` se paie
 * ainsi à l'amorçage.
 */
export const myStaffRangeQuery = new ZodValidationPipe(myStaffRangeQuerySchema);

/** La fenêtre, telle que le contrat la rend au contrôleur. */
export type MyStaffRangeQueryBody = MyStaffRangeQuery;

/**
 * La fenêtre complétée du compte appelant, sous la forme que le service reçoit.
 *
 * Le DTO distingue « absent » de « vide » ; le service, lui, ne connaît que
 * `null` — même conversion que `toAgendaInput`, et pour la même raison : les
 * défauts ne sont **pas** appliqués ici, « aujourd'hui » dépendant d'un fuseau
 * que seule la couche service sait lire.
 *
 * `userId` est ajouté **par le contrôleur**, depuis le jeton vérifié : il n'entre
 * jamais par ce chemin, et c'est cette fonction — la seule à les réunir — qui
 * garantit qu'aucune autre source ne peut le fournir.
 */
export function toMyStaffRangeInput(
  query: MyStaffRangeQueryBody,
  userId: string,
): MyStaffRangeInput {
  return {
    userId,
    from: query.from ?? null,
    to: query.to ?? null,
  };
}

/**
 * Ce qu'un praticien peut demander de sa fenêtre — et rien de plus.
 *
 * Aucun décorateur `class-validator` : la typer sur un paramètre de handler
 * viderait la chaîne de requête (ADR 0008). Elle ne sert qu'à `/api/docs`.
 */
export class MyStaffRangeQueryDto {
  @ApiPropertyOptional({
    description:
      'Premier jour de la fenêtre, date civile de l’établissement, borne ' +
      'comprise. Absent, la réponse sert la journée courante du salon.',
    example: '2026-09-01',
  })
  public from?: string;

  @ApiPropertyOptional({
    description:
      'Dernier jour de la fenêtre, borne comprise. Absent, il vaut `from`. La ' +
      `fenêtre ne peut excéder ${String(MAX_APPOINTMENT_RANGE_DAYS)} jours.`,
    example: '2026-09-07',
  })
  public to?: string;
}

/**
 * La fiche praticien du compte connecté — `staffMemberSchema` du contrat.
 *
 * **Sans `userId`** : l'appelant est ce compte. C'est la même omission que
 * `StaffMemberDto` du catalogue, pour la même raison.
 */
export class MyStaffProfileDto implements StaffProfileView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Camille', maxLength: DISPLAY_NAME_MAX_LENGTH })
  public displayName!: string;

  @ApiPropertyOptional({
    maxLength: LONG_TEXT_MAX_LENGTH,
    description:
      'Présentation publique. **Absente**, et jamais `null`, quand elle n’est ' +
      'pas renseignée — `staffMemberSchema` la déclare `.optional()`, et un ' +
      '`null` explicite y ferait échouer la lecture de la fiche entière.',
  })
  public bio?: string;

  @ApiProperty({
    description:
      'Une fiche désactivée est **rendue** : les rendez-vous déjà pris restent à ' +
      'honorer, et un praticien qui ne verrait plus rien ne saurait pas pourquoi.',
  })
  public isActive!: boolean;
}

/** La cliente d'une ligne de planning — prénom, et initiale du nom (CDC §5.1). */
export class MyStaffAppointmentClientDto implements MyStaffAppointmentClientView {
  @ApiProperty({ example: 'Camille', maxLength: NAME_MAX_LENGTH })
  public firstName!: string;

  @ApiProperty({
    example: 'D',
    maxLength: 1,
    description:
      'Initiale du nom, en capitale et **sans point** — la ponctuation est une ' +
      'décision d’affichage. Le nom complet reste servi à l’agenda du comptoir.',
  })
  public lastInitial!: string;
}

/** La prestation d'une ligne de planning — ni prix courant, ni tampons. */
export class MyStaffAppointmentServiceDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Massage 60 min', maxLength: DISPLAY_NAME_MAX_LENGTH })
  public name!: string;

  @ApiProperty({ example: 60 })
  public durationMinutes!: number;
}

/**
 * Un rendez-vous tel que le praticien connecté le lit —
 * `myStaffAppointmentSchema`.
 *
 * Les champs facultatifs sont **absents**, jamais `null` : le schéma les déclare
 * `.optional()` et non `.nullable()`, comme ceux de la ligne d'agenda.
 */
export class MyStaffAppointmentDto implements MyStaffAppointmentView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'RDV-8F3K-27' })
  public reference!: string;

  @ApiProperty({ enum: APPOINTMENT_STATUSES, example: 'CONFIRMED' })
  public status!: AppointmentStatus;

  @ApiProperty({ description: 'Début du soin, ISO 8601 UTC.', example: '2026-09-01T09:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Fin du soin, ISO 8601 UTC.', example: '2026-09-01T10:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({
    minimum: UTC_OFFSET_MINUTES_MIN,
    maximum: UTC_OFFSET_MINUTES_MAX,
    example: 120,
    description:
      'Décalage de l’établissement **à l’instant de ce rendez-vous**, en ' +
      'minutes : `60` en hiver et `120` en été à Paris. Porté par la ligne et ' +
      'non par la réponse — une fenêtre d’un mois peut enjamber un changement ' +
      'd’heure.',
  })
  public utcOffsetMinutes!: number;

  @ApiProperty({ type: MyStaffAppointmentServiceDto })
  public service!: MyStaffAppointmentServiceDto;

  @ApiProperty({ type: MyStaffAppointmentClientDto })
  public client!: MyStaffAppointmentClientView;

  @ApiPropertyOptional({
    maxLength: LONG_TEXT_MAX_LENGTH,
    description: 'Mot de la cliente au salon — absent s’il n’y en a pas.',
  })
  public clientNote?: string;

  @ApiPropertyOptional({
    maxLength: LONG_TEXT_MAX_LENGTH,
    description:
      'Note interne du salon. Servie ici comme à l’agenda du comptoir — cette ' +
      'route vit derrière une garde `STAFF`, et le praticien en est souvent ' +
      'l’auteur. **Jamais servie au parcours public.**',
  })
  public staffNote?: string;
}

/** Le planning du praticien connecté — `myStaffAgendaSchema`. */
export class MyStaffAgendaDto implements MyStaffAgendaView {
  @ApiProperty({ format: 'uuid', description: 'La fiche que le jeton a résolue.' })
  public staffId!: string;

  @ApiProperty({ example: 'Europe/Paris' })
  public timezone!: string;

  @ApiProperty({
    example: '2026-09-01',
    description: 'La fenêtre **résolue** — celle que le salon a servie.',
  })
  public from!: string;

  @ApiProperty({ example: '2026-09-07' })
  public to!: string;

  @ApiProperty({ type: [MyStaffAppointmentDto], description: 'Triés chronologiquement.' })
  public appointments!: readonly MyStaffAppointmentView[];
}

/** Une plage de travail récurrente — `staffScheduleEntrySchema`. */
export class MyStaffScheduleEntryDto implements MyStaffScheduleEntryView {
  @ApiProperty({ enum: ISO_WEEKDAYS, example: 2, description: '1 lundi … 7 dimanche.' })
  public weekday!: number;

  @ApiProperty({ example: '09:00', description: 'Heure murale du salon.' })
  public startsAt!: string;

  @ApiProperty({ example: '18:00', description: 'Heure murale, borne **exclue**.' })
  public endsAt!: string;
}

/** Une absence du praticien — `staffTimeOffSchema`. */
export class MyStaffTimeOffDto implements MyStaffTimeOffView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ format: 'uuid' })
  public staffId!: string;

  @ApiProperty({ example: '2026-09-03T00:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ example: '2026-09-06T00:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({
    nullable: true,
    maxLength: REASON_MAX_LENGTH,
    description: 'Motif interne — `null` quand l’absence n’en porte pas.',
  })
  public reason!: string | null;
}

/** L'emploi du temps du praticien connecté — `myStaffScheduleSchema`. */
export class MyStaffScheduleDto implements MyStaffScheduleView {
  @ApiProperty({ format: 'uuid' })
  public staffId!: string;

  @ApiProperty({ example: 'Europe/Paris' })
  public timezone!: string;

  @ApiProperty({ example: '2026-09-01' })
  public from!: string;

  @ApiProperty({ example: '2026-09-07' })
  public to!: string;

  @ApiProperty({
    type: [MyStaffScheduleEntryDto],
    description:
      'Plages **récurrentes**, non découpées sur la fenêtre : « le mardi de 9 h ' +
      'à 18 h » n’appartient à aucune date.',
  })
  public entries!: readonly MyStaffScheduleEntryView[];

  @ApiProperty({
    type: [MyStaffTimeOffDto],
    description: 'Absences qui touchent la fenêtre, avec leurs bornes entières.',
  })
  public timeOff!: readonly MyStaffTimeOffView[];

  @ApiProperty({
    isArray: true,
    enum: ISO_WEEKDAYS,
    example: [7],
    description:
      'Jours de fermeture récurrents de l’établissement. Sans eux, un écran ' +
      'afficherait « lundi 9 h – 18 h » sur un lundi fermé.',
  })
  public closedWeekdays!: readonly number[];
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * Même patron que `list-appointments.dto.ts`, et pour la même raison : les
 * schémas décrivent ce que le **front lit** — `status` y normalise la casse de
 * l'énumération PostgreSQL —, si bien que valider notre propre sortie à
 * l'exécution changerait le format du fil.
 *
 * Ce que le contrat peut garder, c'est la **forme entrante** qu'il sait lire, et
 * il la garde à la compilation : jeu de clés exact d'un côté, assignabilité de
 * l'autre. Les deux coûtent zéro à l'exécution et échouent au `tsc`.
 */
type MyStaffProfileWire = z.input<typeof myStaffProfileSchema>;
type MyStaffAppointmentWire = z.input<typeof myStaffAppointmentSchema>;
type MyStaffAppointmentClientWire = z.input<typeof myStaffAppointmentClientSchema>;
type MyStaffAgendaWire = z.input<typeof myStaffAgendaSchema>;
type MyStaffScheduleWire = z.input<typeof myStaffScheduleSchema>;
type MyStaffScheduleEntryWire = z.input<typeof staffScheduleEntrySchema>;
type MyStaffTimeOffWire = z.input<typeof staffTimeOffSchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _MyStaffRangeQueryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffRangeQueryDto, keyof z.input<typeof myStaffRangeQuerySchema>>
  | Exclude<keyof z.input<typeof myStaffRangeQuerySchema>, keyof MyStaffRangeQueryDto>
>;

type _MyStaffProfileDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffProfileDto, keyof MyStaffProfileWire>
  | Exclude<keyof MyStaffProfileWire, keyof MyStaffProfileDto>
>;

type _MyStaffProfileDtoIsReadableByTheContract = AssertTrue<
  MyStaffProfileDto extends MyStaffProfileWire ? true : false
>;

type _MyStaffAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffAppointmentDto, keyof MyStaffAppointmentWire>
  | Exclude<keyof MyStaffAppointmentWire, keyof MyStaffAppointmentDto>
>;

type _MyStaffAppointmentDtoIsReadableByTheContract = AssertTrue<
  MyStaffAppointmentDto extends MyStaffAppointmentWire ? true : false
>;

type _MyStaffAppointmentClientDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffAppointmentClientDto, keyof MyStaffAppointmentClientWire>
  | Exclude<keyof MyStaffAppointmentClientWire, keyof MyStaffAppointmentClientDto>
>;

type _MyStaffAppointmentClientDtoIsReadableByTheContract = AssertTrue<
  MyStaffAppointmentClientDto extends MyStaffAppointmentClientWire ? true : false
>;

type _MyStaffAgendaDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffAgendaDto, keyof MyStaffAgendaWire>
  | Exclude<keyof MyStaffAgendaWire, keyof MyStaffAgendaDto>
>;

/**
 * Les deux réponses **à collection** sont tenues comme les autres, moins leurs
 * tableaux.
 *
 * Le jeu de clés seul ne suffit pas : un `from` qui deviendrait un `Date`, un
 * `timezone` qui deviendrait un `TimeZone` nominal, garderaient exactement les
 * mêmes clés, compileraient, et feraient échouer chez le front la lecture de
 * l'agenda **entier** — c'est précisément le mode de panne que ces assertions
 * existent pour attraper, et que les quatre autres DTO de ce fichier attrapent
 * déjà.
 *
 * Les collections sont écartées de la comparaison parce que `readonly T[]` n'est
 * pas assignable au `T[]` qu'infère `z.array(…)` : l'écart est une propriété du
 * type TypeScript, pas du fil — JSON ne connaît pas `readonly` —, et l'inclure
 * ferait échouer `tsc` sur une différence qui n'existe nulle part à l'exécution.
 * Ce qu'elles portent est tenu ailleurs, par les assertions de
 * `MyStaffAppointmentDto`, `MyStaffScheduleEntryDto` et `MyStaffTimeOffDto`.
 */
type _MyStaffAgendaDtoIsReadableByTheContract = AssertTrue<
  Omit<MyStaffAgendaDto, 'appointments'> extends Omit<MyStaffAgendaWire, 'appointments'>
    ? true
    : false
>;

type _MyStaffScheduleDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffScheduleDto, keyof MyStaffScheduleWire>
  | Exclude<keyof MyStaffScheduleWire, keyof MyStaffScheduleDto>
>;

/** Voir l'assertion de `MyStaffAgendaDto` : mêmes bornes, même raison. */
type _MyStaffScheduleDtoIsReadableByTheContract = AssertTrue<
  Omit<MyStaffScheduleDto, 'entries' | 'timeOff' | 'closedWeekdays'> extends Omit<
    MyStaffScheduleWire,
    'entries' | 'timeOff' | 'closedWeekdays'
  >
    ? true
    : false
>;

type _MyStaffScheduleEntryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffScheduleEntryDto, keyof MyStaffScheduleEntryWire>
  | Exclude<keyof MyStaffScheduleEntryWire, keyof MyStaffScheduleEntryDto>
>;

type _MyStaffScheduleEntryDtoIsReadableByTheContract = AssertTrue<
  MyStaffScheduleEntryDto extends MyStaffScheduleEntryWire ? true : false
>;

type _MyStaffTimeOffDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof MyStaffTimeOffDto, keyof MyStaffTimeOffWire>
  | Exclude<keyof MyStaffTimeOffWire, keyof MyStaffTimeOffDto>
>;

type _MyStaffTimeOffDtoIsReadableByTheContract = AssertTrue<
  MyStaffTimeOffDto extends MyStaffTimeOffWire ? true : false
>;
