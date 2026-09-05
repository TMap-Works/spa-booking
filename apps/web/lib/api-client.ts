/**
 * Le seul point d'accès à l'API (skill web-frontend §2).
 *
 * Aucun `fetch` vers l'API ailleurs dans `apps/web` : les composants passent par
 * les fonctions de ce module, ou par les actions serveur qui les appellent.
 *
 * ## Pourquoi ce client ne s'exécute que côté serveur
 *
 * Il lit `process.env.API_URL`, une variable **non** préfixée `NEXT_PUBLIC_` :
 * elle n'existe donc que dans le processus Next, jamais dans le bundle envoyé au
 * navigateur. C'est délibéré, et cela vaut trois choses :
 *
 * - l'adresse de l'API n'est pas figée dans le JavaScript au moment du build,
 *   donc une même image se déploie en dev, en recette et en production ;
 * - le navigateur ne parle qu'à son propre domaine, donc pas de CORS à ouvrir
 *   ni de préflight sur le chemin critique de la réservation ;
 * - le jour où la session sera un cookie httpOnly, elle sera lue ici et jamais
 *   exposée à un XSS.
 *
 * Les Client Components ne l'importent pas : ils appellent les actions serveur
 * de `app/(booking)/[tenantSlug]/reservation/actions.ts`.
 *
 * ## Les types viennent tous de `@spa/shared`
 *
 * Rien n'est redéclaré ici. Chaque réponse est **rejouée contre son schéma
 * Zod** plutôt que transtypée : une API qui changerait de forme doit échouer à
 * la frontière, avec un message qui nomme le champ, et non trois écrans plus
 * loin sur un `undefined`.
 */

import {
  apiErrorSchema,
  appointmentSchema,
  authSessionResponseSchema,
  availabilityResponseSchema,
  bookedAppointmentSchema,
  customerPageSchema,
  customerSchema,
  publicServiceSchema,
  publicTenantSchema,
  serviceCategorySchema,
  serviceSchema,
  serviceStaffMemberSchema,
  sessionUserSchema,
  tenantSchema,
  type Appointment,
  type AppointmentListQuery,
  type AssignServiceStaffRequest,
  type AuthSessionResponse,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BookGuestAppointmentRequest,
  type BookedAppointment,
  type CancelAppointmentRequest,
  type ChangeAppointmentStatusRequest,
  type CreateAppointmentRequest,
  type CreateCustomerRequest,
  type CreateServiceCategoryRequest,
  type CreateServiceRequest,
  type Customer,
  type CustomerPage,
  type CustomerSearchQuery,
  type LoginRequest,
  type MyAppointmentsQuery,
  type PublicService,
  type PublicTenant,
  type RegisterRequest,
  type RescheduleAppointmentRequest,
  type Service,
  type ServiceCategory,
  type ServiceStaffMember,
  type SessionUser,
  type Tenant,
  type UpdateProfileRequest,
  type UpdateServiceCategoryRequest,
  type UpdateServiceRequest,
  type UpdateTenantRequest,
} from '@spa/shared';
import { z } from 'zod';

// Les deux formes d'encaissement que l'API sert et que `@spa/shared` ne décrit
// pas encore telles quelles. La raison — et le TODO(#26) qui les y ramènera —
// est dans l'en-tête de `lib/admin/payment-contract.ts`.
import {
  appointmentPaymentIntentSchema,
  paymentTransactionSchema,
  type AppointmentPaymentIntent,
  type PaymentTransaction,
} from '@/lib/admin/payment-contract';

/**
 * Erreur d'API, telle que les écrans la lisent.
 *
 * Les composants réagissent sur `code`, **jamais sur `message`** : le message
 * est destiné à un humain, il est traduisible et peut changer sans préavis.
 * `code` est le contrat.
 *
 * `code` est un `string` et non un `ErrorCode` : le filtre d'exception de l'API
 * retombe sur `HTTP_<statut>` pour un statut qu'il ne sait pas nommer, et un
 * transtypage optimiste ferait croire à une exhaustivité qui n'existe pas.
 */
export class ApiClientError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: Record<string, unknown>;

  public constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Racine de l'API, préfixe global et version compris.
 *
 * `API_URL` désigne l'hôte seul (`http://localhost:3001`), comme dans
 * `.env.example` ; le `/api/v1` est une propriété de l'API, pas du
 * déploiement — le figer ici évite qu'un environnement l'oublie et qu'une route
 * réponde 404 pour une raison de configuration.
 */
function apiBaseUrl(): string {
  const host = process.env['API_URL'] ?? 'http://localhost:3001';

  return `${host.replace(/\/+$/, '')}/api/v1`;
}

