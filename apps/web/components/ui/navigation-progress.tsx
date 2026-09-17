'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { isTrackedNavigation } from '@/lib/navigation-intent';

import { ProgressBar } from './progress-bar';

/**
 * Au-delà, la barre s'éteint d'elle-même, navigation finie ou non.
 *
 * Elle ne s'éteint normalement que sur un changement d'URL. Une navigation que le
 * serveur redirige vers l'adresse de départ n'en produit aucun, et la barre
 * courrait alors jusqu'au prochain clic : une barre qui ment en permanence est
 * pire qu'une barre qui se tait trop tôt. Quinze secondes couvrent largement un
 * écran lent — la QA relève les écrans à quatre —, et l'indicateur propre au
 * lien cliqué (`LinkPending`), lui, reste exact au-delà.
 */
export const NAVIGATION_PROGRESS_MAX_MS = 15_000;

/**
 * L'indicateur global de navigation (#830).
 *
 * ## Le constat qu'il corrige
 *
 * Au clic sur une entrée du rail, sur « Réserver » ou sur n'importe quel lien
 * interne, rien ne changeait à l'écran jusqu'à l'arrivée de la page suivante :
 * les pages sont `force-dynamic`, et l'écran précédent restait figé, surlignage
 * du rail compris. Le PO l'a relevé au test du 16/09 — « la navigation entre les
 * pages est vraiment mauvaise, aucun chargement ».
 *
 * ## Comment il sait
 *
 * Il s'allume au **clic** sur un lien qui quitte l'écran courant
 * (`isTrackedNavigation`), et s'éteint quand l'**URL** affichée change — chemin
 * ou paramètres, d'où `useSearchParams` : le planning et le reporting naviguent
 * par `?date=` et `?du=`. Aucune dépendance de barre de progression n'est
 * nécessaire pour cela, et `apps/web` n'en a donc pas ajouté.
 *
 * L'écoute est posée sur `document`, en phase de bouillonnement : elle passe
 * après le gestionnaire de `<Link>`, qui a déjà lancé sa transition, et elle
 * couvre aussi les `<a>` nus des pieds de page, dont la navigation complète
 * garde la barre jusqu'au déchargement.
 *
 * ## Où il est monté
 *
 * Une fois, dans le layout racine : les trois produits en profitent sans rien
 * déclarer. `useSearchParams` impose une frontière `<Suspense>` au-dessus de
 * lui pour les écrans rendus statiquement — `app/layout.tsx` la pose.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  // La chaîne et non l'objet : c'est la valeur de l'URL qui compte, pas
  // l'identité de l'instance qui la porte.
  const query = useSearchParams().toString();
  const [pending, setPending] = useState(false);

  // L'arrivée d'une URL, quelle qu'elle soit, clôt l'attente — y compris un
  // retour arrière pendant qu'un clic était en vol.
  useEffect(() => {
    setPending(false);
  }, [pathname, query]);

  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (isTrackedNavigation(event, window.location)) {
        setPending(true);
      }
    }

    // Un `<a>` nu garde la barre jusqu'au déchargement ; si l'onglet revient
    // ensuite par le cache d'historique (bfcache), l'état React revient avec
    // elle, sans changement d'URL pour l'éteindre.
    function onPageShow(event: PageTransitionEvent): void {
      if (event.persisted) {
        setPending(false);
      }
    }

    document.addEventListener('click', onClick);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  useEffect(() => {
    if (!pending) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setPending(false);
    }, NAVIGATION_PROGRESS_MAX_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [pending]);

  return pending ? <ProgressBar /> : null;
}
