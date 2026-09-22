/**
 * Le message affichable de chaque code d'erreur, dans les deux langues — #845,
 * seconde fondation de l'épique #843.
 *
 * ## Pourquoi ici, et non dans les catalogues du front
 *
 * `error-codes.ts` est le contrat : **le front réagit sur `code`, jamais sur
 * `message`** (en-tête de ce fichier voisin). Mais il faut bien qu'une phrase
 * s'affiche, et cette phrase doit exister dans les deux langues pour chacun des
 * codes — c'est le critère d'acceptation de #845 : *« chaque code de
 * `error-codes.ts` a un message dans les deux langues, et un test échoue s'il en
 * manque un »*.
 *
 * Le rapprocher des codes est ce qui rend cette garantie **structurelle** plutôt
 * que déclarative : les deux tables sont typées `Record<ErrorCode, string>`, et
 * un code ajouté à `error-codes.ts` fait échouer `tsc` sur les deux langues à la
 * fois, sans qu'aucun test n'ait à le rattraper. Un catalogue JSON du front, lui,
 * n'aurait été relié aux codes par rien — c'est exactement la divergence que
 * `api-error-codes.spec.ts` a été écrit pour refermer.
 *
 * Ce ne sont pas pour autant les messages que l'**API** émet : ceux-là restent
 * ceux des `DomainError`, écrits pour un journal et pour le diagnostic. Ceux-ci
 * sont écrits pour la personne devant l'écran, et c'est le front qui les choisit,
 * sur la foi du code reçu.
 *
 * ## Ce qu'aucun de ces messages ne dit
 *
 * Rien de plus que le code ne dit déjà. Les règles de `error-codes.ts` valent
 * mot pour mot ici :
 *
 * - `INVALID_CREDENTIALS` ne distingue jamais l'adresse du mot de passe ;
 * - `CLIENT_EMAIL_NOT_BOOKABLE` ne qualifie pas l'adresse refusée — l'écrire
 *   ferait de ce refus un oracle sur l'annuaire du personnel ;
 * - `NOT_FOUND` ne dit pas « cet identifiant n'existe nulle part » : il couvre la
 *   ressource d'un autre établissement (tenant-isolation §4) ;
 * - aucun message ne cite Stripe, ni ne porte de donnée de carte.
 *
 * ## Le ton
 *
 * Une phrase complète, ponctuée, à la deuxième personne quand elle s'adresse à
 * qui vient d'agir. Elle **constate** et, quand il y a une suite, elle la donne :
 * un refus sans issue est une impasse, et c'est ce que
 * `docs/design/appointments/states.md` interdit.
 */

import type { Locale } from '../locale/index';

import { ERROR_CODES, isKnownErrorCode, type ErrorCode } from './error-codes';

/**
 * Les messages français.
 *
 * Typé `Record<ErrorCode, string>` et non `satisfies` : c'est l'annotation qui
 * fait échouer `tsc` sur un code **manquant**. Un `satisfies` n'aurait attrapé
 * que les clés en trop.
 */