/** Espace public d'un établissement — c'est le chemin qui désigne le tenant. */
function publicPath(tenantSlug: string, suffix = ''): string {
  return `/public/${encodeURIComponent(tenantSlug)}${suffix}`;
}

interface RequestOptions<TSchema extends z.ZodTypeAny> {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly schema: TSchema;
  /**
   * Cache Next. `no-store` par défaut : disponibilités et rendez-vous changent
   * sous concurrence, et servir un créneau depuis un cache est exactement ce qui
   * produit un 409 à la validation.
   */
  readonly cache?: RequestCache;
}

async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  options: RequestOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const method = options.method ?? 'GET';

  // `init` est composé plutôt que déclaré d'un bloc : sous
  // `exactOptionalPropertyTypes`, un `body: undefined` explicite n'est pas la
  // même chose qu'un `body` absent, et `fetch` refuse le premier.
  const init: RequestInit =
    options.body === undefined
      ? { method, headers: { accept: 'application/json' }, cache: options.cache ?? 'no-store' }
      : {
          method,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(options.body),
          cache: options.cache ?? 'no-store',
        };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, init);
  } catch (cause) {
    // L'API injoignable n'est pas une erreur d'API : elle n'a pas de code, et un
    // écran qui l'afficherait comme un refus métier tromperait le visiteur.
    throw new ApiClientError(
      'SERVICE_UNAVAILABLE',
      "Le service de réservation est momentanément injoignable. Merci de réessayer dans un instant.",
      503,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);

    throw parsed.success
      ? new ApiClientError(parsed.data.code, parsed.data.message, response.status, parsed.data.details)
      : new ApiClientError(
          `HTTP_${String(response.status)}`,
          'Une erreur inattendue est survenue.',
          response.status,
        );
  }

  const parsed = options.schema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiClientError(
      'INTERNAL_ERROR',
      `La réponse de l’API ne respecte pas le contrat sur ${path}.`,
      response.status,
      { issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    );
  }

  return parsed.data as z.infer<TSchema>;
}

/** Vitrine publique de l'établissement — dont son fuseau, qui sert à tout afficher. */
export function fetchPublicTenant(tenantSlug: string): Promise<PublicTenant> {
  return request(publicPath(tenantSlug), { schema: publicTenantSchema });
}

/** Catalogue public : prestations actives et praticiens qui les tiennent. */
export function fetchPublicServices(tenantSlug: string): Promise<PublicService[]> {
  return request(publicPath(tenantSlug, '/services'), { schema: z.array(publicServiceSchema) });
}

/** Créneaux libres, découpés en journées dans le fuseau de l'établissement. */
export function fetchAvailability(
  tenantSlug: string,
  query: AvailabilityQuery,
): Promise<AvailabilityResponse> {
  // `from` et `to` sont obligatoires dans `availabilityQuerySchema` — les
  // rendre conditionnels ferait croire à une fenêtre par défaut côté serveur,
  // qui n'existe pas. Seul `staffId` est facultatif : l'omettre, c'est
  // « n'importe quel praticien », et l'envoyer vide serait un identifiant vide.
  const search = new URLSearchParams({
    serviceId: query.serviceId,
    from: query.from,
    to: query.to,
  });

  if (query.staffId !== undefined) {
    search.set('staffId', query.staffId);
  }

  // Le rendez-vous que l'appelant s'apprête à déplacer, et qui ne doit donc pas
  // s'occuper lui-même (#442). Facultatif de la même façon que `staffId` : seul
  // l'écran de report le renseigne, et sa présence suffit à faire contourner le
  // cache côté serveur.
  if (query.excludeAppointmentId !== undefined) {
    search.set('excludeAppointmentId', query.excludeAppointmentId);
  }

  return request(publicPath(tenantSlug, `/availability?${search.toString()}`), {
    schema: availabilityResponseSchema,
  });
}

/** Réservation par une cliente sans compte. */
export function bookGuestAppointment(
  tenantSlug: string,
  body: BookGuestAppointmentRequest,
): Promise<BookedAppointment> {
  return request(publicPath(tenantSlug, '/appointments'), {
    method: 'POST',
    body,
    schema: bookedAppointmentSchema,
  });
}

/**
 * Annulation depuis le lien de l'écran de confirmation.
 *
 * L'autorisation repose sur la connaissance de l'identifiant du rendez-vous —
 * un UUID v4, non énumérable. Aucun jeton n'est exigé : la cliente qui vient de
 * réserver sans compte n'en a pas.
 */
