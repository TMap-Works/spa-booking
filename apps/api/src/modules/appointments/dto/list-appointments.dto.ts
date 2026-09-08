import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  appointmentSchema,
  serviceSummarySchema,
  staffMemberSummarySchema,
  userSummarySchema,
} from '@spa/shared';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsUUID } from 'class-validator';
import type { z } from 'zod';

import type { AppointmentStatus } from '../appointment-status';
import { APPOINTMENT_STATUSES } from '../appointment-status';
import { MAX_APPOINTMENT_RANGE_DAYS } from '../appointments.errors';
import type {
  AgendaAppointmentView,
  AgendaClientSummary,
  AgendaStaffSummary,
  ListAgendaInput,
  Money,
} from '../appointments.types';
import { MoneyDto } from './book-appointment.dto';
import { IsCalendarDate, OptionalPresent } from './validation';

/**
 * L'agenda du back-office — `GET /api/v1/appointments` (#444).
 *
 * ## Ce que #510 a substitué ici, et ce qu'il n'a pas pu
 *
 * La **borne** de la fenêtre vient du contrat depuis #510 — elle est réexportée
 * par `appointments.errors.ts`, qui l'importe de `@spa/shared`. La sortie, elle,
 * est tenue par les assertions de compilation en fin de fichier, contre
 * `appointmentSchema` et ses trois *summaries*.
 *
 * TODO(#536) : la **requête**, en revanche, reste sous `class-validator`, et
 * `appointmentListQuerySchema` ne peut pas la remplacer en l'état. Deux écarts,
 * dont le second change le contrat de la route :
 *
 * 1. **`statuses` arrive en chaîne ou en tableau.** Express rend une `string`
 *    pour `?statuses=pending` et un tableau pour la forme répétée ; le schéma du
 *    contrat déclare `z.array(...)` sans coercition, si bien que le filtre le
 *    plus courant du comptoir — un seul statut — sortirait en 400. Aucun schéma
 *    de requête du contrat ne coerce, `myAppointmentsQuerySchema` excepté ;
 * 2. **les deux `.refine()` du schéma jugent le couple `from`/`to`**, et un
 *    refus de `refine` sort en **400**. Cette route rend un **422
 *    `APPOINTMENT_RANGE_TOO_WIDE`**, et c'est délibéré : chaque date est bien
 *    écrite, c'est leur écart qui n'est pas servable. Monter le schéma
 *    changerait donc le code d'erreur que le calendrier lit, sans que rien ne le
 *    dise. La règle vit d'ailleurs dans le service et pas seulement ici, parce
 *    que c'est lui qui complète la borne absente avec la journée courante du
 *    salon — un schéma de requête ne la voit pas.
 *
 * Reste à faire, côté contrat : un schéma de requête qui coerce la forme
 * répétée d'Express, et le déplacement du jugement de la fenêtre hors des
 * `refine` — ou l'acceptation explicite que ce refus-là devienne un 400.
 */

/**
 * Les statuts tels que la **requête** les nomme — le vocabulaire du contrat.
 *
 * En minuscules, à la différence d'`APPOINTMENT_STATUSES` du module, qui porte la
 * casse de l'énumération PostgreSQL. Ce n'est pas une distraction : c'est ce que
 * le front envoie, parce que c'est ce qu'`appointmentStatusSchema` de
 * `@spa/shared` déclare. Accepter ici la casse de Prisma ferait refuser en 400 la
 * requête que le contrat décrit — et le calendrier ne saurait pas pourquoi.
 *
 * Elle est **dérivée** d'`APPOINTMENT_STATUSES` plutôt que recopiée : les deux
 * listes sont les mêmes mots, et un sixième statut ajouté au schéma se
 * répercuterait ici sans qu'on y pense — là où une copie aurait laissé la
 * requête refuser un statut que la réponse peut rendre.
 */
export const APPOINTMENT_STATUS_FILTERS = APPOINTMENT_STATUSES.map((status) =>
  status.toLowerCase(),
) as readonly string[];

