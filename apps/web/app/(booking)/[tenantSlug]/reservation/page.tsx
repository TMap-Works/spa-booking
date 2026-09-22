import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError } from '@/lib/api-client';

import { BookingErrorNotice } from '../booking-error-notice';
import {
  accountPath,
  loadSalonServices,
  loadSalonTenant,
  reservationPath,
  salonPath,
} from '../salon-data';
import { BookingTunnel } from './booking-tunnel';
import { initialBookingDraft } from './initial-draft';

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
 *
 * ## La langue (#846)
 *
 * Cette page n'affiche par elle-même que son encart de panne — le reste des
 * mots appartient au tunnel, qui est un Client Component. Elle est
 * **asynchrone** : ses deux phrases viennent donc de `getTranslations`
 * (`next-intl/server`) et non du crochet, qu'un composant asynchrone ne peut
 * pas appeler.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  /**
   * `?etape=`, `?prestation=`, `?praticien=`, `?creneau=` — la progression du
   * tunnel, que le serveur lit désormais lui-même (#1055).
   *
   * Elle n'y était pas : la page montait le tunnel sans rien lui dire de
   * l'adresse, et celui-ci ne la relisait qu'à l'hydratation. La page est déjà
   * `force-dynamic`, et cette lecture ne lui coûte donc aucune mise en cache
   * qu'elle n'avait pas.
   */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Le titre et la description de l'onglet du tunnel, dans la langue résolue
 * (#846).
 *
 * `generateMetadata` et non un objet `metadata` constant : un littéral ne peut
 * lire ni la langue de la requête ni l'établissement qu'elle vise. C'est le
 * même choix qu'au layout racine, pour la même raison.
 *
 * Le **nom du salon** entre en paramètre et n'est pas traduit — c'est du
 * contenu saisi par l'établissement. Seule la phrase qui l'accueille vient du
 * catalogue.
 *
 * L'établissement est lu par le loader mémoïsé de `salon-data.ts` : la page,
 * le layout et cette fonction n'en font qu'un seul `GET /public/{slug}`. Et
 * elle ne relance jamais l'erreur — Next rendrait une panne serveur là où la
 * page et le layout savent déjà répondre 404 ; un titre sans nom de salon vaut
 * mieux que cela.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tenantSlug } = await params;
  const t = await getTranslations('booking');

  try {
    const tenant = await loadSalonTenant(tenantSlug);

    return {
      title: t('tunnel.page.metadataTitle', { salon: tenant.name }),
      description: t('tunnel.page.metadataDescription', { salon: tenant.name }),
    };
  } catch {
    return { title: t('tunnel.page.title') };
  }
}

export default async function BookingPage({ params, searchParams }: PageProps) {
  const [{ tenantSlug }, search] = await Promise.all([params, searchParams]);

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
        /*
         * « Se connecter », sur l'écran qui barre la route à qui n'a pas de
         * compte, ramène ici (#1087, 2026-09-22).
         *
         * ## Pourquoi le retour ne porte aucune clé de progression
         *
         * Cet `href` est écrit une fois, au rendu serveur. Le tunnel, lui,
         * réécrit l'adresse à chaque étape par `history.replaceState`
         * (`booking-tunnel.tsx`) : quand la cliente atteint « Coordonnées » en
         * cliquant depuis la première étape, l'adresse dit `etape=coordonnees`
         * alors que cette chaîne-ci a été figée sur les paramètres du
         * chargement. Y recopier ce qu'on avait alors reviendrait à la renvoyer
         * sur une étape périmée — et ce serait pire qu'inutile : l'URL **fait
         * foi** dès qu'elle porte une de nos clés (`draftFromSearch`), si bien
         * qu'un `?etape=prestation` rapporté du chargement effacerait la
         * prestation et le créneau que le brouillon conserve.
         *
         * Sans clé, `sessionStorage` a le dernier mot : le brouillon est repris
         * intact et `reachableStep` rouvre l'étape quittée.
         *
         * La clé du paramètre est réécrite plutôt qu'importée du groupe
         * `(account)` — même raison que les chemins voisins (`salon-data.ts`) :
         * la duplication est celle du routeur, et importer ce module-là ferait
         * entrer l'espace client dans le graphe du tunnel. Sa revalidation vit
         * à l'arrivée, seul endroit qui compte (`compte/connexion/return-path.ts`).
         */
        loginHref={`${accountPath(tenantSlug)}/connexion?retour=${encodeURIComponent(reservationPath(tenantSlug))}`}
        // Le même retour, vers l'inscription : réserver exige un compte depuis
        // le 2026-09-22, et la visiteuse qui n'en a pas doit pouvoir l'ouvrir
        // sans perdre sa réservation en cours. `register-form.tsx` rejuge le
        // paramètre de son côté, comme la connexion.
        registerHref={`${accountPath(tenantSlug)}/inscription?retour=${encodeURIComponent(reservationPath(tenantSlug))}`}
        // L'étape et les choix que l'adresse porte, résolus contre le catalogue
        // qu'on vient de charger (#1055). C'est ce qui fait que la progression
        // et le squelette sont justes dès le premier rendu, au lieu d'annoncer
        // « Étape 1 sur 4 » puis de basculer.
        initialDraft={initialBookingDraft(search, services)}
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
    //
    // Les deux phrases viennent du catalogue ; celle de l'encart, non — c'est
    // le message de l'erreur elle-même, écrit par `api-client.ts` ou par
    // l'API, et `BookingErrorNotice` le tient déjà pour une phrase complète.
    const t = await getTranslations('booking');

    return (
      <main className="spa-booking__main" id="contenu">
        <div className="spa-booking__frame spa-booking__content">
          <h1 className="spa-booking__title">{t('tunnel.page.title')}</h1>
          <BookingErrorNotice title={t('tunnel.page.errorTitle')} error={error} />
        </div>
      </main>
    );
  }
}
