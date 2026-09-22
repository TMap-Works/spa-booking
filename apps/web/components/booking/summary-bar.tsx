'use client';

import type { Money, TimeZone, UtcInstant } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { DateBlock } from '@/components/ui/date-block';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import {
  formatDuration,
  formatMoney,
  formatTimeInTimeZone,
  type DisplayLocale,
} from '@/lib/format';

/**
 * Ce que le tunnel rappelle de la réservation en cours.
 *
 * Un seul objet, composé par le tunnel et passé tel quel aux étapes : sans
 * lui, l'étape « Coordonnées » — un formulaire qui n'a rien à savoir du
 * catalogue — aurait reçu quatre propriétés de plus pour afficher une ligne de
 * rappel.
 */
export interface BookingSummary {
  readonly serviceName: string;
  readonly durationMinutes: number;
  readonly price: Money;
  /** `null` = « premier disponible » (CDC §1.4), pas « pas encore choisi ». */
  readonly staffName: string | null;
  /** `null` tant qu'aucun créneau n'est retenu — l'étape « Créneau » est là pour ça. */
  readonly startsAt: UtcInstant | null;
  readonly timeZone: TimeZone;
  /**
   * Le pays de l'établissement (`PublicTenant.address.country`), pour la
   * **région** de mise en forme — #846.
   *
   * Il voyage avec le fuseau et pour la même raison : ces faits sont ceux du
   * salon, pas du navigateur. `en-US` écrit « 9/1/2026 » là où `en-GB` écrit
   * « 01/09/2026 », et les deux sont de l'anglais ; le montant suit la même
   * règle. Absent, `lib/format.ts` retombe sur le repli documenté de sa langue.
   *
   * Facultatif : il s'ajoute à un objet que le tunnel compose déjà, et les
   * écrans qui ne le renseignent pas encore gardent le comportement d'avant.
   */
  readonly countryCode?: string | null | undefined;
}

interface SummaryFactsProps {
  readonly summary: BookingSummary;
}

/**
 * Ce qui décide de la mise en forme des dates et des montants (#846) — la
 * langue du lecteur, la région de l'établissement.
 *
 * Composé ici plutôt qu'à chaque appel : les trois surfaces de ce fichier
 * mettent en forme la même réservation, et deux contextes d'affichage pour un
 * seul rendez-vous seraient une divergence de plus à trouver.
 */
function useDisplay(summary: BookingSummary): DisplayLocale {
  return { locale: useLocale(), countryCode: summary.countryCode ?? null };
}

/**
 * Les faits de la réservation, rendus à l'identique dans la feuille du pouce et
 * dans la colonne de bureau.
 *
 * `BM-TUNNEL-07` veut le même récapitulatif des deux côtés — *« une carte
 * collante à droite »* à 1280 px, *« une barre collée en bas … qui se déplie en
 * détail »* à 390 px. Deux compositions séparées auraient fini par dire deux
 * choses différentes du même rendez-vous.
 */
function SummaryFacts({ summary }: SummaryFactsProps) {
  const t = useTranslations('booking');
  const display = useDisplay(summary);

  return (
    <dl className="spa-booking__facts">
      <div className="spa-booking__fact">
        <dt className="spa-booking__fact-term">{t('tunnel.summaryBar.service')}</dt>
        <dd className="spa-booking__fact-value">
          {summary.serviceName}
          <span className="spa-booking__fact-note">
            {formatDuration(summary.durationMinutes, display)}
          </span>
        </dd>
      </div>

      <div className="spa-booking__fact">
        <dt className="spa-booking__fact-term">{t('tunnel.summaryBar.staff')}</dt>
        <dd className="spa-booking__fact-value spa-booking__fact-value--figure">
          {/* Décoratif : le nom est écrit juste à côté. Sur « Premier
              disponible », aucune pastille — il n'y a personne à représenter,
              et « PD » se lirait comme des initiales. */}
          {summary.staffName === null ? null : <Avatar name={summary.staffName} size="sm" />}
          {/* Le nom du praticien est du contenu du salon : il s'affiche tel
              quel. Seule l'absence de préférence est un mot du produit, et
              c'est celui que `StaffChoice` emploie déjà — une seule clé pour
              les deux surfaces (`ds:libelles`). */}
          <span>{summary.staffName ?? t('tunnel.staffChoice.noPreference')}</span>
        </dd>
      </div>

      {summary.startsAt === null ? null : (
        // Rien n'est écrit tant que rien n'est choisi : une ligne « Date et
        // heure : — » ferait passer un choix à venir pour une donnée manquante
        // (`docs/design/appointments/states.md`).
        <div className="spa-booking__fact">
          <dt className="spa-booking__fact-term">{t('tunnel.summaryBar.dateTime')}</dt>
          <dd className="spa-booking__fact-value spa-booking__fact-value--figure">
            <DateBlock instant={summary.startsAt} timeZone={summary.timeZone} />
            <span>{formatTimeInTimeZone(summary.startsAt, summary.timeZone, display)}</span>
          </dd>
        </div>
      )}

      {/* Le total ferme la liste, et c'est le seul fait aligné à droite : c'est
          ce que l'œil cherche en dernier avant de s'engager. */}
      <div className="spa-booking__fact spa-booking__fact--total">
        <dt className="spa-booking__fact-term">{t('tunnel.summaryBar.total')}</dt>
        <dd className="spa-booking__fact-value spa-booking__fact-value--total">
          {formatMoney(summary.price, display)}
        </dd>
      </div>
    </dl>
  );
}

