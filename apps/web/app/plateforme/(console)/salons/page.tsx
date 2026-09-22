import { TENANT_BILLING_STATUSES, type Locale, type PlatformTenantPage } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { ApiClientError, fetchPlatformTenants } from '@/lib/api-client';
import {
  billingStatusLabel,
  hasTenantFilters,
  readTenantFilters,
  tenantFilterSearch,
} from '@/lib/platform-console';

import { TenantTable } from '../../components/tenant-table';
import {
  PLATFORM_NEW_TENANT_PATH,
  PLATFORM_TENANTS_EXPORT_PATH,
  PLATFORM_TENANTS_PATH,
  platformTenantsPath,
} from '../../paths';
import { readPlatformAccessToken } from '../../session';
import { PLATFORM_SESSION_END_PATH } from '../../session/fin/path';

/**
 * Les salons de la plateforme — cherchés, filtrés, exportés.
 *
 * Les filtres vivent dans l'adresse (`?q=…&facturation=…&etat=…`), comme ceux
 * du back-office : une liste filtrée se partage, survit à un rafraîchissement,
 * et l'export CSV reprend exactement ce qu'on voit. Le formulaire est un
 * `GET` natif — aucun script n'est nécessaire pour filtrer.
 *
 * Les **noms** des paramètres ne suivent pas la langue (voir
 * `lib/platform-console.ts`) : une liste filtrée se partage entre deux personnes
 * qui n'affichent pas la console dans la même langue.
 */

interface PlatformTenantsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlatformTenantsPage({ searchParams }: PlatformTenantsPageProps) {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

  const [t, locale] = await Promise.all([getTranslations('platform'), getLocale()]);
  const filters = readTenantFilters(await searchParams);
  const page = filters.page ?? 1;
  let tenants: PlatformTenantPage;

  try {
    tenants = await fetchPlatformTenants(accessToken, filters);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(PLATFORM_SESSION_END_PATH);
    }
    throw error;
  }

  const filtered = hasTenantFilters(filters);
  const exportSearch = tenantFilterSearch({ ...filters, page: 1 });
  const exportHref =
    exportSearch.size === 0
      ? PLATFORM_TENANTS_EXPORT_PATH
      : `${PLATFORM_TENANTS_EXPORT_PATH}?${exportSearch.toString()}`;

  return (
    <section aria-labelledby="salons-titre">
      <h1 className="spa-admin__title" id="salons-titre">
        {t('tenants.title')}
      </h1>

      <form action={PLATFORM_TENANTS_PATH} className="spa-console-filters" method="get" role="search">
        <div className="spa-console-filters__search">
          <Field
            defaultValue={filters.q ?? ''}
            id="salons-recherche"
            label={t('tenants.searchLabel')}
            name="q"
            placeholder={t('tenants.searchPlaceholder')}
            type="search"
          />
        </div>
        <Select
          defaultValue={filters.billingStatus ?? ''}
          id="salons-facturation"
          label={t('tenants.billingLabel')}
          name="facturation"
        >
          <option value="">{t('tenants.billingAny')}</option>
          {TENANT_BILLING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {billingStatusLabel(status, locale as Locale)}
            </option>
          ))}
        </Select>
        <Select
          defaultValue={filters.state ?? ''}
          id="salons-etat"
          label={t('tenants.stateLabel')}
          name="etat"
        >
          <option value="">{t('tenants.stateAny')}</option>
          <option value="active">{t('state.active')}</option>
          <option value="suspended">{t('state.suspended')}</option>
        </Select>
        <div className="spa-console-filters__actions">
          <button className="spa-button spa-button--accent" type="submit">
            <span className="spa-button__label">{t('tenants.filter')}</span>
          </button>
          {filtered ? (
            <Link className="spa-button spa-button--quiet" href={PLATFORM_TENANTS_PATH}>
              {t('tenants.clear')}
            </Link>
          ) : null}
        </div>
      </form>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__hint">
          {filtered
            ? t('tenants.countFiltered', { count: tenants.totalItems })
            : t('tenants.count', { count: tenants.totalItems })}
        </span>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          {tenants.totalItems > 0 ? (
            <a className="spa-button spa-button--neutral" download href={exportHref}>
              {t('tenants.export')}
            </a>
          ) : null}
          <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
            {t('tenants.newTenant')}
          </Link>
        </div>
      </div>

      {tenants.items.length === 0 ? (
        <div className="spa-admin__section">
          <div className="spa-empty-state">
            {filtered ? (
              <>
                <p className="spa-empty-state__title">{t('tenants.emptyFiltered.title')}</p>
                <p className="spa-empty-state__description">
                  {t('tenants.emptyFiltered.description')}
                </p>
                <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
                  <span className="spa-button__label">{t('tenants.emptyFiltered.action')}</span>
                </Link>
              </>
            ) : (
              <>
                <p className="spa-empty-state__title">{t('tenants.empty.title')}</p>
                <p className="spa-empty-state__description">{t('tenants.empty.description')}</p>
                <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
                  <span className="spa-button__label">{t('tenants.empty.action')}</span>
                </Link>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="spa-admin__section">
          <TenantTable tenants={tenants.items} />

          {tenants.totalPages > 1 ? (
            <nav className="spa-admin-toolbar" aria-label={t('tenants.pagination.label')}>
              {page > 1 ? (
                <Link
                  className="spa-button spa-button--neutral"
                  href={platformTenantsPath(tenantFilterSearch({ ...filters, page: page - 1 }))}
                >
                  {t('tenants.pagination.previous')}
                </Link>
              ) : null}
              <span className="spa-admin-toolbar__hint">
                {t('tenants.pagination.position', { page, pages: tenants.totalPages })}
              </span>
              {page < tenants.totalPages ? (
                <Link
                  className="spa-button spa-button--neutral"
                  href={platformTenantsPath(tenantFilterSearch({ ...filters, page: page + 1 }))}
                >
                  {t('tenants.pagination.next')}
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      )}
    </section>
  );
}