export function cancelAppointment(
  tenantSlug: string,
  appointmentId: string,
  body: CancelAppointmentRequest = {},
): Promise<BookedAppointment> {
  return request(
    publicPath(tenantSlug, `/appointments/${encodeURIComponent(appointmentId)}/cancel`),
    { method: 'POST', body, schema: bookedAppointmentSchema },
  );
}

/**
 * Report depuis le lien de l'écran de confirmation, ou depuis l'espace client.
 *
 * Même régime d'autorisation que l'annulation, et pour la même raison : on
 * réserve sans compte, donc on reporte sans compte. Ce qui autorise l'appel est
 * la connaissance de l'identifiant du rendez-vous.
 *
 * La réponse est un rendez-vous **neuf** — le report est une annulation suivie
 * d'une création liée, jamais une mise à jour des dates en place. L'appelant
 * remplace celui qu'il gardait ; `rescheduledFromId` le relie au précédent.
 */
export function rescheduleAppointment(
  tenantSlug: string,
  appointmentId: string,
  body: RescheduleAppointmentRequest,
): Promise<BookedAppointment> {
  return request(
    publicPath(tenantSlug, `/appointments/${encodeURIComponent(appointmentId)}/reschedule`),
    { method: 'POST', body, schema: bookedAppointmentSchema },
  );
}

// ---------------------------------------------------------------------------
// L'espace client authentifié — #47
// ---------------------------------------------------------------------------

/**
 * Les appels **porteurs d'une session**, séparés de ceux du parcours public.
 *
 * ## Pourquoi une seconde fonction de transport plutôt qu'un paramètre de plus
 *
 * `request` ci-dessus sert le tunnel public : ni jeton, ni cookie, ni `PATCH`.
 * L'élargir demanderait de reprendre la composition conditionnelle de son `init`
 * — écrite telle quelle pour `exactOptionalPropertyTypes` — au milieu d'un
 * fichier que deux autres branches du jalon modifient en parallèle (#43, #46).
 * Le coût d'une fusion ratée sur le chemin critique de la réservation est sans
 * commune mesure avec celui d'un second transport de trente lignes. La fusion
 * des deux est portée par une issue de suivi, à faire quand ces branches seront
 * intégrées.
 *
 * ## Ce qui ne change pas d'un transport à l'autre
 *
 * La forme d'erreur — `{ code, message, details }` traduit en `ApiClientError` —
 * et le **rejeu de chaque réponse contre son schéma Zod**. Une réponse hors
 * contrat échoue à la frontière, avec un message qui nomme le champ.
 */
interface AuthorizedRequestOptions<TSchema extends z.ZodTypeAny | null> {
  /**
   * `DELETE` n'a d'appelant que le retrait d'une affectation praticien →
   * prestation (#52) : c'est le seul geste du back-office qui supprime vraiment
   * une ligne, tout le reste se désactive. Sa réponse est un 204 sans corps,
   * d'où le `schema: null` que ce transport sait déjà porter.
   */
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly schema: TSchema;
  readonly body?: unknown;
  /** Jeton d'accès, posé en `Authorization: Bearer`. */
  readonly accessToken?: string;
  /**
   * Jeton de rafraîchissement, réémis vers l'API sous la forme du cookie qu'elle
   * a elle-même posé. C'est la seule façon de le lui rendre : `/auth/refresh` le
   * lit dans le cookie et **jamais** dans le corps, précisément pour qu'un jeton
   * postable — donc lisible par JavaScript — n'existe pas.
   */
  readonly refreshToken?: string;
}

/** Une session ouverte par l'API, jetons compris. */
export interface ApiSession {
  readonly session: AuthSessionResponse;
  /**
   * Le jeton de rafraîchissement, extrait du cookie que l'API vient de poser.
   *
   * L'API l'émet sur **son** domaine et sur le chemin `/api/v1/auth` : ce
   * cookie-là n'atteindrait jamais le navigateur, qui ne parle qu'au domaine du
   * front. Il est donc relu ici et réémis par le front sur son propre domaine,
   * `httpOnly` lui aussi — voir `session.ts` de l'espace client.
   */
  readonly refreshToken: string | null;
  /** Durée de vie du jeton de rafraîchissement, en secondes, telle que l'API l'annonce. */
  readonly refreshTokenMaxAge: number | null;
}

/** Le cookie de session tel que l'API le nomme — `identity/refresh-cookie.ts`. */
const API_REFRESH_COOKIE_NAME = 'spa_refresh_token';