interface BookingActionBarProps {
  /**
   * Les faits rappelés sur une ligne, ou `null` quand il n'y a rien à rappeler.
   *
   * `null` à l'étape « Prestation », où le choix n'est pas encore *retenu* —
   * `ServiceStep` le garde dans son propre état jusqu'à la soumission, et une
   * ligne alimentée par le brouillon annoncerait la prestation précédente
   * pendant qu'on en désigne une autre. `null` aussi au récapitulatif, où ces
   * faits **sont** l'écran.
   */
  readonly summary?: BookingSummary | null;
  /** L'action primaire de l'étape — absente à l'étape « Créneau », qui avance au clic. */
  readonly children?: ReactNode;
}

/**
 * La barre basse du tunnel (#1047) — le rappel sur une ligne, et l'action.
 *
 * ## Ce qu'elle remplace
 *
 * Une barre de quatre couples libellé / valeur en capitales (#735). À 360 px,
 * elle passait à deux rangées à l'étape « Créneau » et à **trois** à l'étape
 * « Coordonnées », où elle masquait environ 160 px du formulaire (audit
 * `d20260918-1`). `BM-TUNNEL-07` décrit l'autre forme, celle de Fresha, de
 * Treatwell, de Booker et de Square : *« une barre collée en bas (« 33 € ·
 * 1 prestation · 30 min » et « Continuer ») qui se déplie en détail »*.
 *
 * D'où les trois décisions qui suivent :
 *
 * 1. **une seule ligne, toujours.** Le nom de la prestation se tronque, la
 *    durée et le prix ne se tronquent jamais — ce sont eux qu'on relit ;
 * 2. **le détail est à un doigt.** Toucher la ligne ouvre le récapitulatif
 *    complet dans un `Sheet`, qui monte du bas au pouce (`BM-TUNNEL-12`) ;
 * 3. **l'action est dans la barre.** *« [ Continuer ] CTA primaire pleine
 *    largeur, au pouce »*, dit `wireframes.md` à la structure commune de toutes
 *    les étapes.
 *
 * ## Pourquoi c'est l'étape qui la rend, et non le tunnel
 *
 * Parce que l'action primaire est presque toujours un `type="submit"`, et
 * qu'un bouton de soumission doit être **dans** son `<form>` : rendu par le
 * tunnel, il aurait fallu l'y rattacher par un attribut `form`, ou le remonter
 * par un portail — deux façons de casser la soumission implicite à la touche
 * Entrée. La barre est donc le dernier enfant de l'étape, et c'est aussi ce qui
 * la rend collante sans mesurer quoi que ce soit.
 *
 * ## Au-delà de 64 rem
 *
 * Elle se décolle et sa ligne de rappel disparaît : `BookingSummaryAside` prend
 * le relais en colonne, et le bouton retombe *« dans le flux »* — l'adaptation
 * desktop que `wireframes.md` décrit pour toutes les étapes.
 *
 * ## La langue (#846)
 *
 * Les mots viennent du catalogue, sous `tunnel.summaryBar` ; les **valeurs** —
 * durée, prix, heure — de `lib/format.ts`, à qui l'on passe la langue du
 * lecteur et le pays de l'établissement (`useDisplay`). Le fuseau, lui, reste
 * celui du salon quelle que soit la langue.
 *
 * La ligne d'annulation est **une seule clé** pour les deux surfaces, et elle
 * dit au mot près ce que le récapitulatif détaille avant de confirmer
 * (`steps/summary-step.tsx`, « Avant de confirmer ») : ni frais ni préavis côté
 * API — `AppointmentsService.cancel` ne refuse que sur le cycle de vie. Deux
 * phrases pour une même règle sur deux écrans qui se suivent, c'est ce que le
 * critère `ds:coherence` relève.
 */
