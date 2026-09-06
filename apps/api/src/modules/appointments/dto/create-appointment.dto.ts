import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';

import type { CreateAppointmentInput } from '../appointments.types';
import { IsOffsetDateTime, LONG_TEXT_MAX_LENGTH, OptionalPresent, Trim } from './validation';

/**
 * DTO de la prise de rendez-vous **au comptoir** (#461, premier critère de #50).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas. C'est ce qui rend structurellement
 * impossibles les trois choses qu'une écriture de back-office ne doit pas
 * pouvoir faire — désigner son établissement, imposer un prix, imposer un
 * statut.
 *
 * ## Le champ qui n'y est pas est le propos : `client`
 *
 * Le tunnel public porte des **coordonnées** (`BookAppointmentDto.client`) et
 * crée la fiche au passage ; cette route-ci porte un **identifiant de fiche**, et
 * n'en crée aucune. `forbidNonWhitelisted` refuse donc en 400 un `client` glissé
 * dans ce corps — c'est le deuxième critère du ticket, et c'est exactement la
 * frontière que `createAppointmentRequestSchema.strict()` tient côté contrat, où
 * la forme invitée refuse symétriquement un `clientId`.
 *
 * Sans cette symétrie, un comptoir aurait pu faire créer une fiche là où il
 * croyait en désigner une, et se retrouver avec deux dossiers pour la même
 * cliente — ce que `@@unique([tenant_id, email])` n'aurait rattrapé que si les
 * deux saisies portaient rigoureusement la même adresse.
 *
 * ## `clientId` est **obligatoire** ici, facultatif dans le contrat
 *
 * L'écart est délibéré et va dans le sens strict.
 * `createAppointmentRequestSchema` le déclare `.optional()` parce qu'il décrit
 * aussi une forme que le parcours client pourrait servir un jour — « le serveur
 * prend le client de la session ». Cette route-ci vit derrière
 * `@AuthAtLeast('STAFF')` : le porteur du jeton est un membre du personnel, il
 * n'y a aucune cliente à en déduire. L'omettre est donc une saisie incomplète,
 * et un 400 nommant le champ vaut mieux qu'un rendez-vous posé au nom de
 * personne. Le tiroir de #50 n'envoie de toute façon jamais sans — son bouton
 * d'enregistrement est désactivé tant qu'aucune fiche n'est choisie.
 *
 * TODO(#26) : `createAppointmentRequestSchema` de
 * `packages/shared/src/schemas/appointment.ts` décrit cette forme et devra être
 * importé lors de la reprise groupée de ce TODO — la dépendance vers le paquet
 * existe depuis #463. Même TODO que dans
 * `book-appointment.dto.ts`. Le `clientId` obligatoire est le seul écart à
 * reporter alors, et il est documenté des deux côtés.
 */
export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid', description: 'La prestation réservée.' })
  @IsUUID('4')
  public serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Le praticien souhaité. **Facultatif** : l’omettre, c’est choisir « premier ' +
      'disponible » (CDC §1.4, #36) — le serveur affecte alors le premier praticien ' +
      'libre à cet instant, dans l’ordre du moteur de disponibilité, et tente le ' +
      'suivant si la base refuse son créneau.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public staffId?: string;

  @ApiProperty({
    description:
      'Début du **soin** — l’instant proposé par le calendrier, tel qu’il s’est ' +
      'affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une date-heure ' +
      'nue obligerait le serveur à deviner un fuseau, et le comptoir consulté ' +
      'depuis un autre pays poserait tous ses rendez-vous décalés.',
    example: '2026-09-01T09:00:00Z',
  })
  @IsOffsetDateTime()
  public startsAt!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'La fiche cliente, **dans l’établissement du jeton**. Une fiche inconnue — ou ' +
      'celle d’un autre établissement — rend 404, indistinctement : un refus qui ' +
      'les séparerait ferait de cette route une sonde d’annuaire.',
  })
  @IsUUID('4')
  public clientId!: string;

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
 * La demande sous la forme que le service attend.
 *
 * Le DTO distingue « absent » de « vide » ; le domaine ne connaît que `null` —
 * même conversion que `toGuestContact` et `toAgendaInput`, et pour la même
 * raison. `staffId` à `null` s'y lit « premier disponible » (#36).
 *
 * La chaîne d'instant a été validée comme date-heure à offset explicite par le
 * DTO : `new Date` ne peut plus produire ici ni une date invalide, ni une
 * date-heure interprétée dans le fuseau de la machine.
 */
export function toCreateInput(dto: CreateAppointmentDto): CreateAppointmentInput {
  return {
    serviceId: dto.serviceId,
    staffId: dto.staffId ?? null,
    startsAt: new Date(dto.startsAt),
    clientId: dto.clientId,
    clientNote: dto.clientNote ?? null,
  };
}
