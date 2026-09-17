import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { ApiClientError } from '@/lib/api-client';

import { loadSalonTenant } from '../salon-data';

/**
 * Le layout de la vitrine — un 404 avant le squelette (#830).
 *
 * ## Pourquoi il existe
 *
 * La vitrine a reçu un squelette (`loading.tsx`), et un squelette se paie : il
 * part vers le navigateur **avant** la page, en-tête de réponse compris. Un
 * `notFound()` levé ensuite par la page ne peut plus changer le statut — un slug
 * inconnu aurait répondu 200 avec l'écran « introuvable », là où la vitrine
 * répondait 404 (tenant-isolation §4). Next continue de servir le vrai 404 aux
 * robots, qui attendent la page entière ; ce layout le rend à tout le monde.
 *
 * Il résout donc l'établissement **au-dessus** de la frontière de chargement,
 * comme le fait déjà le layout du tunnel (`reservation/layout.tsx`), et ne
 * décide que du 404. `loadSalonTenant` est mémoïsé par requête
 * (`salon-data.ts`) : la page et ses métadonnées réutilisent ce résultat, et la
 * vitrine ne coûte pas un appel de plus.
 *
 * ## Ce qu'il laisse à la page
 *
 * Toute autre panne — API injoignable, réponse hors contrat. La page sait en
 * rendre l'encart, avec la sortie vers l'espace client ; la relancer ici la
 * ferait remonter à une frontière d'erreur, qui n'a pas cette phrase à dire.
 *
 * Il ne rend aucune enveloppe : la page porte son propre conteneur
 * (`.spa-salon`) et son propre titre.
 */

/** Même raison que la page qu'il enveloppe : l'établissement change sans prévenir. */
export const dynamic = 'force-dynamic';

interface VitrineLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function VitrineLayout({ children, params }: VitrineLayoutProps) {
  const { tenantSlug } = await params;

  try {
    await loadSalonTenant(tenantSlug);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
  }

  return children;
}
