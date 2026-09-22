import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
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
 *
 * ## La langue (#845)
 *
 * `<html lang>` **suit la langue résolue**, et ne peut se poser qu'ici : il n'y
 * a qu'un `<html>` dans l'application, et c'est ce layout qui le rend. La règle
 * de résolution — choix explicite, compte, `Accept-Language`, établissement,
 * puis `en` — est dans `i18n/resolve.ts` ; `getLocale()` en rend le verdict pour
 * la requête en cours.
 *
 * `NextIntlClientProvider` est posé au même endroit, et pour une raison de
 * portée : les Client Components du produit sont dispersés dans les trois
 * espaces — le sélecteur de thème, le champ de mot de passe, la barre du
 * back-office —, et un fournisseur par espace aurait laissé sans messages ceux
 * qui vivent au-dessus. Le coût est celui des catalogues dans la charge utile
 * RSC : quelques kilo-octets, pour un produit qui n'a que deux langues.
 *
 * La conséquence à connaître : lire un cookie et un en-tête rend ce layout
 * **dynamique**, donc toutes les pages avec lui. Le parcours l'était déjà — les
 * trois gabarits de salon déclarent `force-dynamic` parce qu'ils lisent la
 * session ou l'établissement — et une langue qui dépend de la requête ne peut de
 * toute façon pas être figée à la construction.
 */

/**
 * Le titre et la description de l'onglet, dans la langue résolue.
 *
 * `generateMetadata` et non un objet `metadata` constant : un littéral ne peut
 * pas lire la requête, et ces deux phrases sont ce qu'un moteur de recherche et
 * un aperçu de lien montrent du produit.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.metadata');

  return {
    title: t('title'),
    description: t('description'),
  };
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const locale = await getLocale();

  // `suppressHydrationWarning` : le script d'amorçage du thème (#855) pose
  // `data-theme` sur `<html>` avant l'hydratation, que le serveur ne connaît pas.
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider>
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