const FR: Readonly<Record<ErrorCode, string>> = {
  /* --- Transport HTTP ----------------------------------------------------- */
  BAD_REQUEST: 'La demande n’a pas pu être lue. Vérifiez les informations saisies.',
  UNAUTHORIZED: 'Votre session n’est plus valable. Connectez-vous à nouveau.',
  FORBIDDEN: 'Votre compte n’a pas les droits nécessaires pour cette action.',
  NOT_FOUND: 'Cet élément est introuvable.',
  METHOD_NOT_ALLOWED: 'Cette action n’est pas possible ici.',
  NOT_ACCEPTABLE: 'Le format demandé n’est pas servi.',
  REQUEST_TIMEOUT: 'La demande a mis trop de temps. Réessayez.',
  CONFLICT: 'Cette action entre en conflit avec l’état actuel. Rechargez la page.',
  PAYLOAD_TOO_LARGE: 'Le contenu envoyé est trop volumineux.',
  UNSUPPORTED_MEDIA_TYPE: 'Ce type de contenu n’est pas accepté.',
  UNPROCESSABLE_ENTITY: 'Les informations envoyées ne peuvent pas être traitées en l’état.',
  TOO_MANY_REQUESTS: 'Trop de tentatives. Patientez un instant avant de réessayer.',
  INTERNAL_ERROR: 'Une erreur inattendue est survenue. Réessayez dans un instant.',
  SERVICE_UNAVAILABLE: 'Le service est momentanément indisponible. Réessayez dans un instant.',
  VALIDATION_ERROR: 'Certaines informations sont incomplètes ou mal formées.',

  /* --- Refus de domaine transverses -------------------------------------- */
  BUSINESS_RULE_VIOLATION: 'Cette action n’est pas autorisée par les règles du salon.',
  INVALID_STATE_TRANSITION: 'Cet élément n’est plus dans un état qui permette cette action.',

  /* --- identity ----------------------------------------------------------- */
  INVALID_CREDENTIALS: 'Adresse e-mail ou mot de passe incorrect.',
  EMAIL_ALREADY_REGISTERED: 'Un compte existe déjà avec cette adresse e-mail.',
  INVALID_REFRESH_TOKEN: 'Votre session a expiré. Connectez-vous à nouveau.',
  INVALID_INVITATION: 'Cette invitation n’est plus valable. Demandez-en une nouvelle.',
  INVITATION_ALREADY_ACCEPTED: 'Ce compte est déjà activé.',
  INVALID_PASSWORD_RESET_TOKEN:
    'Ce lien n’est plus valable. Demandez un nouveau lien de réinitialisation.',
  OWN_SCOPE_ONLY: 'Vous ne pouvez agir que sur votre propre périmètre.',
  INVALID_PLATFORM_CREDENTIALS: 'Identifiants refusés.',
  TENANT_SLUG_TAKEN: 'Cette adresse de salon n’est pas disponible. Choisissez-en une autre.',
  TENANT_ADMIN_MISSING: 'Ce salon n’a aucun compte administrateur à qui envoyer l’invitation.',
  SUBSCRIPTION_REQUIRED: 'L’abonnement de ce salon n’est pas en cours.',
  SALON_BOOKING_CLOSED: 'Ce salon n’accepte pas de réservation en ligne pour le moment.',

  /* --- catalog ------------------------------------------------------------ */
  SERVICE_SLUG_TAKEN: 'Une prestation porte déjà cette adresse dans ce salon.',
  SERVICE_CATEGORY_SLUG_TAKEN: 'Une rubrique porte déjà cette adresse dans ce salon.',
  SERVICE_STAFF_ALREADY_ASSIGNED: 'Ce praticien pratique déjà cette prestation.',
  STAFF_PROFILE_ALREADY_EXISTS: 'Ce compte a déjà une fiche praticien.',

  /* --- availability ------------------------------------------------------- */
  NON_EXISTENT_LOCAL_TIME: 'Cette heure n’existe pas ce jour-là : l’horloge a avancé.',
  AMBIGUOUS_LOCAL_TIME: 'Cette heure a lieu deux fois ce jour-là : précisez laquelle.',
  UNKNOWN_TIME_ZONE: 'Le fuseau horaire du salon n’est pas reconnu.',
  OVERLAPPING_SCHEDULE_RANGES: 'Deux plages du même jour se chevauchent.',
  TIME_OFF_RANGE_INVALID: 'Les dates de cette absence ne sont pas valables.',
  AVAILABILITY_RANGE_TOO_WIDE: 'La période demandée est trop longue. Réduisez-la.',

  /* --- appointments ------------------------------------------------------- */
  SLOT_NO_LONGER_AVAILABLE: 'Ce créneau vient d’être réservé. Choisissez-en un autre.',
  APPOINTMENT_RANGE_TOO_WIDE: 'La période affichée est trop longue. Réduisez-la.',
  STAFF_PROFILE_NOT_FOUND: 'Ce compte n’a pas de fiche praticien dans ce salon.',

  /* --- crm ---------------------------------------------------------------- */
  CUSTOMER_EMAIL_TAKEN: 'Une fiche de ce salon porte déjà cette adresse e-mail.',
  CLIENT_EMAIL_NOT_BOOKABLE:
    'Cette adresse e-mail ne peut pas porter de réservation en ligne. Saisissez-en une autre.',
  CUSTOMER_HAS_UPCOMING_APPOINTMENTS:
    'Cette fiche a encore des rendez-vous à venir : honorez-les ou annulez-les d’abord.',

  /* --- payments ----------------------------------------------------------- */
  BILLING_NOT_APPLICABLE: 'Ce salon n’est pas facturé par la plateforme.',
  BILLING_ACCOUNT_MISSING: 'Aucun compte de facturation n’a encore été ouvert pour ce salon.',
  APPOINTMENT_NOT_PAYABLE: 'Ce rendez-vous n’est plus payable en ligne.',
  APPOINTMENT_NOT_SETTLEABLE: 'Ce rendez-vous ne peut plus être encaissé.',
  PAYMENT_ALREADY_SETTLED: 'Cet encaissement est déjà abouti.',
  PAYMENT_PROVIDER_UNAVAILABLE:
    'Le service de paiement est momentanément indisponible. Réessayez dans un instant.',
  HISTORY_WINDOW_INVALID: 'La période demandée ne contient aucun instant.',
  PAYMENT_NOT_REFUNDABLE: 'Cet encaissement ne peut pas être remboursé.',
  REFUND_EXCEEDS_CAPTURED: 'Le remboursement demandé dépasse le montant encaissé.',
  INVALID_WEBHOOK_SIGNATURE: 'Cette notification de paiement n’est pas authentifiée.',
  WEBHOOK_NOT_CONFIGURED: 'La réception des notifications de paiement n’est pas configurée.',
  WEBHOOK_PAYLOAD_TOO_LARGE: 'Cette notification de paiement est trop volumineuse.',
  PRODUCT_SKU_TAKEN: 'Un article de ce salon porte déjà ce code.',
  SALE_ITEM_UNAVAILABLE: 'Un article du ticket n’est plus disponible à la vente.',
  SALE_CURRENCY_MISMATCH: 'Un article du ticket est libellé dans une autre devise que le salon.',
  SALE_AMOUNT_OUT_OF_RANGE: 'Le montant du ticket dépasse ce qui peut être enregistré.',
  SALE_ALREADY_SETTLED: 'Ce ticket est déjà soldé.',
  SALE_OVERPAYMENT: 'Le règlement dépasse le reste dû du ticket.',
  APPOINTMENT_TICKET_ALREADY_OPEN:
    'Ce rendez-vous porte déjà un ticket. Ouvrez une vente à part pour ces articles.',
  CURRENCY_MISMATCH: 'Deux devises différentes ne peuvent pas être additionnées.',

  /* --- notifications ------------------------------------------------------ */
  NOTIFICATION_SENDER_NOT_CONFIGURED: 'L’envoi de messages n’est pas configuré sur ce canal.',
  NOTIFICATION_NOT_RENDERABLE: 'Aucun modèle ne permet de composer ce message.',
  NOTIFICATION_CONTEXT_GONE: 'Le rendez-vous que ce message annonce n’existe plus.',
  INTERNAL_CALLER_NOT_CONFIGURED: 'Les appels internes ne sont pas configurés sur ce service.',
  INTERNAL_CALLER_REJECTED: 'Cet appel interne n’est pas reconnu.',
  NOTIFICATION_TEMPLATE_INVALID: 'Ce modèle de message comporte une erreur.',
  NOTIFICATION_TEMPLATE_TOO_LONG: 'Ce modèle de SMS est trop long.',
  NOTIFICATION_TEMPLATE_NOT_FOUND: 'Aucun modèle n’existe pour ce type de message.',

  /* --- reporting ---------------------------------------------------------- */
  REPORT_WINDOW_INVALID: 'La période demandée ne contient aucun instant.',
  REPORT_WINDOW_TOO_WIDE: 'La période demandée est trop longue. Réduisez-la.',
  REPORT_EXPORT_UNAVAILABLE: 'L’export n’est pas disponible sur cet environnement.',
};

