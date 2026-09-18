import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApiClientError, fetchPlatformTenants } from '@/lib/api-client';

import { TenantTable } from '../components/tenant-table';
import { PLATFORM_NEW_TENANT_PATH, platformTenantsPath } from '../paths';
import { readPlatformAccessToken } from '../session';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';

/**
 * Les salons de la plateforme, les plus récents d'abord.
 *
 * Un 401 ne renvoie pas directement à la connexion : le cookie serait encore là,
 * la connexion redirigerait ici, et la boucle serait refermée. Il passe par la
 * route qui efface la session.
 */

interface PlatformTenantsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readPage(raw: string | string[] | undefined): number {
  const page = Number(typeof raw === 'string' ? raw : '1');

  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export default async function PlatformTenantsPage({ searchParams }: PlatformTenantsPageProps) {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

  const page = readPage((await searchParams).page);
  let tenants;

  try {
    tenants = await fetchPlatformTenants(accessToken, page);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(PLATFORM_SESSION_END_PATH);
    }
    throw error;
  }

  return (
    <section aria-labelledby="salons-titre">
      <h1 className="spa-admin__title" id="salons-titre">
        Salons de la plateforme
      </h1>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__hint">
          {tenants.totalItems} salon{tenants.totalItems > 1 ? 's' : ''} ouvert
          {tenants.totalItems > 1 ? 's' : ''}
        </span>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
            Ouvrir un salon
          </Link>
        </div>
      </div>

      {tenants.items.length === 0 ? (
        <div className="spa-admin__section">
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun salon ouvert pour l’instant</p>
            <p className="spa-empty-state__description">
              Ouvrez le premier : vous obtiendrez le lien d’activation à envoyer au gérant, l’adresse
              de son back-office et sa page de réservation.
            </p>
            <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
              <span className="spa-button__label">Ouvrir un salon</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="spa-admin__section">
          <TenantTable tenants={tenants.items} />

          {tenants.totalPages > 1 ? (
            <nav className="spa-admin-toolbar" aria-label="Pages de la liste">
              {page > 1 ? (
                <Link className="spa-button spa-button--neutral" href={platformTenantsPath(page - 1)}>
                  Page précédente
                </Link>
              ) : null}
              <span className="spa-admin-toolbar__hint">
                Page {page} sur {tenants.totalPages}
              </span>
              {page < tenants.totalPages ? (
                <Link className="spa-button spa-button--neutral" href={platformTenantsPath(page + 1)}>
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
