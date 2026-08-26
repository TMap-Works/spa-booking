/**
 * Enveloppe d'erreur de l'API — la forme unique de **toute** réponse en échec.
 *
 * ```json
 * { "code": "SLOT_NO_LONGER_AVAILABLE", "message": "…", "details": {} }
 * ```
 *
 * Cette forme est déjà produite par `DomainExceptionFilter`
 * (`apps/api/src/common/filters/domain-exception.filter.ts`) : ce fichier la
 * décrit du côté du contrat, pour que le front la lise sans la redéclarer.
 *
 * Le schéma est **délibérément permissif sur `code`** — `z.string()` et non
 * `z.enum(ERROR_CODES)`. Le filtre retombe sur `HTTP_<statut>` pour un statut
 * qu'il ne sait pas nommer, et une API plus récente que le front déployé peut
 * introduire un code que celui-ci ignore. Un `z.enum` ferait échouer le parsing
 * de l'enveloppe elle-même, et le front perdrait jusqu'au message d'erreur.
 * Le tri se fait ensuite avec `isKnownErrorCode`.
 */

import { z } from 'zod';

import { ERROR_CODES, isKnownErrorCode } from './error-codes';
import type { ErrorCode } from './error-codes';

export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    /**
     * Données **non personnelles** qui complètent le message : un identifiant de
     * ressource, un nom de champ, une transition refusée. Jamais un nom de
     * client, un e-mail ou un secret — le filtre les expurge, mais la bonne
     * place pour cette donnée est le log, pas la réponse.
     */
    details: z.record(z.unknown()).default({}),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * `details` d'un `VALIDATION_ERROR` : la liste des violations produites par la
 * validation d'entrée, une chaîne par champ fautif.
 *
 * Ces messages citent des **noms de champs**, pas des valeurs : ils sont
 * affichables tels quels à côté du formulaire concerné.
 */
export const validationErrorDetailsSchema = z.object({
  violations: z.array(z.string()),
});

export type ValidationErrorDetails = z.infer<typeof validationErrorDetailsSchema>;

/**
 * `true` si `value` a la forme d'une enveloppe d'erreur de l'API.
 *
 * À utiliser sur le corps d'une réponse non-2xx avant d'en lire le `code` : une
 * erreur de passerelle (502 d'un ALB, page HTML d'un proxy) n'a pas cette forme,
 * et la traiter comme telle afficherait « undefined » à l'utilisateur.
 */
export function isApiError(value: unknown): value is ApiError {
  return apiErrorSchema.safeParse(value).success;
}

/**
 * Extrait le code d'erreur d'une réponse, ou `undefined` si le corps n'est pas
 * une enveloppe du contrat ou porte un code inconnu de ce paquet.
 *
 * C'est la porte d'entrée prévue pour le front : `switch` sur le résultat, et
 * une branche par défaut pour le reste.
 */
export function errorCodeOf(value: unknown): ErrorCode | undefined {
  const parsed = apiErrorSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return isKnownErrorCode(parsed.data.code) ? parsed.data.code : undefined;
}

/**
 * Construit une enveloppe d'erreur — pour les tests, les doublures d'API et le
 * mode hors-ligne du front.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return apiErrorSchema.parse({ code, message, details });
}

/** Les codes du contrat, sous la forme attendue par un `z.enum` d'entrée. */
export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];
