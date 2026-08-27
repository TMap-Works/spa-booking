import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

import { CANCELLATION_REASON_MAX_LENGTH, OptionalPresent, Trim } from './validation';

/**
 * DTO de l'annulation (#40) — **le même corps des deux côtés du comptoir**.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas. C'est ce qui rend structurellement
 * impossible ce qu'une annulation ne doit pas pouvoir faire — imposer un statut,
 * antidater la trace, ou se déclarer d'un autre auteur qu'elle n'est.
 *
 * ## Ce que ce corps **ne porte pas**, et qui compte plus que ce qu'il porte
 *
 * - **`cancelledBy`.** Il se déduit de la porte : la route publique dit
 *   `CLIENT`, celle de back-office dit `STAFF`. Un champ ici aurait laissé une
 *   cliente inscrire au registre du salon que le salon l'avait annulée — et
 *   fausser le seul chiffre que cette colonne existe pour établir (CDC §1.4).
 * - **`cancelledAt`.** L'horodatage vient du serveur. Le laisser au client
 *   permettrait d'antidater une annulation pour se ranger sous un délai de
 *   franchise que #48 posera.
 * - **`status`.** L'annulation a une destination, elle ne la choisit pas.
 *
 * TODO(#26) : cette forme appartient au contrat d'API et devra venir de
 * `@spa/shared` le jour où `apps/api` dépendra du paquet — même TODO que dans
 * `book-appointment.dto.ts` et `reschedule-appointment.dto.ts`.
 */
export class CancelAppointmentDto {
  @ApiPropertyOptional({
    description:
      'Motif de l’annulation, facultatif des deux côtés du comptoir. Le CDC ne ' +
      'le rend obligatoire ni pour la cliente — l’exiger ferait abandonner des ' +
      'annulations, donc laisserait des créneaux fantômes bloqués — ni pour le ' +
      'salon. Il est **enregistré** sur la ligne et n’est rendu par aucune ' +
      'réponse : un motif écrit par un praticien est une note interne.',
    maxLength: CANCELLATION_REASON_MAX_LENGTH,
    example: 'Empêchement de dernière minute',
  })
  // `OptionalPresent` et non `@IsOptional` : ce dernier laisserait passer un
  // `null` explicite jusqu'aux validateurs suivants, qu'il désarme aussi.
  @OptionalPresent()
  @IsString()
  // Élagué avant que la borne ne juge : sans cela, `"   "` passerait pour un
  // motif — trois espaces font trois caractères.
  @Trim()
  @MaxLength(CANCELLATION_REASON_MAX_LENGTH)
  public reason?: string;
}

/**
 * Le motif sous la forme que le domaine attend — jamais la chaîne vide.
 *
 * Le DTO distingue « absent » de « vide », le domaine ne connaît que `null`. Un
 * `body.reason ?? null` seul ne suffirait pas : `@Trim()` ramène `"   "` à `""`,
 * qui n'est ni `undefined` ni `null` et irait s'inscrire tel quel en base. La
 * colonne porterait alors un motif présent et vide, et un
 * `cancellation_reason IS NOT NULL` compterait comme motivée une annulation qui
 * ne l'est pas — exactement le chiffre que le deuxième critère de #40 existe
 * pour rendre lisible.
 */
export function toCancellationReason(dto: CancelAppointmentDto): string | null {
  const reason = dto.reason ?? '';
  return reason === '' ? null : reason;
}
