import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { SalonBookingBar } from '@/components/salon/salon-booking-bar';
import { salonContactAction } from '@/components/salon/salon-contact';
import { SalonHeader } from '@/components/salon/salon-header';
import { SalonInfo } from '@/components/salon/salon-info';
import { SalonTeam } from '@/components/salon/salon-team';
import { ServiceCatalog } from '@/components/salon/service-catalog';
import { SalonStructuredData } from '@/components/salon/structured-data';
import { ApiClientError } from '@/lib/api-client';
import { formattingLocale } from '@/lib/format';

import { BookingErrorNotice } from '../booking-error-notice';
import {
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
 * Métadonnées SEO de la page.
 *
 * Le titre et la description portent le nom du salon : c'est ce qu'un moteur
 * affiche, et « Réservation en ligne » — le titre du layout racine — ne
 * distingue aucun établissement d'un autre.
 *
 * L'établissement est chargé par le même loader mémoïsé que le composant
 * (`salon-data.ts`) : les deux appels n'en font qu'un.
 *
 * ## La description est accordée à l'état du catalogue (#773)
 *
 * C'est **mot pour mot l'accroche** de `SalonHeader`, servie à une autre
 * surface : la laisser promettre « Découvrez les prestations…, leurs durées et
 * leurs tarifs » pour un salon qui n'a rien publié ferait dire au résultat de
 * recherche ce que la page vient précisément de cesser de dire. Le choix entre
 * les deux phrases ne dépend que d'un booléen, et le catalogue est chargé en
 * parallèle de la fiche plutôt qu'après elle — voir ci-dessous.
 *
 * ## La langue (#846)
 *
 * `getTranslations` et `getLocale`, et non les crochets : `generateMetadata` est
 * asynchrone. Le **nom du salon** s'insère en paramètre des deux phrases — c'est
 * du contenu, il ne se traduit pas.
 *
 * `openGraph.locale` suit la langue résolue, au format que le protocole attend
 * (`fr_FR`, `en_US`) : l'étiquette vient de `formattingLocale`, donc du pays de
 * l'établissement, et non d'un `fr_FR` figé qui annonçait du français sur toutes
 * les vitrines du produit.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenantSlug } = await params;
  const t = await getTranslations('booking');
  const locale = await getLocale();

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
    const title = t('salon.metadata.title', { name: tenant.name });
    const description = (await bookable)
      ? t('salon.metadata.descriptionBookable', { name: tenant.name })
      : t('salon.metadata.descriptionUnavailable', { name: tenant.name });

    return {
      metadataBase: new URL(siteOrigin()),
      title,
      description,
      alternates: { canonical: salonPath(tenant.slug) },
      openGraph: {
        type: 'website',
        // Le protocole Open Graph veut « langue_RÉGION » ; `formattingLocale`
        // rend « langue-RÉGION ».
        locale: formattingLocale(locale, tenant.address?.country).replace('-', '_'),
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
      return {
        title: t('salon.metadata.notFoundTitle'),
        robots: { index: false, follow: false },
      };
    }

    return { title: t('salon.metadata.fallbackTitle') };
  }
}

export default async function SalonPage({ params }: PageProps) {
  const { tenantSlug } = await params;
  // Composant **asynchrone** : `getTranslations` et non `useTranslations`, qui
  // est un crochet (#846). Les composants qu'il monte, eux, sont synchrones et
  // lisent le catalogue par le crochet.
  const t = await getTranslations('booking');
  const locale = await getLocale();

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
    const reservationHref = bookable ? reservationPath(tenant.slug) : null;
    // Un seul instant pour toute la page (#1046) : le bandeau dit « Ouvert —
    // ferme à 19:00 », la carte des horaires met « aujourd'hui » en évidence, et
    // les deux doivent parler du même moment. Deux `new Date()` posés
    // séparément divergeraient à la minute de bascule, et la page se
    // contredirait à minuit dans le fuseau du salon.
    const now = new Date();

    return (
      <div className="spa-salon">
        <main className="spa-salon__main" id="contenu">
          <SalonStructuredData
            tenant={tenant}
            services={services}
            url={canonicalUrl}
            reservationUrl={`${canonicalUrl}/reservation`}
          />
          <SalonHeader tenant={tenant} reservationHref={reservationHref} now={now} />

          {/* Deux colonnes au-delà de 64 rem : le catalogue à gauche, les
              informations pratiques à droite, collantes (BM-VITRINE-04). En
              deçà, tout retombe dans une colonne, informations en dernier — on
              vient d'abord pour les prestations. */}
          <div className="spa-salon__columns">
            <div className="spa-salon__column">
              <ServiceCatalog
                services={services}
                contact={salonContactAction(tenant, locale)}
                reservationPath={reservationHref}
              />
              <SalonTeam services={services} />
            </div>

            <aside className="spa-salon__aside" aria-label={t('salon.info.label')}>
              <SalonInfo tenant={tenant} bookable={bookable} now={now} />
            </aside>
          </div>
        </main>

        <SalonBookingBar href={reservationHref} serviceCount={services.length} />
      </div>
    );
  } catch (error) {
    // Établissement inconnu, désactivé, ou d'un slug mal formé : l'API répond
    // 404 sans distinguer les trois — c'est voulu, un 403 confirmerait
    // l'existence de l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    // L'établissement n'a pas pu être chargé : l'en-tête du gabarit (#1045),
    // posé par le layout sur le seul slug de l'URL, garde l'accès à l'espace
    // client, sans quoi une panne enfermerait la visiteuse sur un écran sans
    // issue.
    return (
      <div className="spa-salon">
        <main className="spa-salon__main" id="contenu">
          <BookingErrorNotice title={t('salon.error.title')} error={error} />
        </main>
      </div>
    );
  }
}
