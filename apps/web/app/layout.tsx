import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../styles/index.css';

/**
 * Layout racine des deux produits de `apps/web`.
 *
 * Il ne porte que ce qui leur est commun : la langue du document et le point
 * d'entrée partagé du design system — jetons, socle et six composants de base.
 * Le chrome du tableau de bord (`styles/admin/index.css`) est chargé par le
 * seul layout admin, pour ne pas peser sur le LCP du parcours client
 * (styles/README.md, « Mise en service »).
 */
export const metadata: Metadata = {
  title: 'Réservation en ligne',
  description: 'Prenez rendez-vous dans votre salon en quelques minutes.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
