import type { Locale, PlatformTenant } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { NextResponse, type NextRequest } from 'next/server';

import { ApiClientError, fetchPlatformTenants } from '@/lib/api-client';
import { readTenantFilters, tenantsCsv } from '@/lib/platform-console';
import { redirectWithinSite } from '@/lib/relative-redirect';

import { readPlatformAccessToken } from '../../../session';
import { PLATFORM_SESSION_END_PATH } from '../../../session/fin/path';

/**
 * L'export CSV de la liste des salons — **avec les filtres de l'écran**.
 *
 * Il parcourt les pages de l'API par cent, le plafond serveur, et s'arrête à
 * cinquante pages : cinq mille salons, bien au-delà du MVP, et une borne qui
 * empêche une boucle de tourner sans fin si l'API renvoyait un total faux.
 *
 * ## La langue est celle de la requête d'export (#1106)
 *
 * `getLocale()` fonctionne ici comme dans un Server Component : une route
 * handler est servie dans le contexte de sa requête, et la langue est résolue sur
 * cette requête (`i18n/request.ts`). Les en-têtes de colonnes suivent donc la
 * langue de l'interface **au moment où l'on clique** — c'est ce que la personne
 * lit, et le fichier atterrit sur son poste.
 *
 * Le nom du fichier, lui, ne bouge pas : `salons-2026-09-23.csv` se trie dans un
 * répertoire et s'écrit de la même façon dans les deux langues.
 */
export const dynamic = 'force-dynamic';

const EXPORT_PAGE_SIZE = 100;
const EXPORT_MAX_PAGES = 50;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    return redirectWithinSite(PLATFORM_SESSION_END_PATH);
  }

  const filters = readTenantFilters(Object.fromEntries(request.nextUrl.searchParams));
  const tenants: PlatformTenant[] = [];

  try {
    for (let page = 1; page <= EXPORT_MAX_PAGES; page += 1) {
      const batch = await fetchPlatformTenants(accessToken, {
        ...filters,
        page,
        pageSize: EXPORT_PAGE_SIZE,
      });
      tenants.push(...batch.items);
      if (page >= batch.totalPages) {
        break;
      }
    }
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      return redirectWithinSite(PLATFORM_SESSION_END_PATH);
    }
    const t = await getTranslations('platform');
    return new NextResponse(t('export.failed'), { status: 502 });
  }

  const locale = (await getLocale()) as Locale;
  const day = new Date().toISOString().slice(0, 10);

  return new NextResponse(tenantsCsv(tenants, locale), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="salons-${day}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
