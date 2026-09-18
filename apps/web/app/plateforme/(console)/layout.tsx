import { Inter } from 'next/font/google';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/ui/theme-toggle';

import { PlatformRail } from '../components/platform-rail';
import { platformLoginPath } from '../paths';
import { readPlatformAccessToken, readPlatformOperatorName } from '../session';

/** La police du back-office (#1058) — la console en porte la même coquille. */
const consoleFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--spa-admin-font',
});

/**
 * Le cadre de la console : un rail, une barre haute et l'écran courant.
 *
 * La garde est ici, et non page par page comme au back-office : la console n'a
 * qu'un écran servi sans session — la connexion —, et elle vit hors de ce
 * groupe. Le jeton n'est que **lu** : c'est l'API qui décide s'il vaut encore
 * quelque chose, et un 401 sur un écran renvoie à la connexion.
 */
export default async function PlatformConsoleLayout({ children }: { readonly children: ReactNode }) {
  if ((await readPlatformAccessToken()) === null) {
    redirect(platformLoginPath());
  }

  return (
    <div className={`spa-admin ${consoleFont.variable}`}>
      <PlatformRail operatorName={await readPlatformOperatorName()} />
      <div className="spa-admin__main">
        <header className="spa-admin-topbar">
          <div className="spa-admin-topbar__context">
            <span className="spa-admin-topbar__eyebrow">Console plateforme</span>
            <span className="spa-admin-topbar__date">Les salons de la plateforme</span>
          </div>
          <div className="spa-admin-topbar__actions">
            <ThemeToggle />
          </div>
        </header>
        <main className="spa-admin__content" id="contenu">
          {children}
        </main>
      </div>
    </div>
  );
}
