export {
  ERROR_CODE_VALUES,
  apiError,
  apiErrorSchema,
  errorCodeOf,
  isApiError,
  validationErrorDetailsSchema,
} from './api-error';
export type { ApiError, ValidationErrorDetails } from './api-error';

// Ce baril réexporte **nommément** : un groupe ajouté à `error-codes.ts` sans sa
// ligne ici ne remonte pas jusqu'à `@spa/shared`, et rien ne le signale — c'est
// `src/__tests__/contract-surface.spec.ts` qui garde la propriété.
export {
  APPOINTMENTS_ERROR_CODES,
  AVAILABILITY_ERROR_CODES,
  CATALOG_ERROR_CODES,
  CRM_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  ERROR_CODES,
  IDENTITY_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  PAYMENT_ERROR_CODES,
  REPORTING_ERROR_CODES,
  TRANSPORT_ERROR_CODES,
  isKnownErrorCode,
} from './error-codes';
export type { ErrorCode } from './error-codes';

// Les phrases affichables de ces codes, et celles des refus de validation —
// #845. Elles vivent auprès des codes plutôt que dans un catalogue du front :
// c'est l'annotation `Record<ErrorCode, string>` qui garantit qu'aucun code ne
// reste sans message dans l'une des deux langues.
export { ERROR_MESSAGES, errorMessage } from './error-messages';
// `messageKey` est ce que les schémas posent à la place d'une phrase (#1232) ;
// `VALIDATION_MESSAGES` est la table que `zodErrorMap` y lit.
export {
  DIAGNOSTIC_LOCALE,
  VALIDATION_MESSAGES,
  isValidationMessageKey,
  messageKey,
  validationMessage,
  validationPhrases,
  zodErrorMap,
} from './zod-messages';
export type { ValidationMessageKey, ValidationMessageVars } from './zod-messages';