/**
 * Le statut de la requête, dans le vocabulaire du domaine.
 *
 * Une mise en majuscules et rien d'autre — `no_show` devient `NO_SHOW`. La
 * conversion vit **ici**, à la frontière HTTP, pour la raison qui vaut pour
 * `NormalizeEmail` juste à côté : passé ce point, aucune couche n'a plus à se
 * demander dans quelle casse elle compare un statut.
 *
 * Exportée depuis #461 : `ChangeAppointmentStatusDto` traverse exactement la
 * même frontière, dans le même sens, avec la même liste de mots. Deux
 * conversions auraient pu diverger, et la divergence se serait vue en
 * production plutôt qu'à la compilation — les deux inférant `AppointmentStatus`.
 */
export function toDomainStatus(filter: string): AppointmentStatus {
  return filter.toUpperCase() as AppointmentStatus;
}

/**
 * Ce qu'un comptoir peut demander de son agenda — et rien de plus.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé dans
 * la chaîne de requête, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). L'établissement vient du jeton vérifié, et de lui seul.
 *
 * ## Un `clientId` ici, aucun sur `/appointments/mine` — et c'est l'inverse
 *
 * `MyAppointmentsQueryDto` n'en porte délibérément pas : la cliente y est celle
 * du jeton, et un champ l'aurait laissée à la main de l'appelant. Ici, l'appelant
 * **est** le salon — la route vit derrière `@AuthAtLeast('STAFF')` — et filtrer
 * l'agenda sur une fiche cliente est le geste courant du comptoir qui prépare un
 * rendez-vous. La frontière n'est pas le champ, c'est la porte.
 *
 * ## Ce que ce DTO ne valide pas
 *
 * Le **couple** `from` / `to`. Un décorateur de champ ne voit qu'un champ, et la
 * règle porte sur leur écart — d'autant que les deux bornes sont facultatives et
 * que c'est le service qui complète celle qui manque, avec la journée courante du
 * salon. Elle vit donc dans `AppointmentsService.listAgenda` et sort en 422
 * `APPOINTMENT_RANGE_TOO_WIDE`, jamais en 400 : chaque date est bien écrite,
 * c'est leur écart qui n'est pas servable.
 */
export class AppointmentListQueryDto {
  @ApiPropertyOptional({
    description:
      'Premier jour de la plage, date civile de l’établissement, borne comprise. ' +
      'Absent, l’agenda sert la journée courante du salon.',
    example: '2026-09-01',
  })
  @OptionalPresent()
  @IsCalendarDate()
  public from?: string;

  @ApiPropertyOptional({
    description:
      'Dernier jour de la plage, borne comprise. Absent, il vaut `from`. La ' +
      `plage ne peut excéder ${String(MAX_APPOINTMENT_RANGE_DAYS)} jours.`,
    example: '2026-09-07',
  })
  @OptionalPresent()
  @IsCalendarDate()
  public to?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restreindre à un praticien. Un identifiant inconnu ou d’un autre ' +
      'établissement rend une liste vide — jamais une erreur, faute de quoi cette ' +
      'route deviendrait une sonde d’annuaire.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public staffId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restreindre à une fiche cliente. Même régime que `staffId`.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public clientId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restreindre à une prestation. Même régime que `staffId`.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public serviceId?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: APPOINTMENT_STATUS_FILTERS,
    description:
      'Statuts retenus, répétés dans la chaîne de requête ' +
      '(`?statuses=pending&statuses=confirmed`). Absent, tous les statuts sont ' +
      'servis — un agenda montre aussi ce qui a été annulé.',
    example: ['pending', 'confirmed'],
  })
  @OptionalPresent()
  // Express rend une chaîne pour `?statuses=pending` et un tableau pour la forme
  // répétée. Sans cette normalisation, le filtre le plus courant du comptoir —
  // un seul statut — échouerait en 400 sur `@IsArray`, ce qui ferait passer une
  // requête parfaitement légitime pour une erreur de saisie.
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @ArrayNotEmpty({ message: 'statuses : au moins un statut' })
  @IsIn(APPOINTMENT_STATUS_FILTERS, {
    each: true,
    message: `statuses : valeurs acceptées — ${APPOINTMENT_STATUS_FILTERS.join(', ')}`,
  })
  public statuses?: string[];
}

