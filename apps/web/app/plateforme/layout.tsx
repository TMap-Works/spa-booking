import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import '../../styles/admin/index.css';

/**
 * La console de l'éditeur — l'espace où l'on ouvre les salons (ADR 0012).
 *
 * Elle emprunte le chrome du back-office — mêmes jetons, même rail, mêmes
 * tableaux — sans en partager ni la session ni les écrans : un jeton de salon
 * n'ouvre rien ici, et un jeton de console n'ouvre aucun salon.
 *
 * Le titre est traduit (#1106) : c'est ce qu'un onglet affiche, et un onglet est
 * du texte visible comme un autre. D'où `generateMetadata` plutôt qu'une
 * constante — `getTranslations` est asynchrone, et l'objet `metadata` statique ne
 * peut pas l'attendre.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platform');

  return {
    title: t('meta.title'),
    robots: { index: false, follow: false },
  };
}

export const dynamic = 'force-dynamic';

export default function PlatformLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
