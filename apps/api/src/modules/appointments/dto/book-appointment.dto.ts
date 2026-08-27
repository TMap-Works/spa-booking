import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import type { AppointmentStatus } from '../appointment-status';
import type { AppointmentView, GuestContact, Money } from '../appointments.types';
import {
  EMAIL_MAX_LENGTH,
  IsOffsetDateTime,
  LONG_TEXT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NormalizeEmail,
  OptionalPresent,
  PHONE_MAX_LENGTH,
  PHONE_PATTERN,
  Trim,
} from './validation';

/**
 * DTO de la réservation publique (#37).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé dans
 * le corps, qui est exactement la fuite que le scoping automatique supprime
 * (tenant-isolation §2). Sur une route publique, c'est la seule barrière avant le
 * service : il n'y a pas de garde à franchir.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API. `appointmentSchema` et
 * `createAppointmentRequestSchema` de `packages/shared/src/schemas/appointment.ts`
 * les décrivent déjà et devront être importés le jour où `apps/api` dépendra du
 * paquet — même TODO que dans `catalog/dto/service.dto.ts`.
 *
 * Un écart est à reprendre ce jour-là, et il est délibéré :
 * `createAppointmentRequestSchema` est `.strict()` et ne porte **pas** les
 * coordonnées d'une cliente sans compte — il suppose une session d'où tirer le
 * client. C'est la forme de la route de back-office (#50), pas celle du tunnel
 * public. Le contrat partagé devra donc gagner une variante « invité » ; l'issue
 * de suivi ouverte par #37 la porte.
 */

/**
 * Un montant, tel qu'il sort de l'API : entier dans la plus petite unité
 * monétaire, plus son code devise. **Jamais de flottant** (CLAUDE.md).
 */
export class MoneyDto implements Money {
  @ApiProperty({ description: 'Montant entier dans la plus petite unité — 3500 pour 35,00 €.' })
  @IsInt()
  public amountMinor!: number;

  @ApiProperty({ description: 'Code devise ISO 4217.', example: 'EUR' })
  @IsString()
  public currency!: string;
}

/**
 * Les coordonnées d'une cliente qui réserve **sans compte**.
 *
 * Aucun mot de passe, et il n'y en aura pas : ce formulaire crée une fiche
 * jointe au rendez-vous, pas une identité. Un visiteur qui veut un compte passe
 * par `/auth/register` (#21), et le tunnel n'a pas à le lui imposer pour prendre
 * un rendez-vous — c'est le quatrième critère de #37.
 */
