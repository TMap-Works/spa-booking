import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import type { StaffTimeOffView } from '../staff-time-off.types';
import {
  IsOffsetDateTime,
  OptionalPresent,
  REASON_MAX_LENGTH,
  ToUtcInstant,
  Trim,
} from './validation';

/**
 * DTO des plages bloquées et congés — #33.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans le corps, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). Aucun DTO d'entrée n'en déclare, aucun DTO de sortie
 * n'en porte : l'établissement vient du jeton vérifié.
 *
 * ## Pourquoi des instants, et pas des dates civiles
 *
 * « Du 3 au 5 août » n'est pas un intervalle : il ne commence pas au même moment
 * à Papeete et à Paris. Accepter une date nue obligerait le serveur à **deviner**
 * un fuseau — celui du tenant ? celui du navigateur ? — et c'est exactement le
 * choix qu'`IsOffsetDateTime` interdit de faire (#41). L'appelant, qui connaît le
 * fuseau de l'établissement puisque l'API le lui rend, pose des bornes à offset
 * explicite ; `ToUtcInstant` les normalise en UTC à la frontière, et plus aucune
 * couche n'a ensuite à se demander dans quel référentiel elle lit.
 *
 * ## Ce que ces DTO ne valident pas
 *
 * Le couple `startsAt` / `endsAt`. Un décorateur de champ ne voit qu'un champ,
 * et une modification partielle ne fournit qu'une des deux bornes — l'autre se
 * lit en base. La règle vit donc dans `StaffTimeOffService`, en un seul endroit
 * pour la création comme pour la modification, et sort en 422
 * (`TIME_OFF_RANGE_INVALID`) plutôt qu'en 400 : la requête est bien formée, ce
 * sont ses valeurs prises ensemble qui ne tiennent pas.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/availability.ts` ; elles devront en être
 * importées.
 */

export class CreateStaffTimeOffDto {
  @ApiProperty({ format: 'uuid', description: 'Praticien absent.' })
  @IsUUID('4')
  public staffId!: string;

  @ApiProperty({
    description:
      'Début de l’absence, ISO 8601 avec offset explicite. Pour un congé en ' +
      'journées pleines, minuit local du premier jour.',
    example: '2026-08-03T00:00:00+02:00',
  })
  @IsOffsetDateTime()
  @ToUtcInstant()
  public startsAt!: string;

  @ApiProperty({
    description:
      'Fin de l’absence, borne **exclue** : un congé du 3 au 5 se termine à ' +
      'minuit local du 6, et un rendez-vous à cet instant reste réservable.',
    example: '2026-08-06T00:00:00+02:00',
  })
  @IsOffsetDateTime()
  @ToUtcInstant()
  public endsAt!: string;

  @ApiPropertyOptional({
    description: 'Motif interne, jamais exposé hors back-office.',
    maxLength: REASON_MAX_LENGTH,
    example: 'Formation',
  })
  @OptionalPresent()
  @IsString()
  @Trim()
  @MaxLength(REASON_MAX_LENGTH)
  public reason?: string;
}

/**
 * Modification d'une absence — tous les champs facultatifs.
 *
 * `staffId` n'y figure pas, et c'est délibéré : déplacer une absence d'un
 * praticien à un autre n'est pas une modification, c'est une absence retirée et
 * une autre posée. L'autoriser ferait porter à une seule requête deux agendas
 * rouverts, pour un geste que personne ne fait — et `forbidNonWhitelisted` le
 * refuse explicitement en 400 plutôt que de l'ignorer en silence.
 *
 * `reason` accepte `null` — il vaut « efface ce motif ». Les bornes refusent
 * `null` : une absence sans début n'existe pas.
 */
export class UpdateStaffTimeOffDto {
  @ApiPropertyOptional({ example: '2026-08-03T00:00:00+02:00' })
  @OptionalPresent()
  @IsOffsetDateTime()
  @ToUtcInstant()
  public startsAt?: string;

  @ApiPropertyOptional({ example: '2026-08-06T00:00:00+02:00' })
  @OptionalPresent()
  @IsOffsetDateTime()
  @ToUtcInstant()
  public endsAt?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '`null` efface le motif.',
    maxLength: REASON_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(REASON_MAX_LENGTH)
  public reason?: string | null;
}

/**
 * Fenêtre du planning d'absences.
 *
 * `from` et `to` sont **obligatoires** et bornés à un an, pour la même raison
 * que la fenêtre de disponibilité : sans eux, un établissement de dix ans
 * d'historique rendrait dix ans d'absences à chaque ouverture du planning. Le
 * plafond est vérifié par le service, avec les mêmes bornes qu'une absence.
 *
 * Une absence est retenue dès qu'elle **recoupe** la fenêtre : un congé commencé
 * le mois dernier et courant toujours apparaît au planning de ce mois-ci.
 */
export class ListStaffTimeOffQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restreindre à un praticien. Absent, le planning couvre tout l’établissement.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public staffId?: string;

  @ApiProperty({ example: '2026-08-01T00:00:00+02:00' })
  @IsOffsetDateTime()
  @ToUtcInstant()
  public from!: string;

  @ApiProperty({ example: '2026-09-01T00:00:00+02:00' })
  @IsOffsetDateTime()
  @ToUtcInstant()
  public to!: string;
}

/**
 * L'absence telle qu'elle sort de l'API.
 *
 * **Sans `tenantId`** : c'est une information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4). C'est pour cela
 * qu'aucune entité Prisma ne sort d'un contrôleur (api-module §4).
 *
 * `reason` y figure parce que **toutes** les routes de ce contrôleur sont
 * gardées au rang `STAFF` au minimum : il n'y a pas de lecture publique de cette
 * ressource. Ce qui traverse vers le parcours client, ce sont les intervalles
 * de `StaffBusyRange` — qui ne portent pas de motif.
 */
export class StaffTimeOffDto implements StaffTimeOffView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ format: 'uuid' })
  public staffId!: string;

  @ApiProperty({ description: 'Instant UTC, suffixé « Z ».', example: '2026-08-02T22:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Instant UTC, borne exclue.', example: '2026-08-05T22:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({ nullable: true, type: String })
  public reason!: string | null;
}
