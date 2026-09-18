import { TENANT_BILLING_STATUSES, type PlatformTenantPage } from '@spa/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { ApiClientError, fetchPlatformTenants } from '@/lib/api-client';
import {
  BILLING_STATUS_LABELS,
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
 */

interface PlatformTenantsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlatformTenantsPage({ searchParams }: PlatformTenantsPageProps) {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

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
        Salons de la plateforme
      </h1>

      <form action={PLATFORM_TENANTS_PATH} className="spa-console-filters" method="get" role="search">
        <div className="spa-console-filters__search">
          <Field
            defaultValue={filters.q ?? ''}
            id="salons-recherche"
            label="Rechercher"
            name="q"
            placeholder="Nom, adresse, e-mail de contact ou d’un gérant"
            type="search"
          />
        </div>
        <Select
          defaultValue={filters.billingStatus ?? ''}
          id="salons-facturation"
          label="Facturation"
          name="facturation"
        >
          <option value="">Toutes</option>
          {TENANT_BILLING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {BILLING_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
        <Select defaultValue={filters.state ?? ''} id="salons-etat" label="État" name="etat">
          <option value="">Tous</option>
          <option value="active">Actif</option>
          <option value="suspended">Suspendu</option>
        </Select>
        <div className="spa-console-filters__actions">
          <button className="spa-button spa-button--accent" type="submit">
            <span className="spa-button__label">Filtrer</span>
          </button>
          {filtered ? (
            <Link className="spa-button spa-button--quiet" href={PLATFORM_TENANTS_PATH}>
              Effacer
            </Link>
          ) : null}
        </div>
      </form>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__hint">
          {tenants.totalItems} salon{tenants.totalItems > 1 ? 's' : ''}
          {filtered ? ' correspondant aux filtres' : ''}
        </span>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          {tenants.totalItems > 0 ? (
            <a className="spa-button spa-button--neutral" download href={exportHref}>
              Exporter en CSV
            </a>
          ) : null}
          <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
            Ouvrir un salon
          </Link>
        </div>
      </div>

      {tenants.items.length === 0 ? (
        <div className="spa-admin__section">
          <div className="spa-empty-state">
            {filtered ? (
              <>
                <p className="spa-empty-state__title">Aucun salon ne correspond</p>
                <p className="spa-empty-state__description">
                  Élargissez la recherche, ou effacez les filtres pour revoir tous les salons.
                </p>
                <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
                  <span className="spa-button__label">Effacer les filtres</span>
                </Link>
              </>
            ) : (
              <>
                <p className="spa-empty-state__title">Aucun salon ouvert pour l’instant</p>
                <p className="spa-empty-state__description">
                  Ouvrez le premier : vous obtiendrez le lien d’activation à envoyer au gérant,
                  l’adresse de son back-office et sa page de réservation.
                </p>
                <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
                  <span className="spa-button__label">Ouvrir un salon</span>
                </Link>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="spa-admin__section">
          <TenantTable tenants={tenants.items} />

          {tenants.totalPages > 1 ? (
            <nav className="spa-admin-toolbar" aria-label="Pages de la liste">
              {page > 1 ? (
                <Link
                  className="spa-button spa-button--neutral"
                  href={platformTenantsPath(tenantFilterSearch({ ...filters, page: page - 1 }))}
                >
                  Page précédente
                </Link>
              ) : null}
              <span className="spa-admin-toolbar__hint">
                Page {page} sur {tenants.totalPages}
              </span>
              {page < tenants.totalPages ? (
                <Link
                  className="spa-button spa-button--neutral"
                  href={platformTenantsPath(tenantFilterSearch({ ...filters, page: page + 1 }))}
                >
                  Page suivante
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      )}
    </section>
  );
}