/**
 * Le DTO sous la forme que le service reçoit.
 *
 * Le DTO distingue « absent » de « vide » ; le domaine, lui, ne connaît que
 * `null` — même conversion que `toGuestContact` et pour la même raison. Les
 * défauts, eux, ne sont **pas** appliqués ici : « aujourd'hui » dépend du fuseau
 * de l'établissement, que seul le service sait lire, et un défaut posé à la
 * frontière HTTP l'aurait figé sur celui de la machine.
 */
export function toAgendaInput(dto: AppointmentListQueryDto): ListAgendaInput {
  return {
    from: dto.from ?? null,
    to: dto.to ?? null,
    staffId: dto.staffId ?? null,
    clientId: dto.clientId ?? null,
    serviceId: dto.serviceId ?? null,
    statuses: dto.statuses === undefined ? null : dto.statuses.map(toDomainStatus),
  };
}

/** La cliente d'une ligne d'agenda — `userSummarySchema` du contrat. */
export class AgendaClientDto implements AgendaClientSummary {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Camille' })
  public firstName!: string;

  @ApiProperty({ example: 'Durand' })
  public lastName!: string;
}

/**
 * Le praticien d'une ligne d'agenda — `staffMemberSummarySchema`.
 *
 * Le **nom public**, jamais le compte : ni e-mail, ni rôle, ni état
 * d'activation. Un agenda affiche qui tient le rendez-vous, il n'administre pas
 * le personnel.
 */
export class AgendaStaffDto implements AgendaStaffSummary {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Camille' })
  public displayName!: string;
}

/**
 * La prestation d'une ligne d'agenda — `serviceSummarySchema`.
 *
 * `price` est le tarif **courant** du catalogue, à ne pas confondre avec le
 * `price` de la ligne, figé à la réservation. Les deux voyagent côte à côte
 * parce que le comptoir a besoin des deux : celui qu'on affiche au mur, et celui
 * que cette cliente-là doit.
 *
 * Les tampons de cabine n'y figurent pas — c'est la cadence interne du salon, et
 * `PublicServiceView` la cache déjà.
 */
export class AgendaServiceDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Massage 60 min' })
  public name!: string;

  @ApiProperty({ example: 60 })
  public durationMinutes!: number;

  @ApiProperty({ type: MoneyDto, description: 'Tarif courant du catalogue.' })
  public price!: Money;
}

/**
 * Une ligne de l'agenda du back-office — `appointmentSchema` du contrat.
 *
 * ## Ce qu'elle porte et qu'`AppointmentDto` ne porte pas
 *
 * Les trois *summaries*, parce qu'un agenda affiche des noms et non des
 * identifiants. `staffNote`, la note interne du praticien. `cancellationReason`,
 * le motif d'annulation. Les deux derniers sont des champs de back-office que le
 * contrat partagé et l'en-tête d'`AppointmentView` documentent comme « jamais
 * servis au parcours public » — et cette route est précisément la « sortie
 * distincte, gardée par un rôle » qu'ils annonçaient (#317, #40).
 *
 * ## Ce qu'elle ne porte pas, à la différence d'`AppointmentDto`
 *
 * `cancelledBy`. `appointmentSchema` ne le déclare pas : ce que le comptoir lit
 * de l'annulation, c'est **quand** et **pourquoi** — l'auteur sert au parcours
 * public à distinguer « vous avez annulé » de « le salon a annulé », question qui
 * ne se pose pas de ce côté du comptoir.
 *
 * ## Les champs facultatifs sont **absents**, jamais `null`
 *
 * `appointmentSchema` les déclare `.optional()` et non `.nullable()` : un `null`
 * explicite y échouerait, et tout l'agenda cesserait de se lire pour une note
 * absente. `required: false` sans `nullable` publie exactement cela.
 */