async function authorizedRequest<TSchema extends z.ZodTypeAny | null>(
  options: AuthorizedRequestOptions<TSchema>,
): Promise<{ payload: TSchema extends z.ZodTypeAny ? z.infer<TSchema> : null; response: Response }> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.accessToken !== undefined) {
    headers['authorization'] = `Bearer ${options.accessToken}`;
  }
  if (options.refreshToken !== undefined) {
    headers['cookie'] = `${API_REFRESH_COOKIE_NAME}=${encodeURIComponent(options.refreshToken)}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const init: RequestInit = {
    method: options.method,
    headers,
    // Une session ne se met jamais en cache : deux visiteurs partageraient
    // l'historique du premier arrivé.
    cache: 'no-store',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${options.path}`, init);
  } catch (cause) {
    throw new ApiClientError(
      'SERVICE_UNAVAILABLE',
      'Le service est momentanément injoignable. Merci de réessayer dans un instant.',
      503,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const failure = apiErrorSchema.safeParse(payload);

    throw failure.success
      ? new ApiClientError(
          failure.data.code,
          failure.data.message,
          response.status,
          failure.data.details,
        )
      : new ApiClientError(
          `HTTP_${String(response.status)}`,
          'Une erreur inattendue est survenue.',
          response.status,
        );
  }

  if (options.schema === null) {
    return { payload: null as never, response };
  }

  const parsed = options.schema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiClientError(
      'INTERNAL_ERROR',
      `La réponse de l’API ne respecte pas le contrat sur ${options.path}.`,
      response.status,
      { issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    );
  }

  return { payload: parsed.data as never, response };
}

/**
 * Extrait le jeton de rafraîchissement et sa durée de vie du `Set-Cookie` de
 * l'API.
 *
 * `getSetCookie()` et non `headers.get('set-cookie')` : la seconde forme
 * concatène plusieurs en-têtes en une seule chaîne, et le découpage naïf sur la
 * virgule casse sur les dates `Expires=Wed, 09 Jun 2027 …`. La première rend un
 * tableau, un en-tête par entrée.
 */
function readApiSessionCookie(response: Response): {
  refreshToken: string | null;
  refreshTokenMaxAge: number | null;
} {
  const prefix = `${API_REFRESH_COOKIE_NAME}=`;
  const raw = response.headers.getSetCookie().find((cookie) => cookie.startsWith(prefix));

  if (raw === undefined) {
    return { refreshToken: null, refreshTokenMaxAge: null };
  }

  const [pair, ...attributes] = raw.split(';');
  const value = (pair ?? '').slice(prefix.length).trim();
  const maxAge = attributes
    .map((attribute) => /^\s*max-age=(\d+)\s*$/i.exec(attribute))
    .find((match) => match !== null);

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Une valeur qui ne se décode pas ne peut être aucun des jetons que l'API
    // émet : c'est une absence, pas un jeton à moitié lisible.
    return { refreshToken: null, refreshTokenMaxAge: null };
  }

  return {
    refreshToken: decoded === '' ? null : decoded,
    refreshTokenMaxAge: maxAge === undefined ? null : Number(maxAge[1]),
  };
}

async function openSession(
  path: string,
  body: unknown,
  refreshToken?: string,
): Promise<ApiSession> {
  const { payload, response } = await authorizedRequest({
    method: 'POST',
    path,
    body,
    schema: authSessionResponseSchema,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  });

  return { session: payload, ...readApiSessionCookie(response) };
}

/** Connexion d'une cliente à l'établissement désigné par son slug. */
export function loginToAccount(
  tenantSlug: string,
  credentials: LoginRequest,
): Promise<ApiSession> {
  return openSession('/auth/login', { ...credentials, tenantSlug });
}

/** Inscription d'une cliente — la session s'ouvre dans la foulée. */
export function registerAccount(
  tenantSlug: string,
  body: RegisterRequest,
): Promise<ApiSession> {
  return openSession('/auth/register', { ...body, tenantSlug });
}

/**
 * Rotation du jeton de rafraîchissement.
 *
 * Le corps est vide, et il doit le rester : l'API lit le jeton dans le cookie
 * qu'on lui réémet, et le `ValidationPipe` global refuserait tout champ qu'on
 * glisserait dans le corps.
 */
export function refreshSession(refreshToken: string): Promise<ApiSession> {
  return openSession('/auth/refresh', {}, refreshToken);
}

/**
 * Déconnexion — révoque la session **en base**, pas seulement côté navigateur.
 *
 * Sans cet appel, effacer le cookie du front laisserait le jeton de
 * rafraîchissement valide sept jours de plus : une session « fermée » qu'un vol
 * de cookie antérieur pourrait encore rejouer.
 */
