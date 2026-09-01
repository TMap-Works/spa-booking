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
  availabilityResponseSchema,
  bookedAppointmentSchema,
  publicServiceSchema,
  publicTenantSchema,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BookGuestAppointmentRequest,
  type BookedAppointment,
  type CancelAppointmentRequest,
  type PublicService,
  type PublicTenant,
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
