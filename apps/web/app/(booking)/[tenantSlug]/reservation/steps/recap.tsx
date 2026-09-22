import type { ReactNode } from 'react';

import type { ContactDraft } from '@/lib/booking/draft';
import { formatPhoneForDisplay } from '@/lib/phone';

import { EditAction } from './appointment-card';

interface ContactRecapProps {
  readonly contact: ContactDraft;
  /** La correction, ou `null` quand l'écran n'en offre plus. */
  readonly onEdit?: (() => void) | null;
}

interface RecapRowProps {
  readonly term: string;
  readonly children: ReactNode;
}

/**
 * Un couple libellé / valeur du récapitulatif.
 *
 * ## Pourquoi le `<div>` entre la `<dl>` et ses `<dt>`/`<dd>`
 *
 * Sans lui, `<dt>` et `<dd>` sont frères dans le flux de la liste, et rien ne
 * relie visuellement l'un à l'autre : la mise en colonnes demanderait alors une
 * grille, dont les deux pistes retomberaient l'une sous l'autre sur un écran
 * étroit sans que la valeur reste attachée à son libellé. Le groupe de division
 * est explicitement admis par HTML — une `<dl>` accepte des `<div>` dont chacun
 * porte ses `<dt>` et ses `<dd>` — et ne change rien à la sémantique de la liste
 * ni à ce qu'en restitue un lecteur d'écran.
 *
 * C'est exactement la structure d'« Informations pratiques » sur la vitrine
 * (`components/salon/salon-info.tsx`), dont ce bloc reprend la mise en page :
 * les deux surfaces publiques rendent des couples libellé / valeur, elles
 * doivent les rendre pareil.
 */
function RecapRow({ term, children }: RecapRowProps) {
  return (
    <div className="spa-booking__recap-row">
      <dt className="spa-booking__recap-term">{term}</dt>
      <dd className="spa-booking__recap-value">{children}</dd>
    </div>
  );
}

/**
 * Les coordonnées, au récapitulatif (#45, #1051).
 *
 * ## Ce que ce bloc n'est plus
 *
 * Il portait jusqu'ici **tout** le récapitulatif : établissement, prestation,
 * durée, praticien, date, prix et coordonnées, neuf couples d'affilée dont trois
 * passaient à la ligne à 360 px. L'audit `d20260918-1` le relève comme *« une
 * liste désalignée »*, et `BM-TUNNEL-01` veut des blocs corrigeables plutôt
 * qu'une liste. Les sept premiers faits sont donc passés à
 * `BookingAppointmentCard`, qui les met en carte ; ce qui reste est ce qui est
 * réellement un couple libellé / valeur — ce que la cliente vient de taper.
 *
 * ## Pourquoi il garde la liste de définitions
 *
 * Parce que c'est ce qu'il est : quatre étiquettes et leurs valeurs, dont une
 * adresse e-mail que l'œil doit relire caractère par caractère. La mise en
 * colonnes de `booking.css` — calquée sur « Informations pratiques » de la
 * vitrine — reste la bonne forme pour cela, et elle est éprouvée par
 * `tests/booking-recap-columns.test.mjs`.
 *
 * ## Où il n'est pas rendu
 *
 * Sur l'écran de confirmation. Ces coordonnées viennent d'être validées, le
 * rendez-vous est pris, et l'adresse qui compte encore y est nommée par la ligne
 * qui annonce l'e-mail récapitulatif — la redire en liste ferait de l'écran de
 * succès un second formulaire relu.
 */
export function ContactRecap({ contact, onEdit = null }: ContactRecapProps) {
  return (
    <section className="spa-booking__recap-block" aria-label="Vos coordonnées">
      <div className="spa-booking__recap-head">
        {/* Un `<p>` et non un titre : le plan du document du récapitulatif est
            tenu par le `<h1>` de l'étape et par le `<h2>` « Avant de
            confirmer », qui est ce qu'il faut avoir lu avant de soumettre. Le
            nom accessible du bloc est porté par `aria-label` sur la `<section>`,
            qui en fait une région nommée sans ajouter un niveau de titre. */}
        <p className="spa-booking__recap-title">Vos coordonnées</p>
        {onEdit === null ? null : <EditAction target="mes coordonnées" onClick={onEdit} />}
      </div>

      <dl className="spa-booking__recap">
        <RecapRow term="Au nom de">
          {contact.firstName} {contact.lastName}
        </RecapRow>

        <RecapRow term="Adresse e-mail">{contact.email}</RecapRow>

        {contact.phone === '' ? null : (
          <RecapRow term="Téléphone">{formatPhoneForDisplay(contact.phone)}</RecapRow>
        )}

        {contact.clientNote === '' ? null : (
          <RecapRow term="Votre mot au salon">{contact.clientNote}</RecapRow>
        )}
      </dl>
    </section>
  );
}