export async function logoutSession(refreshToken: string): Promise<void> {
  await authorizedRequest({ method: 'POST', path: '/auth/logout', schema: null, refreshToken });
}

/** Le compte porté par le jeton d'accès. */
export async function fetchOwnProfile(accessToken: string): Promise<SessionUser> {
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: '/auth/me',
    schema: sessionUserSchema,
    accessToken,
  });
  return payload;
}

/** Modification de ses propres coordonnées. */
export async function updateOwnProfile(
  accessToken: string,
  body: UpdateProfileRequest,
): Promise<SessionUser> {
  const { payload } = await authorizedRequest({
    method: 'PATCH',
    path: '/users/me',
    body,
    schema: sessionUserSchema,
    accessToken,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Réglages de l'établissement — #343
// ---------------------------------------------------------------------------

/**
 * Les réglages de l'établissement, tels que le back-office les lit.
 *
 * Aucun slug ni identifiant d'établissement n'est envoyé, et il n'y a pas de
 * paramètre pour le faire : l'API lit l'établissement dans le jeton. C'est la
 * même propriété que `fetchMyAppointments`, et pour la même raison — une
 * signature qui accepterait un établissement obligerait chaque appelant à se
 * demander d'où il vient.
 */
export async function fetchTenantSettings(accessToken: string): Promise<Tenant> {
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: '/tenant',
    schema: tenantSchema,
    accessToken,
  });
  return payload;
}

/**
 * Modification partielle des réglages de l'établissement.
 *
 * `PATCH` : **absent** vaut « ne touche pas », `null` vaut « efface ». Un écran
 * qui n'affiche qu'une partie des réglages n'a donc pas à renvoyer le reste — et
 * ne risque pas de l'effacer en l'oubliant.
 */
export async function updateTenantSettings(
  accessToken: string,
  body: UpdateTenantRequest,
): Promise<Tenant> {
  const { payload } = await authorizedRequest({
    method: 'PATCH',
    path: '/tenant',
    body,
    schema: tenantSchema,
    accessToken,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Catalogue de services, côté back-office — #52
// ---------------------------------------------------------------------------

/**
 * Les prestations de l'établissement.
 *
 * `activeOnly` n'est **pas** posé par défaut : le back-office est justement
 * l'écran où l'on vient rechercher une prestation retirée du catalogue pour la
 * remettre en ligne. Le parcours public a son propre point d'entrée, qui ne
 * rend que les actives.
 */
export async function fetchServices(
  accessToken: string,
  query: { readonly activeOnly?: boolean; readonly categoryId?: string } = {},
): Promise<Service[]> {
  const search = new URLSearchParams();

  if (query.activeOnly === true) {
    search.set('activeOnly', 'true');
  }
  if (query.categoryId !== undefined) {
    search.set('categoryId', query.categoryId);
  }

  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/services${search.size === 0 ? '' : `?${search.toString()}`}`,
    schema: z.array(serviceSchema),
    accessToken,
  });
  return payload;
}

/** Une prestation, par identifiant. 404 si elle est d'un autre établissement. */
export async function fetchService(accessToken: string, serviceId: string): Promise<Service> {
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/services/${encodeURIComponent(serviceId)}`,
    schema: serviceSchema,
    accessToken,
  });
  return payload;
}

export async function createService(
  accessToken: string,
  body: CreateServiceRequest,
): Promise<Service> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: '/services',
    body,
    schema: serviceSchema,
    accessToken,
  });
  return payload;
}

/**
 * Modifie une prestation — **et c'est aussi ainsi qu'on la désactive**.
 *
 * L'API n'expose aucun `DELETE` sur cette ressource : les rendez-vous passés la
 * référencent et le reporting doit continuer à savoir ce qui a été vendu. Le
 * front n'a donc rien à proposer de tel.
 */
export async function updateService(
  accessToken: string,
  serviceId: string,
  body: UpdateServiceRequest,
): Promise<Service> {
  const { payload } = await authorizedRequest({
    method: 'PATCH',
    path: `/services/${encodeURIComponent(serviceId)}`,
    body,
    schema: serviceSchema,
    accessToken,
  });
  return payload;
}