export class GuestContactDto {
  @ApiProperty({ example: 'Camille', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  public firstName!: string;

  @ApiProperty({ example: 'Rakoto', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  public lastName!: string;

  @ApiProperty({
    description:
      'Canonisée avant écriture — élaguée, en minuscules. C’est ce qui rend ' +
      'l’unicité (tenant, e-mail) fiable, la contrainte de base portant sur les octets.',
    example: 'camille@example.test',
    maxLength: EMAIL_MAX_LENGTH,
  })
  @IsString()
  @NormalizeEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsEmail({}, { message: 'email : adresse e-mail invalide' })
  public email!: string;

  @ApiPropertyOptional({
    description:
      'Facultatif : le SMS de rappel est un confort, l’e-mail de confirmation est ' +
      'le canal obligatoire. Format libre borné — une validation stricte par pays ' +
      'refuserait des numéros valides, donc des réservations.',
    example: '+261 34 12 345 67',
    maxLength: PHONE_MAX_LENGTH,
  })
  @OptionalPresent()
  @IsString()
  @Trim()
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(PHONE_PATTERN, { message: 'phone : numéro de téléphone invalide' })
  public phone?: string;
}

/**
 * La demande de réservation.
 *
 * **Aucun `endsAt`.** La cliente choisit un début et une prestation ; la fin se
 * dérive de la durée du catalogue, côté serveur. Laisser le client l'envoyer
 * reviendrait à lui laisser réserver une heure de fauteuil pour un soin de
 * quinze minutes — ou l'inverse, et à faire chevaucher le suivant.
 *
 * **Aucun `price`** non plus, pour la même raison portée à l'argent : le tarif
 * est celui du catalogue au moment de la réservation, jamais celui que le
 * navigateur annonce.
 */
export class BookAppointmentDto {
  @ApiProperty({ format: 'uuid', description: 'La prestation réservée.' })
  @IsUUID('4')
  public serviceId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Le praticien qui tient le créneau. Il est **désigné**, jamais choisi au ' +
      'moment du POST : le choisir ici rouvrirait la fenêtre de concurrence que ' +
      'le créneau sert à fermer.',
  })
  @IsUUID('4')
  public staffId!: string;

  @ApiProperty({
    description:
      'Début du **soin** — l’instant proposé par le calendrier, tel qu’il s’est ' +
      'affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une date-heure ' +
      'nue obligerait le serveur à deviner un fuseau.',
    example: '2026-09-01T09:00:00Z',
  })
  @IsOffsetDateTime()
  public startsAt!: string;

  @ApiProperty({ type: GuestContactDto })
  // `@IsDefined` est indispensable : class-validator **saute** la validation
  // imbriquée quand la valeur est `undefined`. Sans lui, un corps sans `client`
  // traverse la validation intact et le service déréférence `input.client.email`
  // — un 500 là où le contrat annonce un 400 nommant le champ.
  @IsDefined({ message: 'client : les coordonnées sont obligatoires' })
  // `@Type` est indispensable aussi : sans lui, `class-transformer` laisse un
  // objet nu et `@ValidateNested` n'a aucune classe sur laquelle rejouer les
  // validateurs — l'adresse traverserait sans être regardée.
  @ValidateNested()
  @Type(() => GuestContactDto)
  public client!: GuestContactDto;

  @ApiPropertyOptional({
    description: 'Mot de la cliente au salon — allergie, préférence, retard annoncé.',
    maxLength: LONG_TEXT_MAX_LENGTH,
  })
  @OptionalPresent()
  @IsString()
  @Trim()
  @MaxLength(LONG_TEXT_MAX_LENGTH)
  public clientNote?: string;
}

/**
 * Le rendez-vous tel qu'il sort de l'API.
 *
 * `startsAt` et `endsAt` sont l'intervalle **facturé** : le soin, sans les
 * tampons de cabine. C'est ce que la cliente a réservé et ce que son écran de
 * confirmation doit afficher — les tampons sont la cadence interne du salon, que
 * le catalogue public cache déjà.
 *
 * Ni `tenantId`, ni `staffNote` : le premier n'apprend rien à l'appelant et
 * invite aux essais (tenant-isolation §4), le second est un champ de back-office
 * que le contrat partagé documente comme « jamais servi au parcours public ».
 */
export class AppointmentDto implements AppointmentView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({
    description:
      '`PENDING` à la création : le rendez-vous occupe l’agenda avant même sa ' +
      'confirmation. Un report **reprend** le statut du rendez-vous remplacé — ' +
      'déplacer un créneau n’annule pas une confirmation déjà obtenue.',
    example: 'PENDING',
  })
  public status!: AppointmentStatus;

  @ApiProperty({ format: 'uuid' })
  public serviceId!: string;

  @ApiProperty({ format: 'uuid' })
  public staffId!: string;

  @ApiProperty({ format: 'uuid', description: 'La fiche cliente, créée si elle n’existait pas.' })
  public clientId!: string;

  @ApiProperty({ description: 'Début du soin, ISO 8601 UTC.', example: '2026-09-01T09:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Fin du soin, ISO 8601 UTC.', example: '2026-09-01T10:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({ type: MoneyDto, description: 'Prix figé au moment de la réservation.' })
  public price!: MoneyDto;

  @ApiProperty({ nullable: true, type: String })
  public clientNote!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'Le rendez-vous que celui-ci remplace, ou `null` s’il a été pris ' +
      'directement. C’est ce qui permet à l’écran de confirmation d’un report ' +
      'd’annoncer un déplacement plutôt qu’une réservation neuve.',
  })
  public rescheduledFromId!: string | null;
}

/** Les coordonnées validées, sous la forme que le service attend. */
export function toGuestContact(dto: GuestContactDto): GuestContact {
  return {
    firstName: dto.firstName,
    lastName: dto.lastName,
    email: dto.email,
    // Le DTO distingue « absent » de « vide » ; le domaine, lui, ne connaît que
    // `null` — c'est ce que la colonne `users.phone` accepte.
    phone: dto.phone ?? null,
  };
}
