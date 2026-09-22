'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';

import { publicExitLabels } from '@/components/salon/public-exits';
import { RouteError } from '@/components/ui/route-error';

import { salonPath } from './compte/paths';

interface AccountShellErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * L'espace client dont le gabarit lui-même n'a pas pu se rendre (#830).
 *
 * ## Pourquoi une frontière au-dessus de celle de `compte/`
 *
 * `compte/error.tsx` est posée **sous** le gabarit du compte, et ne voit donc
 * que les pannes des écrans. Le gabarit, lui, résout l'établissement à chaque
 * visite et relance toute panne qui n'est pas un 404 — une API injoignable en
 * tête. Sans cette frontière, cette panne-là remontait jusqu'à l'écran d'erreur
 * générique de Next : ni reprise, ni lien, la barre d'adresse pour seul recours.
 *
 * Elle ne sert qu'à cela : une panne d'écran est rattrapée plus bas, avec le
 * gabarit encore en place.
 *
 * ## Ce qu'elle rend
 *
 * Le conteneur de l'espace, le titre qu'il aurait porté, la reprise, et la
 * vitrine du salon pour issue — le seul chemin qui ne dépende pas du gabarit
 * tombé, nommé par le registre des sorties publiques. Le nom du salon manque :
 * c'est lui qui n'a pas pu être lu.
 *
 * ## Le titre est celui du gabarit, lu à la même clé (#847)
 *
 * `shell.account.title` et non une seconde entrée dans le catalogue de cet
 * espace : cet écran **remplace** le gabarit tombé, et il doit donc porter le
 * titre que celui-ci aurait écrit (`compte/layout.tsx`). Deux clés pour le même
 * mot, c'est exactement la divergence que ce dépôt recolle ailleurs (#917).
 */
export default function AccountShellError({ reset }: AccountShellErrorProps) {
  const t = useTranslations('account.shellError');
  const shell = useTranslations('shell.account');
  const locale = useLocale();
  const { tenantSlug } = useParams<{ tenantSlug: string }>();

  return (
    <div className="spa-account">
      <header className="spa-account__header">
        <h1 className="spa-account__title">{shell('title')}</h1>
      </header>
      <main className="spa-account__main" id="contenu">
        <RouteError message={t('message')} reset={reset} title={t('title')} />
      </main>
      <footer className="spa-account__footer">
        <a className="spa-account__back" href={salonPath(tenantSlug)}>
          {publicExitLabels(locale).vitrine}
        </a>
      </footer>
    </div>
  );
}