export class AgendaAppointmentDto implements AgendaAppointmentView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ enum: APPOINTMENT_STATUSES, example: 'CONFIRMED' })
  public status!: AppointmentStatus;

  @ApiProperty({ type: AgendaClientDto })
  public client!: AgendaClientSummary;

  @ApiProperty({ type: AgendaStaffDto })
  public staff!: AgendaStaffSummary;

  @ApiProperty({ type: AgendaServiceDto })
  public service!: AgendaServiceDto;

  @ApiProperty({ description: 'Début du soin, ISO 8601 UTC.', example: '2026-09-01T09:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Fin du soin, ISO 8601 UTC.', example: '2026-09-01T10:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({ type: MoneyDto, description: 'Prix figé au moment de la réservation.' })
  public price!: Money;

  @ApiPropertyOptional({ description: 'Mot de la cliente au salon — absent s’il n’y en a pas.' })
  public clientNote?: string;

  @ApiPropertyOptional({
    description:
      'Note interne du praticien. **Jamais servie au parcours public** : elle ne ' +
      'sort que par cette route, derrière une garde `STAFF`.',
  })
  public staffNote?: string;

  @ApiPropertyOptional({
    description: 'Instant de l’annulation, ISO 8601 UTC.',
    example: '2026-08-27T14:32:10.000Z',
  })
  public cancelledAt?: string;

  @ApiPropertyOptional({ description: 'Motif saisi à l’annulation — champ de back-office.' })
  public cancellationReason?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Le rendez-vous que celui-ci remplace, s’il est né d’un report.',
  })
  public rescheduledFromId?: string;

  @ApiProperty({
    description: 'Instant de création de la ligne, ISO 8601 UTC.',
    example: '2026-08-20T08:12:00.000Z',
  })
  public createdAt!: string;
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * `appointmentSchema` décrit ce que le **front lit**, pas ce que l'API **émet** :
 * son champ `status` normalise la casse de l'énumération PostgreSQL
 * (`CONFIRMED` → `confirmed`). Valider notre propre sortie contre lui à
 * l'exécution changerait donc le format du fil et casserait tout lecteur
 * d'agenda — c'est le premier point de vigilance de #510.
 *
 * Ce que le contrat peut garder, c'est la **forme entrante** qu'il sait lire —
 * `z.input<…>` —, et il la garde à la compilation. Les assertions ci-dessous
 * coûtent zéro à l'exécution et échouent au `tsc` :
 *
 * 1. le **jeu de clés** est exactement celui du schéma. Un champ ajouté d'un
 *    côté et pas de l'autre casse la compilation, là où il aurait autrement
 *    voyagé sans que personne ne le lise ;
 * 2. **chaque champ** est assignable à ce que le schéma sait lire — un
 *    `cancelledAt` passé de `string | undefined` à `string | null` ne
 *    traverserait plus, et c'est précisément la distinction que l'en-tête
 *    d'`AgendaAppointmentDto` défend.
 *
 * Même patron que `book-appointment.dto.ts`, sur les quatre formes de cette
 * route plutôt que sur une seule.
 */
type AgendaAppointmentWire = z.input<typeof appointmentSchema>;
type AgendaClientWire = z.input<typeof userSummarySchema>;
type AgendaStaffWire = z.input<typeof staffMemberSummarySchema>;
type AgendaServiceWire = z.input<typeof serviceSummarySchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _AgendaAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AgendaAppointmentDto, keyof AgendaAppointmentWire>
  | Exclude<keyof AgendaAppointmentWire, keyof AgendaAppointmentDto>
>;

type _AgendaAppointmentDtoIsReadableByTheContract = AssertTrue<
  AgendaAppointmentDto extends AgendaAppointmentWire ? true : false
>;

type _AgendaClientDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AgendaClientDto, keyof AgendaClientWire>
  | Exclude<keyof AgendaClientWire, keyof AgendaClientDto>
>;

type _AgendaClientDtoIsReadableByTheContract = AssertTrue<
  AgendaClientDto extends AgendaClientWire ? true : false
>;

type _AgendaStaffDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AgendaStaffDto, keyof AgendaStaffWire>
  | Exclude<keyof AgendaStaffWire, keyof AgendaStaffDto>
>;

type _AgendaStaffDtoIsReadableByTheContract = AssertTrue<
  AgendaStaffDto extends AgendaStaffWire ? true : false
>;

type _AgendaServiceDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AgendaServiceDto, keyof AgendaServiceWire>
  | Exclude<keyof AgendaServiceWire, keyof AgendaServiceDto>
>;

type _AgendaServiceDtoIsReadableByTheContract = AssertTrue<
  AgendaServiceDto extends AgendaServiceWire ? true : false
>;
