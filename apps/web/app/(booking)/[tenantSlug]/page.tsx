import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SalonHeader } from '@/components/salon/salon-header';
import { SalonInfo } from '@/components/salon/salon-info';
import { ServiceCatalog } from '@/components/salon/service-catalog';
import { SalonStructuredData } from '@/components/salon/structured-data';
import { Notification } from '@/components/ui/notification';
import { ApiClientError } from '@/lib/api-client';

import {
  loadSalonServices,
  loadSalonTenant,
  reservationPath,
  salonPath,
  salonUrl,
  siteOrigin,
} from './salon-data';

/**
 * Page publique d'un salon (#43) — vitrine et catalogue.
 *
 * **Server Component, sans `"use client"`.** C'est la première page vue par une
 * cliente et la seule indexable du produit : elle est rendue côté serveur, elle
 * n'embarque aucun JavaScript applicatif, et ses deux appels à l'API partent du
 * serveur sans aller-retour par le navigateur (skill web-frontend §1). C'est
 * aussi ce qui tient le budget de LCP sous 2,5 s en 4G — la page ne dépend
 * d'aucune hydratation pour afficher son titre, son catalogue et ses tarifs.
 *
 * Le tunnel de réservation, lui, a de l'état : il vit sur `./reservation` et
 * c'est un autre écran. Cette page y renvoie par un lien, elle ne l'embarque
 * pas.
 *
 * ## `force-dynamic`
 *
 * Le catalogue et la fiche du salon changent sans que le front en soit averti ;
 * surtout, un prérendu au build appellerait l'API depuis le runner de CI ou
 * l'étape `build` de l'image Docker, où elle n'existe pas. Même choix que la
 * page de réservation voisine.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

/**
 * Métadonnées SEO de la page.
 *
 * Le titre et la description portent le nom du salon : c'est ce qu'un moteur
 * affiche, et « Réservation en ligne » — le titre du layout racine — ne
 * distingue aucun établissement d'un autre.
 *
 * L'établissement est chargé par le même loader mémoïsé que le composant
 * (`salon-data.ts`) : les deux appels n'en font qu'un.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenantSlug } = await params;

  try {
    const tenant = await loadSalonTenant(tenantSlug);
    const title = `${tenant.name} — prestations et réservation en ligne`;
    const description =
      `Découvrez les prestations de ${tenant.name}, leurs durées et leurs tarifs, ` +
      `et réservez votre rendez-vous en ligne.`;

    return {
      metadataBase: new URL(siteOrigin()),
      title,
      description,
      alternates: { canonical: salonPath(tenant.slug) },
      openGraph: {
        type: 'website',
        locale: 'fr_FR',
        siteName: tenant.name,
        url: salonPath(tenant.slug),
        title,
        description,
      },
      robots: { index: true, follow: true },
    };
  } catch (error) {
    // `generateMetadata` ne doit pas jeter — Next rendrait une erreur serveur là
    // où la page sait déjà répondre 404.
    //
    // Le `noindex` est réservé au 404, et **n'est pas étendu aux pannes**. La
    // page répond 200 tant que l'API est injoignable : y joindre un
    // « ne m'indexe pas » ferait lire à un moteur une consigne délibérée là où
    // il n'y a qu'un incident, et sortirait la page du salon de l'index jusqu'au
    // passage suivant. Une panne est transitoire, une désindexation ne l'est pas.
    if (error instanceof ApiClientError && error.status === 404) {
      return { title: 'Salon introuvable', robots: { index: false, follow: false } };
    }

    return { title: 'Réservation en ligne' };
  }
}

export default async function SalonPage({ params }: PageProps) {
  const { tenantSlug } = await params;

  try {
    // En parallèle : deux requêtes indépendantes, et c'est le chemin du LCP.
    const [tenant, services] = await Promise.all([
      loadSalonTenant(tenantSlug),
      loadSalonServices(tenantSlug),
    ]);

    const canonicalUrl = salonUrl(tenant.slug);

    return (
      <main className="spa-salon">
        <SalonStructuredData
          tenant={tenant}
          services={services}
          url={canonicalUrl}
          reservationUrl={`${canonicalUrl}/reservation`}
        />
        <SalonHeader tenant={tenant} reservationHref={reservationPath(tenant.slug)} />
        <ServiceCatalog services={services} />
        <SalonInfo tenant={tenant} />
      </main>
    );
  } catch (error) {
    // Établissement inconnu, désactivé, ou d'un slug mal formé : l'API répond
    // 404 sans distinguer les trois — c'est voulu, un 403 confirmerait
    // l'existence de l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    return (
      <main className="spa-salon">
        <Notification tone="danger" title="La page du salon n’a pas pu être chargée">
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