/** Les rubriques du catalogue, désactivées comprises. */
export async function fetchServiceCategories(
  accessToken: string,
  query: { readonly activeOnly?: boolean } = {},
): Promise<ServiceCategory[]> {
  const suffix = query.activeOnly === true ? '?activeOnly=true' : '';
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/service-categories${suffix}`,
    schema: z.array(serviceCategorySchema),
    accessToken,
  });
  return payload;
}

export async function createServiceCategory(
  accessToken: string,
  body: CreateServiceCategoryRequest,
): Promise<ServiceCategory> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: '/service-categories',
    body,
    schema: serviceCategorySchema,
    accessToken,
  });
  return payload;
}

export async function updateServiceCategory(
  accessToken: string,
  categoryId: string,
  body: UpdateServiceCategoryRequest,
): Promise<ServiceCategory> {
  const { payload } = await authorizedRequest({
    method: 'PATCH',
    path: `/service-categories/${encodeURIComponent(categoryId)}`,
    body,
    schema: serviceCategorySchema,
    accessToken,
  });
  return payload;
}

/**
 * Les praticiens affectés à une prestation, **désactivés compris**.
 *
 * C'est le contrat de l'API (`serviceStaffMemberSchema` porte `isActive`), et
 * l'écran d'affectation doit le montrer : masquer un praticien désactivé
 * ferait croire à une affectation perdue et inviterait à la recréer, pour se
 * heurter au conflit d'unicité de `service_staff`.
 */
export async function fetchServiceStaff(
  accessToken: string,
  serviceId: string,
): Promise<ServiceStaffMember[]> {
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/services/${encodeURIComponent(serviceId)}/staff`,
    schema: z.array(serviceStaffMemberSchema),
    accessToken,
  });
  return payload;
}

/** Affecte **un** praticien à une prestation. 409 si l'affectation existe déjà. */
export async function assignServiceStaff(
  accessToken: string,
  serviceId: string,
  body: AssignServiceStaffRequest,
): Promise<ServiceStaffMember> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: `/services/${encodeURIComponent(serviceId)}/staff`,
    body,
    schema: serviceStaffMemberSchema,
    accessToken,
  });
  return payload;
}

/** Retire l'affectation — 204 sans corps, d'où le `schema: null`. */
export async function removeServiceStaff(
  accessToken: string,
  serviceId: string,
  staffId: string,
): Promise<void> {
  await authorizedRequest({
    method: 'DELETE',
    path: `/services/${encodeURIComponent(serviceId)}/staff/${encodeURIComponent(staffId)}`,
    schema: null,
    accessToken,
  });
}

/**
 * L'historique de la cliente connectée — une moitié à la fois.
 *
 * Aucun identifiant de cliente n'est envoyé, et il n'y a pas de champ pour le
 * faire : l'API la lit dans le jeton.
 */