export function BookingActionBar({ summary, children }: BookingActionBarProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  // `useDisplay` prend une réservation, et celle-ci peut manquer : la langue est
  // donc lue directement, un crochet ne se sautant pas derrière une condition.
  const display: DisplayLocale = { locale, countryCode: summary?.countryCode ?? null };

  return (
    <div className="spa-booking__bar">
      {summary === null || summary === undefined ? null : (
        <>
          <button
            type="button"
            className="spa-booking__bar-summary"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setOpen(true);
            }}
          >
            <span className="spa-booking__bar-line">
              <span className="spa-booking__bar-service">{summary.serviceName}</span>
              {/* Les séparateurs sont masqués à l'arbre d'accessibilité : un
                  lecteur d'écran n'a pas à entendre « point » entre deux
                  faits. */}
              <span className="spa-booking__bar-sep" aria-hidden="true">
                ·
              </span>
              <span className="spa-booking__bar-fact">
                {formatDuration(summary.durationMinutes, display)}
              </span>
              <span className="spa-booking__bar-sep" aria-hidden="true">
                ·
              </span>
              <span className="spa-booking__bar-price">{formatMoney(summary.price, display)}</span>
            </span>
            {/* Ce que le clic fait, écrit pour qui ne voit pas le chevron : le
                nom accessible du bouton se terminerait sinon sur un montant,
                sans dire qu'il ouvre quelque chose. */}
            <span className="spa-visually-hidden">{t('tunnel.summaryBar.openDetail')}</span>
            <Icon name="chevron-down" className="spa-booking__bar-chevron" />
          </button>

          <Sheet
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            title={t('tunnel.summaryBar.title')}
          >
            <SummaryFacts summary={summary} />
            <p className="spa-booking__policy">{t('tunnel.summaryBar.cancellation')}</p>
          </Sheet>
        </>
      )}

      {children === undefined ? null : <div className="spa-booking__bar-action">{children}</div>}
    </div>
  );
}

interface BookingSummaryAsideProps {
  readonly summary: BookingSummary;
}

/**
 * La colonne récapitulative, à partir de 64 rem (#1047).
 *
 * `BM-TUNNEL-07` : *« à 1280 px, une carte collante à droite (prestations,
 * praticien, total, « Continuer ») »*, *« le panier et le total restent
 * visibles à chaque étape »*. `wireframes.md` dit la même chose de son côté —
 * *« Résumé en colonne latérale collante ; CTA dans le flux »* — et c'est cette
 * répartition-là qui est suivie : la carte porte les faits, le bouton reste
 * dans la colonne de contenu, où la cliente vient de finir de lire.
 *
 * Ce que le tunnel rendait à la place : rien. Le récapitulatif tombait en pied
 * de carte, sous le contenu de l'étape, et sortait de l'écran dès qu'on
 * défilait.
 *
 * Elle n'est pas rendue en dessous de 64 rem — `BookingActionBar` y tient le
 * même rôle en une ligne. Deux rappels du même rendez-vous sur un écran de
 * 360 px en occuperaient le tiers.
 */
export function BookingSummaryAside({ summary }: BookingSummaryAsideProps) {
  const t = useTranslations('booking');
  const titleId = useId();

  return (
    <aside className="spa-booking__aside" aria-labelledby={titleId}>
      <div className="spa-booking__aside-card">
        <h2 id={titleId} className="spa-booking__aside-title">
          {t('tunnel.summaryBar.title')}
        </h2>
        <SummaryFacts summary={summary} />
        <p className="spa-booking__policy">{t('tunnel.summaryBar.cancellation')}</p>
      </div>
    </aside>
  );
}
