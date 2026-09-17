import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicExits } from '@/components/salon/public-exits';
import { salonContactAction } from '@/components/salon/salon-contact';
import { SalonHeader } from '@/components/salon/salon-header';
import { SalonInfo } from '@/components/salon/salon-info';
import { ServiceCatalog } from '@/components/salon/service-catalog';
import { SalonStructuredData } from '@/components/salon/structured-data';
import { ApiClientError } from '@/lib/api-client';

import { BookingErrorNotice } from '../booking-error-notice';
import {
  accountPath,
  loadSalonServices,
  loadSalonTenant,
  reservationPath,
  salonPath,
  salonUrl,
  siteOrigin,
} from '../salon-data';

/**
 * Page publique d'un salon (#43) — vitrine et catalogue.
 *
 * **Server Component, sans `"use client"`.** C'est la première page vue par une
 * cliente et la seule indexable du produit : elle est rendue côté serveur, et ses
 * deux appels à l'API partent du serveur sans aller-retour par le navigateur
 * (skill web-frontend §1). Le seul JavaScript applicatif qu'elle embarque tient
 * en deux îlots de quelques lignes, qui ne peignent rien avant un clic :
 * l'indicateur de navigation du layout racine et le repère « en cours » du
 * bouton « Réserver » (#830). C'est ce qui tient le budget de LCP sous 2,5 s en
 * 4G — la page ne dépend d'aucune hydratation pour afficher son titre, son
 * catalogue et ses tarifs.
 *
 * Le tunnel de réservation, lui, a de l'état : il vit sur `../reservation` et
 * c'est un autre écran. Cette page y renvoie par un lien, elle ne l'embarque
 * pas.
 *
 * ## Pourquoi sous `(vitrine)/` (#830)
 *
 * Le groupe ne change pas l'URL — la page reste `/{slug}` — mais il lui donne un
 * dossier à elle, où poser son squelette (`loading.tsx`) et sa reprise
 * (`error.tsx`) sans qu'ils enveloppent aussi le tunnel voisin, qui a les siens.
 * Le `layout.tsx` du groupe résout l'établissement **au-dessus** du squelette :
 * c'est ce qui garde le 404 d'un slug inconnu, que le `notFound()` ci-dessous ne
 * peut plus poser seul une fois l'en-tête de réponse parti avec le squelette.
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
 * La description que lit un moteur de recherche, accordée à l'état du catalogue
 * (#773).
 *
 * C'est **mot pour mot l'accroche** de `SalonHeader`, servie à une autre
 * surface : la laisser promettre « Découvrez les prestations…, leurs durées et
 * leurs tarifs » pour un salon qui n'a rien publié ferait dire au résultat de
 * recherche ce que la page vient précisément de cesser de dire.
 *
 * Fonction **pure** : l'état du catalogue lui est donné, elle ne le charge pas.
 * C'est ce qui permet à `generateMetadata` de lancer les deux chargements
 * ensemble plutôt que de les enchaîner — voir ci-dessous.
 */
function salonDescription(tenantName: string, bookable: boolean): string {
  return bookable
    ? `Découvrez les prestations de ${tenantName}, leurs durées et leurs tarifs, ` +
        `et réservez votre rendez-vous en ligne.`
    : `${tenantName} n’a pas encore publié ses prestations en ligne : ` +
        `la réservation en ligne n’est pas encore ouverte.`;
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

  // Le catalogue part **avant** l'attente de la fiche, et sous la même clé de
  // mémoïsation que le composant (`tenantSlug`, celui de l'URL) : les deux
  // chargements sont indépendants, les enchaîner ajouterait un aller-retour
  // d'API sur le chemin du LCP que cette page tient sous 2,5 s.
  //
  // Le repli à `true` quand le catalogue n'a pas pu être lu : annoncer une
  // réservation fermée sur la foi d'une panne transitoire écrirait dans l'index
  // un état que le salon n'a pas choisi. Même raisonnement que le `noindex`
  // réservé au 404, plus bas. La rejection est traitée ici même — rien ne reste
  // en suspens si la fiche, elle, échoue.
  const bookable = loadSalonServices(tenantSlug).then(
    (services) => services.length > 0,
    () => true,
  );

  try {
    const tenant = await loadSalonTenant(tenantSlug);
    const title = `${tenant.name} — prestations et réservation en ligne`;
    const description = salonDescription(tenant.name, await bookable);

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
    // La réservation en ligne suppose une prestation à réserver (#773). Tout ce
    // que la page promet en dépend : l'accroche, l'appel à l'action, l'action de
    // l'état vide du catalogue, et jusqu'à la `ReserveAction` du graphe.
    const bookable = services.length > 0;

    return (
      <div className="spa-salon">
        {/*
          L'accès à l'espace client, au-dessus du contenu et hors du `<main>`
          (#739) : c'est une navigation de site, elle a son propre repère, et
          elle précède le titre comme sur les autres écrans du parcours.
        */}
        <PublicExits variant="header" exits={[{ key: 'compte', href: accountPath(tenant.slug) }]} />
        <main className="spa-salon__main" id="contenu">
          <SalonStructuredData
            tenant={tenant}
            services={services}
            url={canonicalUrl}
            reservationUrl={`${canonicalUrl}/reservation`}
          />
          <SalonHeader
            tenant={tenant}
            reservationHref={bookable ? reservationPath(tenant.slug) : null}
          />
          <ServiceCatalog services={services} contact={salonContactAction(tenant)} />
          <SalonInfo tenant={tenant} bookable={bookable} />
        </main>
      </div>
    );
  } catch (error) {
    // Établissement inconnu, désactivé, ou d'un slug mal formé : l'API répond
    // 404 sans distinguer les trois — c'est voulu, un 403 confirmerait
    // l'existence de l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    // L'établissement n'a pas pu être chargé, mais le slug de l'URL suffit à
    // adresser l'espace client : la sortie reste donc offerte, sans quoi une
    // panne du catalogue enfermerait la visiteuse sur un écran sans issue.
    return (
      <div className="spa-salon">
        <PublicExits variant="header" exits={[{ key: 'compte', href: accountPath(tenantSlug) }]} />
        <main className="spa-salon__main" id="contenu">
          <BookingErrorNotice title="La page du salon n’a pas pu être chargée" error={error} />
        </main>
      </div>
    );
  }
}
