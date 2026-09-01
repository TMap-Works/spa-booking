import { notFound } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { ApiClientError, fetchPublicServices, fetchPublicTenant } from '@/lib/api-client';

import { BookingTunnel } from './booking-tunnel';

/**
 * Page de réservation d'un établissement (#45).
 *
 * **Server Component** : la vitrine du salon et son catalogue sont rendus côté
 * serveur — c'est la surface indexable du produit, et l'appel à l'API se fait
 * sans aller-retour par le navigateur (skill web-frontend §1). Seul le tunnel
 * lui-même est un Client Component, parce qu'il porte de l'état.
 *
 * `force-dynamic` parce que le catalogue et l'établissement changent sans que
 * le front en soit averti — et surtout parce qu'une prérendu au build
 * appellerait l'API depuis le runner de CI ou l'étape `build` de l'image
 * Docker, où elle n'existe pas.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function BookingPage({ params }: PageProps) {
  const { tenantSlug } = await params;

  try {
    // En parallèle : deux requêtes indépendantes, et le parcours critique vise
    // un LCP sous 2,5 s en 4G (skill web-frontend §7).
    const [tenant, services] = await Promise.all([
      fetchPublicTenant(tenantSlug),
      fetchPublicServices(tenantSlug),
    ]);

    return <BookingTunnel tenant={tenant} services={services} />;
  } catch (error) {
    // Établissement inconnu, désactivé, ou d'un slug mal formé : l'API répond
    // 404 sans distinguer les trois — c'est voulu, un 403 confirmerait
    // l'existence de l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    return (
      <main className="spa-card">
        <Notification tone="danger" title="La page de réservation n’a pas pu être chargée">
          <p>
            {error instanceof ApiClientError
              ? error.message
              : 'Une erreur inattendue est survenue.'}{' '}
            Merci de réessayer dans un instant.
          </p>
        </Notification>
      </main>
    );
  }
}
