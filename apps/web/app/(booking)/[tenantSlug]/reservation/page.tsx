import { notFound } from 'next/navigation';

import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError } from '@/lib/api-client';

import { BookingErrorNotice } from '../booking-error-notice';
import { accountPath, loadSalonServices, loadSalonTenant, salonPath } from '../salon-data';
import { BookingTunnel } from './booking-tunnel';

/**
 * Page de réservation d'un établissement (#45).
 *
 * **Server Component** : la vitrine du salon et son catalogue sont rendus côté
 * serveur — c'est la surface indexable du produit, et l'appel à l'API se fait
 * sans aller-retour par le navigateur (skill web-frontend §1). Seul le tunnel
 * lui-même est un Client Component, parce qu'il porte de l'état.
 *
 * Le bandeau, le conteneur centré et le pied de page viennent du layout voisin
 * (`layout.tsx`, #623). Les deux chargent l'établissement par le même loader
 * mémoïsé de `salon-data.ts` : un seul appel à `GET /public/{slug}` par requête.
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
    //
    // La lecture de la présence les rejoint depuis #1050. Elle ne coûte aucun
    // aller-retour — c'est un cookie de la requête en cours —, et la placer ici
    // plutôt qu'avant le `Promise.all` évite de faire attendre les deux appels
    // qui, eux, traversent le réseau.
    const [tenant, services, presence] = await Promise.all([
      loadSalonTenant(tenantSlug),
      loadSalonServices(tenantSlug),
      readAccountPresence(),
    ]);

    // Les chemins sont composés ici, et non dans le tunnel : les composants ne
    // connaissent pas l'arborescence des routes, c'est la page qui la tient
    // (`salon-data.ts`), comme pour l'en-tête de la vitrine.
    return (
      <BookingTunnel
        tenant={tenant}
        services={services}
        exitHref={salonPath(tenantSlug)}
        // La cliente connectée chez ce salon — **lue côté serveur**, dans le
        // cookie `httpOnly` posé par #1045 et porté sur `/{salon}` (#1050).
        // Le tunnel est un Client Component : il ne pourrait pas la lire
        // lui-même, et rien de ce qui la décrit ne passe par l'URL.
        //
        // La page est déjà `force-dynamic` : cette lecture ne lui coûte pas la
        // mise en cache qu'elle n'avait pas.
        presence={presence}
        loginHref={`${accountPath(tenantSlug)}/connexion`}
      />
    );
  } catch (error) {
    // Établissement inconnu, désactivé, ou d'un slug mal formé : l'API répond
    // 404 sans distinguer les trois — c'est voulu, un 403 confirmerait
    // l'existence de l'établissement (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }

    // Le `<main>` est posé ici depuis #1047 : le layout n'est plus qu'une
    // enveloppe, et c'est le tunnel — ou cet encart quand il ne peut pas se
    // rendre — qui porte la région principale. Une seule par document.
    //
    // Sans en-tête de tunnel : il n'y a pas d'établissement à nommer, ni
    // d'étape à quitter. La navigation du navigateur reste la sortie.
    //
    // Le `<h1>`, lui, reste : il a quitté le layout pour `BookingProgress`
    // (#1047), c'est-à-dire pour un tunnel qui n'est justement pas rendu ici. Le
    // titre de l'encart d'erreur est un `<p>` (`components/ui/notification.tsx`) :
    // sans cette ligne, la page n'aurait aucun titre, et aucun de niveau 1.
    return (
      <main className="spa-booking__main" id="contenu">
        <div className="spa-booking__frame spa-booking__content">
          <h1 className="spa-booking__title">Prendre rendez-vous</h1>
          <BookingErrorNotice
            title="La page de réservation n’a pas pu être chargée"
            error={error}
          />
        </div>
      </main>
    );
  }
}