/** Les mêmes refus, en anglais — la langue par défaut du système (#844). */
const EN: Readonly<Record<ErrorCode, string>> = {
  /* --- Transport HTTP ----------------------------------------------------- */
  BAD_REQUEST: 'The request could not be read. Check the details you entered.',
  UNAUTHORIZED: 'Your session is no longer valid. Please sign in again.',
  FORBIDDEN: 'Your account does not have the rights for this action.',
  NOT_FOUND: 'This item could not be found.',
  METHOD_NOT_ALLOWED: 'This action is not available here.',
  NOT_ACCEPTABLE: 'The requested format is not served.',
  REQUEST_TIMEOUT: 'The request took too long. Please try again.',
  CONFLICT: 'This action conflicts with the current state. Reload the page.',
  PAYLOAD_TOO_LARGE: 'The content you sent is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'This content type is not accepted.',
  UNPROCESSABLE_ENTITY: 'The details you sent cannot be processed as they stand.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a moment before trying again.',
  INTERNAL_ERROR: 'Something went wrong. Please try again in a moment.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again in a moment.',
  VALIDATION_ERROR: 'Some details are missing or incorrectly formatted.',

  /* --- Refus de domaine transverses -------------------------------------- */
  BUSINESS_RULE_VIOLATION: 'This action is not allowed by the salon’s rules.',
  INVALID_STATE_TRANSITION: 'This item is no longer in a state that allows this action.',

  /* --- identity ----------------------------------------------------------- */
  INVALID_CREDENTIALS: 'Incorrect email address or password.',
  EMAIL_ALREADY_REGISTERED: 'An account already exists with this email address.',
  INVALID_REFRESH_TOKEN: 'Your session has expired. Please sign in again.',
  INVALID_INVITATION: 'This invitation is no longer valid. Ask for a new one.',
  INVITATION_ALREADY_ACCEPTED: 'This account is already active.',
  INVALID_PASSWORD_RESET_TOKEN: 'This link is no longer valid. Request a new reset link.',
  OWN_SCOPE_ONLY: 'You can only act within your own scope.',
  INVALID_PLATFORM_CREDENTIALS: 'Credentials refused.',
  TENANT_SLUG_TAKEN: 'This salon address is not available. Please choose another.',
  TENANT_ADMIN_MISSING: 'This salon has no administrator account to send the invitation to.',
  SUBSCRIPTION_REQUIRED: 'This salon’s subscription is not active.',
  SALON_BOOKING_CLOSED: 'This salon is not taking online bookings at the moment.',

  /* --- catalog ------------------------------------------------------------ */
  SERVICE_SLUG_TAKEN: 'A service already uses this address in this salon.',
  SERVICE_CATEGORY_SLUG_TAKEN: 'A category already uses this address in this salon.',
  SERVICE_STAFF_ALREADY_ASSIGNED: 'This practitioner already offers this service.',
  STAFF_PROFILE_ALREADY_EXISTS: 'This account already has a practitioner record.',

  /* --- availability ------------------------------------------------------- */
  NON_EXISTENT_LOCAL_TIME: 'This time does not exist on that day: the clock moved forward.',
  AMBIGUOUS_LOCAL_TIME: 'This time occurs twice on that day: please say which one.',
  UNKNOWN_TIME_ZONE: 'The salon’s time zone is not recognised.',
  OVERLAPPING_SCHEDULE_RANGES: 'Two ranges on the same day overlap.',
  TIME_OFF_RANGE_INVALID: 'The dates of this time off are not valid.',
  AVAILABILITY_RANGE_TOO_WIDE: 'The requested period is too long. Please shorten it.',

  /* --- appointments ------------------------------------------------------- */
  SLOT_NO_LONGER_AVAILABLE: 'This slot has just been booked. Please choose another.',
  APPOINTMENT_RANGE_TOO_WIDE: 'The period shown is too long. Please shorten it.',
  STAFF_PROFILE_NOT_FOUND: 'This account has no practitioner record in this salon.',

  /* --- crm ---------------------------------------------------------------- */
  CUSTOMER_EMAIL_TAKEN: 'A record in this salon already uses this email address.',
  CLIENT_EMAIL_NOT_BOOKABLE:
    'This email address cannot carry an online booking. Please enter another one.',
  CUSTOMER_HAS_UPCOMING_APPOINTMENTS:
    'This record still has upcoming appointments: complete or cancel them first.',

  /* --- payments ----------------------------------------------------------- */
  BILLING_NOT_APPLICABLE: 'This salon is not billed by the platform.',
  BILLING_ACCOUNT_MISSING: 'No billing account has been opened for this salon yet.',
  APPOINTMENT_NOT_PAYABLE: 'This appointment can no longer be paid online.',
  APPOINTMENT_NOT_SETTLEABLE: 'This appointment can no longer be settled.',
  PAYMENT_ALREADY_SETTLED: 'This payment has already gone through.',
  PAYMENT_PROVIDER_UNAVAILABLE:
    'The payment service is temporarily unavailable. Please try again in a moment.',
  HISTORY_WINDOW_INVALID: 'The requested period contains no point in time.',
  PAYMENT_NOT_REFUNDABLE: 'This payment cannot be refunded.',
  REFUND_EXCEEDS_CAPTURED: 'The requested refund is more than the amount taken.',
  INVALID_WEBHOOK_SIGNATURE: 'This payment notification is not authenticated.',
  WEBHOOK_NOT_CONFIGURED: 'Receiving payment notifications is not configured.',
  WEBHOOK_PAYLOAD_TOO_LARGE: 'This payment notification is too large.',
  PRODUCT_SKU_TAKEN: 'A product in this salon already uses this code.',
  SALE_ITEM_UNAVAILABLE: 'An item on the ticket is no longer available for sale.',
  SALE_CURRENCY_MISMATCH: 'An item on the ticket is priced in a different currency to the salon.',
  SALE_AMOUNT_OUT_OF_RANGE: 'The ticket total is larger than can be recorded.',
  SALE_ALREADY_SETTLED: 'This ticket has already been settled.',
  SALE_OVERPAYMENT: 'The payment is more than the amount left to pay.',
  APPOINTMENT_TICKET_ALREADY_OPEN:
    'This appointment already has a ticket. Open a separate sale for these items.',
  CURRENCY_MISMATCH: 'Two different currencies cannot be added together.',

  /* --- notifications ------------------------------------------------------ */
  NOTIFICATION_SENDER_NOT_CONFIGURED: 'Sending messages is not configured on this channel.',
  NOTIFICATION_NOT_RENDERABLE: 'No template is available to compose this message.',
  NOTIFICATION_CONTEXT_GONE: 'The appointment this message announces no longer exists.',
  INTERNAL_CALLER_NOT_CONFIGURED: 'Internal calls are not configured on this service.',
  INTERNAL_CALLER_REJECTED: 'This internal call is not recognised.',
  NOTIFICATION_TEMPLATE_INVALID: 'This message template contains an error.',
  NOTIFICATION_TEMPLATE_TOO_LONG: 'This SMS template is too long.',
  NOTIFICATION_TEMPLATE_NOT_FOUND: 'No template exists for this type of message.',

  /* --- reporting ---------------------------------------------------------- */
  REPORT_WINDOW_INVALID: 'The requested period contains no point in time.',
  REPORT_WINDOW_TOO_WIDE: 'The requested period is too long. Please shorten it.',
  REPORT_EXPORT_UNAVAILABLE: 'Export is not available on this environment.',
};

