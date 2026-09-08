import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LONG_TEXT_MAX_LENGTH, createAppointmentRequestSchema, uuidSchema } from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { CreateAppointmentInput } from '../appointments.types';

/**
 * DTO de la prise de rendez-vous **au comptoir** (#461, premier critère de #50),
 * **validé par le contrat partagé** (#510).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `createAppointmentRequestSchema` de `@spa/shared` décrit cette forme, et c'est
 * lui qui juge le corps, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La classe ne porte plus que ses `@ApiProperty` — et **typer un paramètre de
 * handler par elle viderait le corps de la requête**.
 *
 * ## Le champ qui n'y est pas est le propos : `client`
 *
 * Le tunnel public porte des **coordonnées** (`BookAppointmentDto.client`) et
 * crée la fiche au passage ; cette route-ci porte un **identifiant de fiche**, et
 * n'en crée aucune. Le `.strict()` du contrat refuse donc en 400 un `client`
 * glissé dans ce corps — c'est le deuxième critère du ticket, et c'est
 * exactement la frontière que `bookGuestAppointmentRequestSchema` tient dans
 * l'autre sens, en refusant un `clientId`.
 *
 * Sans cette symétrie, un comptoir aurait pu faire créer une fiche là où il
 * croyait en désigner une, et se retrouver avec deux dossiers pour la même
 * cliente — ce que `@@unique([tenant_id, email])` n'aurait rattrapé que si les
 * deux saisies portaient rigoureusement la même adresse.
 *
 * ## `clientId` est **obligatoire** ici, facultatif dans le contrat
 *
 * C'est le seul écart, et il va dans le sens strict — celui que l'ADR 0008
 * autorise. `createAppointmentRequestSchema` le déclare `.optional()` parce
 * qu'il décrit aussi une forme que le parcours client pourrait servir un jour :
 * « le serveur prend le client de la session ». Cette route-ci vit derrière
 * `@AuthAtLeast('STAFF')` : le porteur du jeton est un membre du personnel, il
 * n'y a aucune cliente à en déduire. L'omettre est donc une saisie incomplète,
 * et un 400 nommant le champ vaut mieux qu'un rendez-vous posé au nom de
 * personne. Le tiroir de #50 n'envoie de toute façon jamais sans — son bouton
 * d'enregistrement est désactivé tant qu'aucune fiche n'est choisie.
 *
 * TODO(#536) : l'écart est tenu par le `.extend()` ci-dessous, en attendant que
 * le contrat sépare les deux formes. Le refermer côté `packages/shared`
 * demanderait d'y déclarer un schéma de back-office distinct — `clientId`
 * obligatoire — de celui que le parcours client servirait, et c'est une décision
 * de contrat, pas de module : le front d'`apps/web` lit le même schéma.
 */

/**
 * Le contrat de création, plus l'obligation de désigner une fiche.
 *
 * `.extend()` conserve le `.strict()` du schéma d'origine — un `client` ou un
 * `tenantId` glissé dans le corps reste refusé (tenant-isolation §2), et
 * `ZodValidationPipe` le vérifie au montage.
 */
const deskCreateAppointmentRequestSchema = createAppointmentRequestSchema.extend({
  clientId: uuidSchema,
});

/**
 * Le pipe de la demande de création au comptoir — c'est **lui** qui valide, et
 * non la classe ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const createAppointmentBody = new ZodValidationPipe(deskCreateAppointmentRequestSchema);

/** La demande de création, telle que le contrat la rend au contrôleur. */
export type CreateAppointmentBody = z.infer<typeof deskCreateAppointmentRequestSchema>;

/** La demande de création — la documentation du schéma ci-dessus. */
export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid', description: 'La prestation réservée.' })
  public serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Le praticien souhaité. **Facultatif** : l’omettre, c’est choisir « premier ' +
      'disponible » (CDC §1.4, #36) — le serveur affecte alors le premier praticien ' +
      'libre à cet instant, dans l’ordre du moteur de disponibilité, et tente le ' +
      'suivant si la base refuse son créneau.',
  })
  public staffId?: string;

  @ApiProperty({
    description:
      'Début du **soin** — l’instant proposé par le calendrier, tel qu’il s’est ' +
      'affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une date-heure ' +
      'nue obligerait le serveur à deviner un fuseau, et le comptoir consulté ' +
      'depuis un autre pays poserait tous ses rendez-vous décalés. Normalisé en ' +
      'UTC à la frontière.',
    example: '2026-09-01T09:00:00Z',
  })
  public startsAt!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'La fiche cliente, **dans l’établissement du jeton**. Une fiche inconnue — ou ' +
      'celle d’un autre établissement — rend 404, indistinctement : un refus qui ' +
      'les séparerait ferait de cette route une sonde d’annuaire.',
  })
  public clientId!: string;

  @ApiPropertyOptional({
    description: 'Mot de la cliente au salon — allergie, préférence, retard annoncé.',
    maxLength: LONG_TEXT_MAX_LENGTH,
  })
  public clientNote?: string;
}

/**
 * La demande sous la forme que le service attend.
 *
 * Le contrat distingue « absent » de « vide » ; le domaine ne connaît que
 * `null` — même conversion que `toGuestContact` et `toAgendaInput`, et pour la
 * même raison. `staffId` à `null` s'y lit « premier disponible » (#36).
 *
 * `offsetDateTimeSchema` a **déjà normalisé** la chaîne en instant UTC : le
 * `new Date` qui suit ne peut plus produire ni une date invalide, ni une
 * date-heure interprétée dans le fuseau de la machine.
 */
export function toCreateInput(body: CreateAppointmentBody): CreateAppointmentInput {
  return {
    serviceId: body.serviceId,
    staffId: body.staffId ?? null,
    startsAt: new Date(body.startsAt),
    clientId: body.clientId,
    clientNote: body.clientNote ?? null,
  };
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte — la garde de compilation du patron de `book-appointment.dto.ts`.
 */
type AssertNever<T extends never> = T;

type _CreateAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CreateAppointmentDto, keyof z.input<typeof deskCreateAppointmentRequestSchema>>
  | Exclude<keyof z.input<typeof deskCreateAppointmentRequestSchema>, keyof CreateAppointmentDto>
>;
