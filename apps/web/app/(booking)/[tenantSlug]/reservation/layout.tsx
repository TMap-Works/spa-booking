import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { PublicExits } from '@/components/salon/public-exits';
import { ApiClientError } from '@/lib/api-client';

import { accountPath, loadSalonTenant, salonPath } from '../salon-data';

/**
 * L'enveloppe de page du tunnel de réservation (#623).
 *
 * ## Ce qu'elle répare
 *
 * Le groupe `(booking)` n'avait pas de layout : la vitrine se centrait
 * elle-même par `.spa-salon`, et le tunnel — qui n'a pas d'équivalent — était
 * rendu à même le `<body>`. Résultat, la carte du tunnel touchait les bords de
 * la fenêtre et ses champs faisaient 1 880 px sur un écran de 1 920 px, quand
 * le même formulaire tient dans 672 px sur `/compte/inscription`. Il n'y avait
 * ni bandeau ni pied de page, seuls écrans du parcours client à en manquer.
 *
 * ## Pourquoi sur `reservation/` et non sur `[tenantSlug]/`
 *
 * Un layout posé un cran plus haut envelopperait aussi la vitrine, qui porte
 * déjà son propre conteneur (`.spa-salon`, 64rem) et son propre `<h1>` — elle
 * se retrouverait avec deux bandeaux et deux titres de niveau 1. Le tunnel est
 * la seule route du groupe à n'avoir pas d'enveloppe : c'est donc à elle seule
 * qu'on en donne une.
 *
 * ## L'établissement est résolu ici, et partagé avec la page
 *
 * `loadSalonTenant` est mémoïsé par requête (`salon-data.ts`) : le layout et la
 * page qu'il enveloppe n'en font qu'un seul appel à `GET /public/{slug}`. C'est
 * ce qui permet au bandeau de nommer le salon sans coûter un aller-retour de
 * plus au parcours qui vise un LCP < 2,5 s en 4G.
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router, et ce n'en
 * est pas une ici : il n'y a rien à garder sur le tunnel, qui est public.
 */

/**
 * Même raison que la page qu'il enveloppe : l'établissement change sans que le
 * front en soit averti, et un prérendu au build appellerait l'API depuis le
 * runner de CI ou l'étape `build` de l'image Docker, où elle n'existe pas.
 */
export const dynamic = 'force-dynamic';

interface BookingLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function BookingLayout({ children, params }: BookingLayoutProps) {
  const { tenantSlug } = await params;

  // Établissement inconnu, désactivé, ou slug mal formé : l'API répond 404 sans
  // distinguer les trois, et la page 404 vaut mieux qu'un tunnel qui n'aurait
  // nulle part où s'envoyer (tenant-isolation §4).
  //
  // Toute **autre** panne est laissée à la page, qui sait rendre son encart
  // d'erreur : la relancer ici la ferait remonter à la frontière d'erreur de
  // Next, et le visiteur verrait un écran de panne générique là où le parcours
  // a une phrase à lui dire. Le bandeau perd alors le nom du salon, et lui
  // seul.
  let tenantName: string | null = null;
  try {
    tenantName = (await loadSalonTenant(tenantSlug)).name;
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
  }

  return (
    <div className="spa-booking">
      <header className="spa-booking__header">
        <p className="spa-booking__tenant">{tenantName ?? 'Réservation en ligne'}</p>
        <h1 className="spa-booking__title">Prendre rendez-vous</h1>
        <p className="spa-booking__lead">
          Choisissez votre prestation, puis votre créneau, et laissez-nous vos coordonnées.
        </p>
      </header>
      <main className="spa-booking__main" id="contenu">
        {children}
      </main>
      {/*
        Les mêmes sorties que la vitrine, rendues par le même composant (#739) :
        c'est ce qui garantit qu'un écran ne nomme pas « Mon compte » ce que
        l'autre appelle « Mes rendez-vous ». Le registre a tranché depuis #749 —
        c'est le titre de la destination qui fait foi.
      */}
      <PublicExits
        variant="footer"
        exits={[
          { key: 'vitrine', href: salonPath(tenantSlug) },
          { key: 'compte', href: accountPath(tenantSlug) },
        ]}
      />
    </div>
  );
}
