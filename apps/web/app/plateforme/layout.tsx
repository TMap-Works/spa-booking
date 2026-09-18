import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../../styles/admin/index.css';

/**
 * La console de l'éditeur — l'espace où l'on ouvre les salons (ADR 0012).
 *
 * Elle emprunte le chrome du back-office — mêmes jetons, même rail, mêmes
 * tableaux — sans en partager ni la session ni les écrans : un jeton de salon
 * n'ouvre rien ici, et un jeton de console n'ouvre aucun salon.
 */

export const metadata: Metadata = {
  title: 'Console plateforme',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function PlatformLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
