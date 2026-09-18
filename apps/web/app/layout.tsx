import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';

import { NavigationProgress } from '@/components/ui/navigation-progress';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

import '../styles/index.css';

/**
 * Layout racine des deux produits de `apps/web`.
 *
 * Il ne porte que ce qui leur est commun : la langue du document et le point
 * d'entrée partagé du design system — jetons, socle et six composants de base.
 * Le chrome du tableau de bord (`styles/admin/index.css`) est chargé par le
 * seul layout admin, pour ne pas peser sur le LCP du parcours client
 * (styles/README.md, « Mise en service »).
 *
 * Il porte aussi l'indicateur de navigation (#830) : une navigation se signale
 * de la même façon dans les trois espaces, et c'est le seul endroit qui les voit
 * tous. La frontière `<Suspense>` est celle qu'exige `useSearchParams` sur un
 * écran rendu statiquement ; son repli est vide, puisque l'indicateur ne
 * montre rien tant qu'aucun clic n'a eu lieu.
 */
export const metadata: Metadata = {
  title: 'Réservation en ligne',
  description: 'Prenez rendez-vous dans votre salon en quelques minutes.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  // `suppressHydrationWarning` : le script d'amorçage du thème (#855) pose
  // `data-theme` sur `<html>` avant l'hydratation, que le serveur ne connaît pas.
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
