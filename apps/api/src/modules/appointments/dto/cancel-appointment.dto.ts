import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  type CancelAppointmentRequest,
  REASON_MAX_LENGTH,
  cancelAppointmentRequestSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import { optionalBody } from './validation';

/**
 * L'annulation (#40), **validée par le contrat partagé** (#510) — **le même
 * corps des deux côtés du comptoir**.
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `cancelAppointmentRequestSchema` de `@spa/shared` décrit cette forme, et c'est
 * lui qui juge le corps, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La classe ne porte plus que ses `@ApiProperty`, d'où sort `/api/docs` — et
 * **typer un paramètre de handler par elle viderait le corps de la requête**, le
 * `ValidationPipe` global appliquant `whitelist` à une classe qui n'a plus rien
 * à mettre sur sa liste blanche.
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
 * Les trois absences sont désormais tenues par le `.strict()` du contrat, qui
 * remplace `forbidNonWhitelisted` : un champ non déclaré est **refusé**, pas
 * silencieusement ignoré (tenant-isolation §2).
 *
 * ## L'écart constaté avant de substituer : aucun
 *
 * `reasonSchema` est `z.string().trim().max(REASON_MAX_LENGTH)`, c'est-à-dire
 * mot pour mot ce que la paire `@Trim()` + `@MaxLength(CANCELLATION_REASON_MAX_LENGTH)`
 * appliquait — la borne du DTO **était déjà** `REASON_MAX_LENGTH`, relayée par
 * `./validation`. L'élagage a lieu avant que la borne ne juge des deux côtés,
 * sans quoi `"   "` passerait pour un motif : trois espaces font trois
 * caractères. Et `@OptionalPresent()` refusait un `null` explicite là où
 * `.optional()` ne l'accepte pas davantage — Zod distingue l'absence de `null`
 * comme ce décorateur le faisait, à la différence d'`@IsOptional()`.
 */

/**
 * Le pipe de la demande d'annulation — c'est **lui** qui valide, et non la
 * classe ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 *
 * `optionalBody` l'enveloppe parce que **ce corps n'a aucun champ obligatoire** :
 * une annulation sans corps du tout répondait 200 avant la substitution, et doit
 * continuer de le faire. Voir l'en-tête de `optionalBody` pour ce qui a changé
 * sous cette route.
 */
export const cancelAppointmentBody = new ZodValidationPipe(
  optionalBody(cancelAppointmentRequestSchema),
);

/** La demande d'annulation, telle que le contrat la rend au contrôleur. */
export type CancelAppointmentBody = CancelAppointmentRequest;

/** La demande d'annulation — la documentation de `cancelAppointmentRequestSchema`. */
export class CancelAppointmentDto {
  @ApiPropertyOptional({
    description:
      'Motif de l’annulation, facultatif des deux côtés du comptoir. Le CDC ne ' +
      'le rend obligatoire ni pour la cliente — l’exiger ferait abandonner des ' +
      'annulations, donc laisserait des créneaux fantômes bloqués — ni pour le ' +
      'salon. Il est **enregistré** sur la ligne et n’est rendu par aucune ' +
      'réponse : un motif écrit par un praticien est une note interne. Élagué à ' +
      'la frontière : une saisie réduite à des espaces compte pour absente.',
    maxLength: REASON_MAX_LENGTH,
    example: 'Empêchement de dernière minute',
  })
  public reason?: string;
}

/**
 * Le motif sous la forme que le domaine attend — jamais la chaîne vide.
 *
 * Le contrat distingue « absent » de « vide », le domaine ne connaît que `null`.
 * Un `body.reason ?? null` seul ne suffirait pas : `reasonSchema` élague, donc
 * ramène `"   "` à `""`, qui n'est ni `undefined` ni `null` et irait s'inscrire
 * tel quel en base. La colonne porterait alors un motif présent et vide, et un
 * `cancellation_reason IS NOT NULL` compterait comme motivée une annulation qui
 * ne l'est pas — exactement le chiffre que le deuxième critère de #40 existe
 * pour rendre lisible.
 */
export function toCancellationReason(body: CancelAppointmentBody): string | null {
  const reason = body.reason ?? '';
  return reason === '' ? null : reason;
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte — la garde de compilation du patron de `book-appointment.dto.ts`.
 */
type AssertNever<T extends never> = T;

type _CancelAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CancelAppointmentDto, keyof z.input<typeof cancelAppointmentRequestSchema>>
  | Exclude<keyof z.input<typeof cancelAppointmentRequestSchema>, keyof CancelAppointmentDto>
>;
