'use client';

import { useTranslations } from 'next-intl';

import { RouteError } from '@/components/ui/route-error';

interface BookingErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Le tunnel de réservation qui n'a pas pu se rendre (#830).
 *
 * Posée sous l'enveloppe du tunnel. Les pannes de l'API sont déjà dites par la
 * page ; cette frontière ne voit que ce qui leur échappe.
 *
 * Sans en-tête de tunnel (#1047) : il n'y a ni établissement à nommer, ni étape
 * à quitter — le composant ne reçoit que l'erreur et sa reprise. Le `<h1>`, lui,
 * reste : il vivait dans le layout jusqu'à #1047, qui l'a déplacé dans
 * `BookingProgress` — c'est-à-dire dans le tunnel, que cet écran-ci remplace
 * précisément parce qu'il n'a pas pu se rendre. Sans cette ligne, la page n'a
 * plus le moindre titre, le nom de l'encart d'erreur étant un `<p>`
 * (`components/ui/notification.tsx`) : rien à quoi un lecteur d'écran puisse
 * sauter, et aucun titre de niveau 1 (WCAG 2.4.6).
 *
 * La reprise rejoue la page sans toucher au brouillon du tunnel : il vit dans le
 * stockage de session (`use-draft-autosave.ts`), et les saisies déjà faites
 * reviennent avec le tunnel (`docs/design/appointments/states.md` : un état
 * d'erreur conserve les saisies).
 *
 * Même cadre que l'encart d'erreur de la page, pour que les deux pannes se
 * ressemblent.
 *
 * ## La langue (#846)
 *
 * Le titre de la page et celui de l'encart sont **ceux de la page voisine** —
 * `tunnel.page.title` et `tunnel.page.errorTitle` : les deux écrans disent la
 * même panne, et deux clés pour une phrase sont la façon dont elles finissent
 * par diverger. Seule la phrase du corps appartient à cette frontière-ci, qui
 * ne voit que ce qui échappe à l'API — et c'est `errors.unexpected`, la phrase
 * que tout le parcours public emploie pour ce dont il ne sait rien
 * (`booking-error-notice.tsx`), plutôt qu'une quatrième écriture des mêmes mots.
 */
export default function BookingError({ reset }: BookingErrorProps) {
  const t = useTranslations('booking');

  return (
    <main className="spa-booking__main" id="contenu">
      <div className="spa-booking__frame spa-booking__content">
        <h1 className="spa-booking__title">{t('tunnel.page.title')}</h1>
        <RouteError
          message={t('errors.unexpected')}
          reset={reset}
          title={t('tunnel.page.errorTitle')}
        />
      </div>
    </main>
  );
}
