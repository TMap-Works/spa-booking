import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { ApiClientError } from '@/lib/api-client';

import { loadSalonTenant } from '../salon-data';

/**
 * L'enveloppe de page du tunnel de réservation (#623, #1047).
 *
 * ## Ce qu'elle porte, et ce qu'elle ne porte plus
 *
 * Elle posait jusqu'ici un bandeau de page — surcapitale « SPA LUMIÈRE », titre
 * « Prendre rendez-vous », phrase d'accroche — et un pied de sorties publiques.
 * `BM-TUNNEL-10` (`docs/design/benchmark/parcours-client.md`) dit le contraire
 * de ce que faisaient ces deux bandes : *« la navigation du site disparaît au
 * profit d'un "←" (étape précédente) et d'un "×" (quitter) »*, pour que
 * *« l'attention reste sur la réservation »*. Le titre unique, lui, ne disait
 * jamais ce que l'écran demandait — `BM-TUNNEL-11` veut un titre par étape.
 *
 * Les deux appartiennent désormais au tunnel lui-même
 * (`components/booking/tunnel-header.tsx` et `tunnel-progress.tsx`), qui est le
 * seul à connaître l'étape en cours et le brouillon — donc le seul à pouvoir
 * décider de ce que « ← Retour » rouvre et de ce que « ✕ Quitter » fait perdre.
 * Il ne reste ici que l'enveloppe de page et le 404 d'un établissement inconnu.
 *
 * ## Pourquoi sur `reservation/` et non sur `[tenantSlug]/`
 *
 * Un layout posé un cran plus haut envelopperait aussi la vitrine, qui a son
 * propre gabarit depuis #1045 (`SalonShell`) — elle se retrouverait avec deux
 * en-têtes. Le tunnel est la seule route du groupe à n'être pas dans ce
 * gabarit, et c'est délibéré : le sien se réduit à revenir et sortir.
 *
 * ## L'établissement est résolu ici, et partagé avec la page
 *
 * `loadSalonTenant` est mémoïsé par requête (`salon-data.ts`) : le layout et la
 * page qu'il enveloppe n'en font qu'un seul appel à `GET /public/{slug}`. Ce
 * qu'on en lit ici est la seule chose qu'un layout puisse en faire — le 404.
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
  // a une phrase à lui dire.
  try {
    await loadSalonTenant(tenantSlug);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
  }

  return <div className="spa-booking">{children}</div>;
}
