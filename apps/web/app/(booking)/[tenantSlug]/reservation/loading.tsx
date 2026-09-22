import { useTranslations } from 'next-intl';

import { ProgressBar } from '@/components/ui/progress-bar';

/**
 * Le tunnel de réservation, le temps qu'il arrive (#830, #1047).
 *
 * ## Où il s'affiche
 *
 * **Sous** l'enveloppe du tunnel, qui a déjà décidé du 404 d'un slug inconnu
 * avant que ce squelette parte. Au clic sur « Prendre rendez-vous », la
 * visiteuse voit donc la page du tunnel se poser tout de suite.
 *
 * ## Sa forme
 *
 * Les trois bandes hautes du tunnel : l'en-tête, la ligne de progression, le
 * titre d'étape. Puis une carte grise, **générique**, et c'est le seul endroit du
 * tunnel où elle reste légitime.
 *
 * L'en-tête est ici un squelette et non le vrai : il porte deux commandes qui
 * dépendent de l'étape et du brouillon, et aucune des deux n'existe tant que le
 * tunnel n'est pas là. Une barre inerte d'une hauteur juste vaut mieux qu'un
 * « ✕ Quitter » qui ne saurait pas encore ce qu'il fait perdre.
 *
 * ## Pourquoi elle ne prend pas la forme d'une étape (#1055)
 *
 * Parce qu'à cet instant il n'y a pas d'étape. Ce repli est rendu **avant** que
 * la page ait obtenu l'établissement et son catalogue : rien ici ne sait combien
 * de prestations la liste comptera, ni si les rubriques ouvriront une rangée
 * d'onglets, et un `loading.tsx` ne reçoit par ailleurs aucun paramètre
 * d'adresse. Dessiner six lignes devant un salon qui en propose une ferait
 * sauter la page dans l'autre sens.
 *
 * Le squelette fidèle est donc **un cran plus bas**, dans le tunnel lui-même
 * (`components/booking/step-skeleton.tsx`) : il est monté une fois
 * l'établissement et le catalogue connus, sur l'étape que `initial-draft.ts` a
 * lue dans l'adresse, et c'est lui que `BM-ECRAN-01` vise.
 *
 * ## La langue (#846)
 *
 * Un seul mot à traduire — celui que seul un lecteur d'écran entend. Ce
 * composant n'est pas asynchrone : `useTranslations` y fonctionne, crochet de
 * Server Component compris.
 */
export default function BookingLoading() {
  const t = useTranslations('booking');

  return (
    <>
      <div aria-hidden="true" className="spa-booking__header spa-booking-loading">
        <div className="spa-booking__header-bar">
          <span className="spa-skeleton spa-booking-loading__brand" />
        </div>
      </div>

      <main className="spa-booking__main" id="contenu" aria-busy="true">
        <div className="spa-booking__frame">
          <div className="spa-booking__content spa-booking-loading">
            <ProgressBar />
            <span className="spa-skeleton spa-booking-loading__steps" />
            <span className="spa-skeleton spa-booking-loading__title" />
            <div className="spa-card spa-card--loading">
              <span className="spa-visually-hidden">{t('tunnel.loading.label')}</span>
              <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
              <span className="spa-skeleton spa-card__skeleton-line" />
              <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
