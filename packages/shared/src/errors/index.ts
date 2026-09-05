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
  BOOKING_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  ERROR_CODES,
  IDENTITY_ERROR_CODES,
  PAYMENT_ERROR_CODES,
  TRANSPORT_ERROR_CODES,
  isKnownErrorCode,
} from './error-codes';
export type { ErrorCode } from './error-codes';
