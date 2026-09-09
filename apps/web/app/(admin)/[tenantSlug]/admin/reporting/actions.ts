'use server';

/**
 * L'action serveur de l'export du reporting — #563, sixième critère.
 *
 * ## Pourquoi une action, et pas un `fetch` depuis le bouton
 *
 * Parce que l'appel exige le jeton d'accès, et que le jeton d'accès vit dans un
 * cookie `httpOnly` : il ne figure dans aucune prop de composant client, dans
 * aucun `localStorage`, et une XSS sur ce front ne peut ni le lire ni
 * l'exfiltrer (web-frontend §2). Un composant client ne peut donc pas appeler
 * l'API directement — il passe par ici, comme tous les autres écrans du
 * back-office.
 *
 * L'action rend **toujours** un résultat, jamais une exception : un rejet
 * traverserait la frontière serveur en perdant son type, et le bouton n'aurait
 * plus qu'un message générique à afficher.
 *
 * ## Ce qu'elle rend, et ce qu'elle ne rend pas
 *
 * `{ url, expiresAt, filename }` — l'URL présignée que le navigateur ouvre. Elle
 * est **porteuse et éphémère** : quiconque la détient lit le fichier jusqu'à
 * `expiresAt`, sans jeton. Elle n'est donc ni mise en cache, ni rangée dans un
 * état persistant, ni écrite dans l'URL de la page.
 *
 * Aucun jeton ne ressort d'ici, comme dans toutes les actions du back-office.
 *
 * ## Ce que l'appel HTTP fait à la main, et pourquoi
 *
 * `lib/api-client.ts` est la voie normale, et c'est là que ces deux appels
 * iront. Ils sont écrits ici parce que l'empreinte de ce ticket s'arrête au
 * reporting : `api-client.ts` est le fichier le plus partagé du front, et le
 * modifier pendant qu'une vague d'agents travaille sur la même base aurait
 * produit un conflit là où ce ticket n'a rien à décider. Le repli est borné —
 * deux appels, une lecture d'URL de base, une lecture de corps d'erreur — et il
 * se referme d'un déplacement, sans changer une ligne de ce qui appelle.
 *
 * TODO(#563-suivi) : déplacer `requestReportExport` et `refreshReportExport`
 * dans `lib/api-client.ts`, à côté des trois `fetch*Report`, et importer
 * `reportExportSchema` de `@spa/shared` plutôt que de le rejouer ici.
 */

import { ERROR_CODES, reportExportSchema, slugSchema, type ReportExport } from '@spa/shared';

import { ApiClientError } from '@/lib/api-client';

import { expired, failure, invalid, type AdminActionResult } from '../action-result';
import { readAdminAccessToken } from '../session';

/** La fenêtre demandée, telle que l'écran l'a calculée dans le fuseau du salon. */
export interface ReportExportWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * Produit l'export de la période affichée et rend son URL présignée.
 *
 * La fenêtre n'est pas revalidée champ par champ ici : elle est **calculée** par
 * l'écran (`lib/admin/reporting-window.ts`) et non saisie, et l'API la refuse en
 * 422 si elle est inversée ou trop large. Ce qui est vérifié ici est ce qu'un
 * appel d'action peut porter d'inattendu — un slug d'établissement forgé, deux
 * bornes qui ne sont pas des chaînes.
 */
export async function createReportExportAction(
  tenantSlug: string,
  window: unknown,
): Promise<AdminActionResult<ReportExport>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const parsed = parseWindow(window);

  if (parsed === null) {
    return invalid('La période à exporter est invalide.');
  }

  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    const query = new URLSearchParams({ from: parsed.from, to: parsed.to }).toString();

    return { ok: true, data: await callExportApi('POST', `/reports/export?${query}`, accessToken) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Re-signe un export déjà produit — pour rouvrir un lien périmé sans reproduire
 * le fichier.
 *
 * Un export d'un établissement voisin rend **404** côté API, jamais 403 et
 * jamais l'URL : la clé S3 est recomposée à partir du jeton
 * (`apps/api/src/modules/reporting/export/report-export.key.ts`). L'écran n'a
 * donc rien à vérifier de son côté, et il ne le doit pas — une vérification
 * côté front laisserait croire qu'elle protège quelque chose.
 */
export async function refreshReportExportAction(
  tenantSlug: string,
  exportId: unknown,
): Promise<AdminActionResult<ReportExport>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  if (typeof exportId !== 'string' || !UUID_PATTERN.test(exportId)) {
    return invalid('Export inconnu.');
  }

  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    return {
      ok: true,
      data: await callExportApi('GET', `/reports/export/${exportId}`, accessToken),
    };
  } catch (error) {
    return failure(error);
  }
}

/** UUID v4, la forme que la route d'API accepte en chemin. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Les deux bornes, si elles sont bien deux chaînes non vides. */
function parseWindow(value: unknown): ReportExportWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const { from, to } = value as Record<string, unknown>;

  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
    return null;
  }

  return { from, to };
}

/**
 * Racine de l'API, préfixe global et version compris.
 *
 * Recopié de `lib/api-client.ts` pour la raison dite en tête de fichier. Le
 * `/api/v1` est une propriété de l'API et non du déploiement : le figer évite
 * qu'un environnement l'oublie et qu'une route réponde 404 pour une raison de
 * configuration.
 */
function apiBaseUrl(): string {
  const host = process.env['API_URL'] ?? 'http://localhost:3001';

  return `${host.replace(/\/+$/, '')}/api/v1`;
}

/**
 * L'appel lui-même — et la relecture de la réponse contre le contrat partagé.
 *
 * `reportExportSchema` est **strict** : une réponse qui porterait une clé S3, un
 * nom de bucket ou un identifiant d'établissement serait refusée à la frontière
 * plutôt que transmise à un composant. Ce n'est pas théorique — c'est ce qui
 * garantit qu'aucune de ces valeurs n'atteigne jamais le navigateur, quoi que
 * l'API décide d'ajouter un jour à sa réponse.
 */
async function callExportApi(
  method: 'GET' | 'POST',
  path: string,
  accessToken: string,
): Promise<ReportExport> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch (cause) {
    throw new ApiClientError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Le service d’export est momentanément injoignable. Merci de réessayer dans un instant.',
      503,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = payload as { code?: unknown; message?: unknown } | null;

    throw new ApiClientError(
      typeof body?.code === 'string' ? body.code : `HTTP_${String(response.status)}`,
      typeof body?.message === 'string' ? body.message : 'Une erreur inattendue est survenue.',
      response.status,
    );
  }

  const parsed = reportExportSchema.safeParse(payload);

  if (!parsed.success) {
    throw new ApiClientError(
      ERROR_CODES.INTERNAL_ERROR,
      'La réponse de l’API ne respecte pas le contrat sur l’export du reporting.',
      response.status,
    );
  }

  return parsed.data;
}
