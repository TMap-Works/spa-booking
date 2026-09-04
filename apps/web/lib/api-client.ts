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
  authSessionResponseSchema,
  availabilityResponseSchema,
  bookedAppointmentSchema,
  publicServiceSchema,
  publicTenantSchema,
  sessionUserSchema,
  tenantSchema,
  type AuthSessionResponse,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BookGuestAppointmentRequest,
  type BookedAppointment,
  type CancelAppointmentRequest,
  type LoginRequest,
  type MyAppointmentsQuery,
  type PublicService,
  type PublicTenant,
  type RegisterRequest,
  type RescheduleAppointmentRequest,
  type SessionUser,
  type Tenant,
  type UpdateProfileRequest,
  type UpdateTenantRequest,
} from '@spa/shared';
import { z } from 'zod';

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
  readonly method: 'GET' | 'POST' | 'PATCH';
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