export async function fetchMyAppointments(
  accessToken: string,
  query: MyAppointmentsQuery = {},
): Promise<BookedAppointment[]> {
  const search = new URLSearchParams();

  if (query.scope !== undefined) {
    search.set('scope', query.scope);
  }
  if (query.limit !== undefined) {
    search.set('limit', String(query.limit));
  }

  const suffix = search.size === 0 ? '' : `?${search.toString()}`;
  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/appointments/mine${suffix}`,
    schema: z.array(bookedAppointmentSchema),
    accessToken,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// L'agenda du back-office — #49
// ---------------------------------------------------------------------------

/**
 * Les rendez-vous d'une période, tels que le planning du comptoir les affiche.
 *
 * ## L'établissement ne circule pas
 *
 * Comme `fetchMyAppointments` et `fetchTenantSettings` : aucun slug, aucun
 * `tenantId`, et il n'y a pas de paramètre pour en poser un. L'API lit
 * l'établissement dans le jeton (tenant-isolation §2), et un appelant qui
 * viserait le voisin reçoit ses propres rendez-vous — jamais les siens.
 *
 * ## Les bornes sont des dates civiles
 *
 * `from` et `to` sont des journées de l'établissement, pas des instants : c'est
 * le contrat d'`appointmentListQuerySchema`, et son en-tête dit pourquoi — « le
 * 3 mars » ne commence pas au même moment à Papeete et à Paris, et seul le
 * serveur connaît `tenants.timezone`. Le front ne convertit donc rien avant
 * d'appeler ; il convertit à l'**affichage**, une fois, dans `lib/admin/`.
 *
 * ## Ce que cette route attend encore
 *
 * `apps/api` ne sert aujourd'hui que `GET /appointments/mine` et
 * `POST /appointments/:id/cancel` : l'agenda du back-office est décrit par le
 * contrat partagé mais **pas encore exposé**. Cette fonction est écrite contre le
 * contrat, et les écrans qui l'appellent traitent son échec comme un état
 * d'indisponibilité plutôt que comme une panne — voir la page du planning.
 */
export async function fetchAppointments(
  accessToken: string,
  query: AppointmentListQuery = {},
): Promise<Appointment[]> {
  const search = new URLSearchParams();

  for (const [name, value] of [
    ['from', query.from],
    ['to', query.to],
    ['staffId', query.staffId],
    ['clientId', query.clientId],
    ['serviceId', query.serviceId],
  ] as const) {
    if (value !== undefined) {
      search.set(name, value);
    }
  }

  // Répété plutôt que joint par des virgules : c'est la forme qu'un tableau
  // prend dans une chaîne de requête, et la seule qu'un `ParseArrayPipe` lise
  // sans convention supplémentaire.
  for (const status of query.statuses ?? []) {
    search.append('statuses', status);
  }

  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/appointments${search.size === 0 ? '' : `?${search.toString()}`}`,
    schema: z.array(appointmentSchema),
    accessToken,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// L'encaissement au comptoir — #59
// ---------------------------------------------------------------------------

/**
 * Ouvre — ou reprend — le paiement par carte d'un rendez-vous, et rend de quoi
 * monter Stripe Elements.
 *
 * ## Pourquoi la route **publique**, depuis le back-office
 *
 * Parce que c'est la seule que l'API sert : `POST /public/{slug}/payments/intents`
 * n'a pas d'équivalent gardé, et ouvrir celui-ci relèverait d'`apps/api`, hors
 * de l'empreinte de ce ticket. Ce n'est pas un contournement de garde — la route
 * est publique **par conception** (on réserve sans compte, donc on paie sans
 * compte), et ce qui l'autorise est la connaissance de l'identifiant du
 * rendez-vous, que le comptoir a légitimement.
 *
 * Deux conséquences à connaître, portées par l'issue de suivi de #59 :
 * l'ouverture est plafonnée à dix par minute **et par adresse** — et toutes les
 * demandes du back-office sortent par l'adresse du serveur Next, non par celle
 * du poste ; et un rendez-vous `completed` ou `no_show` y est refusé en 422,
 * alors que le comptoir devrait précisément pouvoir l'encaisser.
 *
 * ## Ce que le corps ne porte pas
 *
 * Ni montant, ni devise, ni donnée de carte : le prix est celui figé à la
 * réservation, relu en base, et les champs carte n'existent nulle part dans
 * cette pile — ils sont saisis dans une iframe servie par Stripe
 * (payments-stripe §1 et §2).
 */
export function openAppointmentPaymentIntent(
  tenantSlug: string,
  appointmentId: string,
): Promise<AppointmentPaymentIntent> {
  return request(publicPath(tenantSlug, '/payments/intents'), {
    method: 'POST',
    body: { appointmentId },
    schema: appointmentPaymentIntentSchema,
  });
}

/**
 * Règle un rendez-vous en espèces — aucun appel au prestataire sur ce chemin.
 *
 * Le corps ne porte **que** l'identifiant du rendez-vous : le montant est celui
 * figé à la réservation, l'opérateur vient du jeton vérifié, l'établissement de
 * la revendication signée. Il n'y a donc rien à envoyer qui puisse être faux.
 *
 * La route est **rejouable** : appelée deux fois, elle rend deux fois le même
 * encaissement, et la caisse n'est créditée qu'une fois — d'où son `200` et non
 * un `201`. Le front s'en protège de son côté en désactivant son bouton dès le
 * premier clic (web-frontend §3), mais l'invariant tient en base, pas dans
 * l'écran.
 */
export async function settleAppointmentInCash(
  accessToken: string,
  appointmentId: string,
): Promise<PaymentTransaction> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: '/payments/cash',
    body: { appointmentId },
    schema: paymentTransactionSchema,
    accessToken,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Le comptoir : poser, déplacer et solder un rendez-vous — #50
// ---------------------------------------------------------------------------

/**
 * Le fichier client, cherché d'un seul terme — nom, téléphone ou e-mail.
 *
 * C'est `GET /customers` (#56), et le terme unique est une propriété du contrat
 * et non une simplification d'ici : au téléphone, l'opérateur tape ce qu'il a
 * sous la main sans choisir un champ d'abord. Voir l'en-tête de
 * `customerSearchQuerySchema`.
 *
 * `includeInactive` n'est jamais posé : une fiche désactivée n'a rien à faire
 * dans l'écran de prise de rendez-vous.
 *
 * `Partial<…>` et non le type nu : `page` et `pageSize` portent un `.default()`
 * dans le contrat, donc le type **inféré en sortie** les donne pour toujours
 * présents. Un appelant qui s'en remet aux défauts du serveur n'aurait alors pas
 * le droit de les omettre, et cette fonction testerait une absence impossible.
 */
export async function searchCustomers(
  accessToken: string,
  query: Partial<CustomerSearchQuery>,
): Promise<CustomerPage> {
  const search = new URLSearchParams();

  if (query.q !== undefined) {
    search.set('q', query.q);
  }
  if (query.page !== undefined) {
    search.set('page', String(query.page));
  }
  if (query.pageSize !== undefined) {
    search.set('pageSize', String(query.pageSize));
  }

  const { payload } = await authorizedRequest({
    method: 'GET',
    path: `/customers${search.size === 0 ? '' : `?${search.toString()}`}`,
    schema: customerPageSchema,
    accessToken,
  });
  return payload;
}

/**
 * Crée une fiche cliente au comptoir — `POST /customers` (#56).
 *
 * Aucun mot de passe : la fiche naît pour être réservée et rappelée, pas pour se
 * connecter. C'est le « ou création rapide » du deuxième critère de #50, et
 * c'est ce qui évite d'envoyer l'opérateur sur un autre écran pendant que la
 * cliente est au bout du fil.
 */
export async function createCustomer(
  accessToken: string,
  body: CreateCustomerRequest,
): Promise<Customer> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: '/customers',
    body,
    schema: customerSchema,
    accessToken,
  });
  return payload;
}