/**
 * Les messages affichables, par langue puis par code.
 *
 * Figé à l'exécution, comme `ERROR_CODES` : un module qui écrirait dedans
 * changerait la phrase affichée pour tout le processus.
 */
export const ERROR_MESSAGES: Readonly<Record<Locale, Readonly<Record<ErrorCode, string>>>> =
  Object.freeze({ fr: Object.freeze(FR), en: Object.freeze(EN) });

/**
 * La phrase à afficher pour ce code, dans cette langue.
 *
 * `code` est volontairement `string` et non `ErrorCode` : ce qu'un corps
 * d'erreur porte peut être un `HTTP_<statut>` que le filtre d'exception a
 * fabriqué pour un statut qu'il ne sait pas nommer (`isKnownErrorCode`). Le
 * repli est alors `INTERNAL_ERROR` — la phrase générique — plutôt qu'un message
 * vide ou le code brut, qu'aucune cliente ne sait lire.
 *
 * L'appartenance se juge par `isKnownErrorCode` — un ensemble — et non par un
 * `code in table` : `in` remonte la chaîne de prototypes, et un corps d'erreur
 * portant `"toString"` ou `"constructor"` aurait alors rendu une **fonction**
 * là où le type promet une phrase.
 */
export function errorMessage(code: string, locale: Locale): string {
  const table = ERROR_MESSAGES[locale];

  return isKnownErrorCode(code) ? table[code] : table[ERROR_CODES.INTERNAL_ERROR];
}
