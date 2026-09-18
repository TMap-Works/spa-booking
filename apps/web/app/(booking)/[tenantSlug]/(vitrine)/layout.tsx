import type { PublicTenant } from '@spa/shared';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { SalonShell } from '@/components/salon/salon-shell';
import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError } from '@/lib/api-client';

import { loadSalonServices, loadSalonTenant, reservationPath } from '../salon-data';

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
 * ## Le gabarit du salon (#1045)
 *
 * L'en-tête et le pied de page du salon sont posés ici plutôt que par la page :
 * le squelette de chargement et l'écran de reprise, qui vivent sous ce layout,
 * les ont ainsi dès le premier octet, et rien ne saute à l'arrivée de la page.
 * Le catalogue est lu par le même loader mémoïsé que la page : « Prendre
 * rendez-vous » ne s'affiche que s'il y a une prestation à réserver (#773),
 * sans appel de plus. Une panne du catalogue n'y fait pas obstacle — l'en-tête
 * garde alors le bouton, comme le fait `generateMetadata`.
 *
 * La vitrine ne reçoit pas les jetons de session, bornés à l'espace client :
 * c'est le cookie de présence qui lui dit qui saluer (`lib/account-presence.ts`).
 */

/** Même raison que la page qu'il enveloppe : l'établissement change sans prévenir. */
export const dynamic = 'force-dynamic';

interface VitrineLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function VitrineLayout({ children, params }: VitrineLayoutProps) {
  const { tenantSlug } = await params;
  // Chaîné sur une promesse déjà résolue : une lecture qui échouerait avant même
  // de rendre sa promesse retombe dans le même repli, au lieu de lever ici.
  const bookable = Promise.resolve(tenantSlug)
    .then(loadSalonServices)
    .then(
      (services) => services.length > 0,
      () => true,
    );

  let tenant: PublicTenant | null = null;
  try {
    tenant = await loadSalonTenant(tenantSlug);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
  }

  const presence = await readAccountPresence();

  return (
    <SalonShell
      tenantSlug={tenantSlug}
      tenant={tenant}
      signedIn={presence !== null}
      presence={presence}
      bookingHref={(await bookable) ? reservationPath(tenantSlug) : null}
    >
      {children}
    </SalonShell>
  );
}