/**
 * Pose un rendez-vous **depuis le back-office** — `POST /appointments`.
 *
 * Distincte de `bookGuestAppointment`, et pour la raison qui a fait séparer les
 * deux contrôleurs de l'API : là-bas l'établissement vient du slug d'URL et la
 * cliente de ses coordonnées saisies ; ici l'établissement vient du **jeton**, et
 * la cliente est une fiche déjà résolue, désignée par `clientId`. C'est
 * exactement la frontière que `createAppointmentRequestSchema.strict()` tient —
 * il refuse un `client`, quand la forme invitée refuse un `clientId`.
 *
 * ## Ce que cette route attend encore (même régime que `fetchAppointments`)
 *
 * `apps/api` ne sert aujourd'hui, derrière un jeton, que `GET /appointments`,
 * `GET /appointments/mine` et `POST /appointments/:id/cancel` : la prise de
 * rendez-vous au comptoir est décrite par le contrat partagé mais **pas encore
 * exposée**. Cette fonction est écrite contre le contrat, comme l'agenda l'a été
 * avant #444, et l'écran qui l'appelle traite son 404 comme une indisponibilité
 * annoncée plutôt que comme une panne — voir `lib/admin/appointment-desk.ts`.
 */
export async function createAppointment(
  accessToken: string,
  body: CreateAppointmentRequest,
): Promise<Appointment> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: '/appointments',
    body,
    schema: appointmentSchema,
    accessToken,
  });
  return payload;
}

/**
 * Déplace un rendez-vous depuis le back-office — `POST /appointments/:id/reschedule`.
 *
 * Le nom porte `Desk` parce que `rescheduleAppointment` existe déjà pour le
 * tunnel public : ce ne sont pas deux façons d'appeler la même route, mais deux
 * routes, sur deux surfaces, avec deux régimes de garde. Les confondre ferait
 * déplacer un rendez-vous de back-office par un chemin qui n'exige aucun jeton.
 *
 * La réponse est un rendez-vous **neuf**, avec un nouvel identifiant : un report
 * est une annulation suivie d'une création liée, jamais une réécriture des
 * bornes en place (booking-engine §5, `rescheduleAppointmentRequestSchema`).
 *
 * Route pas encore servie — voir `createAppointment`.
 */
export async function rescheduleDeskAppointment(
  accessToken: string,
  appointmentId: string,
  body: RescheduleAppointmentRequest,
): Promise<Appointment> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: `/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    body,
    schema: appointmentSchema,
    accessToken,
  });
  return payload;
}

/**
 * Solde un rendez-vous — `POST /appointments/:id/status`, `completed` ou
 * `no_show` (cinquième critère de #50).
 *
 * Ce n'est pas une suppression et cela ne peut pas l'être : le reporting du CDC
 * §1.4 compte les no-shows, et une ligne effacée ne se compte pas. La transition
 * elle-même est jugée par le serveur — `canTransitionAppointment` — et un refus
 * sort en `INVALID_STATE_TRANSITION`, jamais en 400.
 *
 * Route pas encore servie — voir `createAppointment`.
 */
export async function changeAppointmentStatus(
  accessToken: string,
  appointmentId: string,
  body: ChangeAppointmentStatusRequest,
): Promise<Appointment> {
  const { payload } = await authorizedRequest({
    method: 'POST',
    path: `/appointments/${encodeURIComponent(appointmentId)}/status`,
    body,
    schema: appointmentSchema,
    accessToken,
  });
  return payload;
}
