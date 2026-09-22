'use client';

import type { CalendarDate, OpeningHoursEntry } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  dayStateOf,
  dayStateSaid,
  isSelectableState,
  type DayState,
  type DayStateContext,
  type DayStateWords,
} from '@/lib/booking/day-state';
import { publishedOpenWeekdays } from '@/lib/booking/opening-days';
import {
  WEEKDAY_KEYS,
  addMonths,
  dayOfMonth,
  formatMonth,
  isNavigableMonth,
  isWithinWindow,
  monthMoveForKey,
  monthOf,
  monthWeeks,
  moveInMonth,
  type BookingWindow,
  type CalendarMonth,
} from '@/lib/booking/month-grid';
import { formatCalendarDate, type DisplayLocale } from '@/lib/format';

/**
 * Le nom accessible d'une journée — « jeudi 17 septembre 2026 — 2 créneaux »
 * (#846).
 *
 * Écrit ici et demandé par la bande de jours plutôt que relu de son côté :
 * `day-state.ts` existe précisément pour que le calendrier et la bande ne
 * disent jamais deux choses différentes d'une même journée, et deux lectures du
 * catalogue rouvriraient l'écart au premier correctif.
 *
 * La date vient d'`Intl` (`lib/format.ts`), les mots du catalogue, et le tiret
 * qui les sépare de la phrase qui les assemble : une langue peut avoir à les
 * ordonner autrement.
 */
export function useDayLabel(
  display: DisplayLocale,
): (date: CalendarDate, state: DayState, slotCount: number | null) => string {
  const t = useTranslations('booking');
  const words: DayStateWords = {
    // Le pluriel est tranché par ICU, dans le catalogue : « 1 créneau » et
    // « 3 créneaux » ne se découpent pas pareil d'une langue à l'autre.
    slotCount: (count: number) => t('tunnel.calendar.slotCount', { count }),
    loading: t('tunnel.calendar.loading'),
    outsideWindow: t('tunnel.calendar.outsideWindow'),
    closed: t('tunnel.calendar.closed'),
    full: t('tunnel.calendar.full'),
  };

  return (date, state, slotCount) =>
    t('tunnel.calendar.dayLabel', {
      date: formatCalendarDate(date, display),
      state: dayStateSaid(state, slotCount, words),
    });
}

/**
 * Le calendrier mensuel de disponibilité (#827).
 *
 * ## Pourquoi un calendrier, et pourquoi ici
 *
 * Le CDC §1.4 prescrit un « calendrier de disponibilité temps réel », et
 * [wireframes.md](../../../../docs/design/appointments/wireframes.md) étape 3 en
 * dessine un : « ‹ août 2026 › », une ligne `L M M J V S D`, la date retenue
 * mise en avant. Ce qui était rendu était une **bande de journées à faire
 * défiler** — trois jours et demi visibles à 360 px, le quatrième coupé, et
 * « Voir plus de jours » pour aller au-delà de quatorze. On ne voyait donc
 * jamais d'un coup d'œil quels jours avaient des créneaux, et atteindre une date
 * à trois semaines demandait de faire défiler une bande sans affordance.
 *
 * Il vit dans `components/booking/` et non dans l'un des deux écrans pour la
 * raison qui a déjà fait remonter [`SlotPicker`](slot-picker.tsx) ici (#622) :
 * le tunnel de réservation et le report d'un rendez-vous font **le même geste**,
 * et deux implémentations, ce sont deux comportements clavier dont un seul
 * reçoit les corrections. Il est monté par `SlotPicker`, que les deux écrans
 * montent déjà — il n'y a donc, à nouveau, qu'un seul calendrier dans le
 * produit public.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne charge rien et ne décide de rien. Le mois visible, la fenêtre de
 * réservation et les comptes de créneaux lui sont **donnés** ; changer de mois
 * remonte à l'appelant, qui sait seul comment reposer la question — une action
 * serveur dans le tunnel, une adresse dans le report, dont le rendu est serveur.
 * Le calendrier ne fait que montrer, et dire ce qui a été touché.
 *
 * ## Le clavier
 *
 * [keyboard-navigation.md](../../../../docs/design/appointments/keyboard-navigation.md)
 * fixe le modèle : *roving tabindex*, une seule tabulation pour entrer et une
 * pour sortir, flèches à l'intérieur, **sans enroulement** aux bords. Le
 * calendrier ajoute à la bande les deux touches qu'une grille bidimensionnelle
 * appelle — `↑`/`↓` à la semaine, `Début`/`Fin` aux bords de la ligne — et
 * déplace `PagePréc`/`PageSuiv` de la semaine au **mois**, l'axe vertical portant
 * désormais la semaine.
 *
 * **Activation automatique** : la flèche déplace le focus *et* retient la
 * journée, comme le faisait la bande. Une journée complète, elle, se laisse
 * atteindre sans se laisser retenir : dans une grille de dates, une case qu'on
 * ne peut pas atteindre est une case dont on ne peut pas lire l'état, et
 * « complet » est précisément ce qu'on vient y lire.
 *
 * ## « Fermé » n'est pas « complet » (#742)
 *
 * Le calendrier écrivait « complet » sur toute journée sans créneau, samedis et
 * dimanches compris — alors que la vitrine du même salon publie des horaires du
 * lundi au vendredi. Le CDC §2.3 demande pourtant que l'interface dise **lequel
 * des deux** empêche de réserver : les horaires du salon, ou les rendez-vous
 * déjà pris. « Complet » invite à repasser plus tard, « Fermé » à choisir un
 * autre jour.
 *
 * La distinction se lit dans les horaires publiés de l'établissement
 * (`openingHours`), et seulement pour **nommer** une journée que le moteur a
 * déjà déclarée sans créneau — voir
 * [`opening-days.ts`](../../lib/booking/opening-days.ts) pour ce que ces plages
 * décrivent et ce qu'elles ne décident pas.
 *
 * ## La langue (#846)
 *
 * Trois sources, et une seule par nature de texte :
 *
 * - le **nom du mois** vient d'`Intl` (`formatMonth`, qui reçoit le
 *   `DisplayLocale`) — la bibliothèque standard le sait déjà dire ;
 * - les **jours de la semaine**, eux, viennent du catalogue et non d'`Intl` :
 *   `month-grid.ts` écrit pourquoi — la forme abrégée d'une locale dépend de la
 *   version d'ICU, et l'en-tête différerait entre la CI et le poste ;
 * - les **mots** — chevrons, état d'une journée — viennent du catalogue, sous
 *   `tunnel.calendar`.
 *
 * Ce que la langue **ne change pas** : la semaine commence au lundi du contrat
 * (`ISO_WEEKDAYS`), et les journées restent celles du fuseau de
 * l'établissement.
 */
interface AvailabilityCalendarProps {
  /** Le mois affiché, `YYYY-MM`. */
  readonly month: CalendarMonth;
  /** Les bornes réservables — au-delà, les cases sont rendues mais inertes. */
  readonly bounds: BookingWindow;
  /**
   * Le nombre de créneaux par date du mois visible.
   *
   * `null` veut dire « on ne sait pas encore » et non « il n'y a rien » : les
   * cases restent alors opérables, `states.md` étape 3 demandant explicitement
   * de pouvoir changer de jour sans attendre la réponse. Une date absente de la
   * table est une date dont le serveur n'a rien dit, donc une date sans créneau.
   */
  readonly slotCounts: ReadonlyMap<CalendarDate, number> | null;
  /**
   * Les plages d'ouverture publiées par l'établissement, telles que la vitrine
   * les affiche.
   *
   * Elles ne servent qu'à **nommer** une journée déjà sans créneau : « Fermé »
   * quand le salon n'ouvre pas ce jour-là, « Complet » sinon (#742). Absentes —
   * le cas d'un salon qui n'a rien publié —, aucune journée n'est déclarée
   * fermée : l'API omet ces horaires plutôt que de rendre une semaine vide, et
   * « pas encore renseigné » ne se lit pas « ne travaille jamais ».
   */
  readonly openingHours?: readonly OpeningHoursEntry[] | undefined;
  /** La journée retenue, quand elle tombe dans le mois affiché. */
  readonly selectedDate: CalendarDate | null;
  /** Une action est en vol : plus rien ne se retient tant qu'elle n'a pas rendu. */
  readonly busy?: boolean;
  /**
   * Le pays de l'établissement, pour la **région** des dates (#846) — la
   * semaine, elle, commence toujours au lundi du contrat.
   */
  readonly countryCode?: string | null | undefined;
  /** Le conteneur de la grille, quand l'appelant doit y poser le focus. */
  readonly calendarRef?: RefObject<HTMLDivElement | null> | undefined;
  readonly onMonthChange: (month: CalendarMonth) => void;
  readonly onSelect: (date: CalendarDate) => void;
  /**
   * L'**activation délibérée** d'une case — un clic, `Entrée` ou `Espace` —, par
   * opposition au déplacement du focus, qui retient la journée sans conclure.
   *
   * Les deux ne peuvent pas être confondus depuis que le calendrier vit dans un
   * panneau (#1049) : l'activation automatique des flèches est voulue — elle date
   * de la bande d'avant #827 —, mais refermer le panneau à chaque `→` rendrait le
   * mois impossible à parcourir au clavier.
   */
  readonly onConfirm?: ((date: CalendarDate) => void) | undefined;
}

export function AvailabilityCalendar({
  month,
  bounds,
  slotCounts,
  openingHours,
  selectedDate,
  busy = false,
  countryCode,
  calendarRef,
  onMonthChange,
  onSelect,
  onConfirm,
}: AvailabilityCalendarProps) {
  const t = useTranslations('booking');
  const display: DisplayLocale = { locale: useLocale(), countryCode: countryCode ?? null };
  const dayLabel = useDayLabel(display);
  const weeks = useMemo(() => monthWeeks(month), [month]);
  /** Les jours de semaine que le salon annonce ouverts — `null` s'il n'a rien publié. */
  const openWeekdays = useMemo(() => publishedOpenWeekdays(openingHours), [openingHours]);

  /**
   * L'état d'une case, tel que [`day-state.ts`](../../lib/booking/day-state.ts)
   * le définit.
   *
   * La règle est partagée avec la bande de jours (#1049) : les deux contrôles
   * peignent les mêmes journées et doivent en dire exactement la même chose, et
   * deux implémentations divergeraient au premier correctif.
   */
  const context = useMemo<DayStateContext>(
    () => ({ month, bounds, slotCounts, openWeekdays }),
    [bounds, month, openWeekdays, slotCounts],
  );

  const stateOf = useCallback(
    (date: CalendarDate): DayState => dayStateOf(date, context),
    [context],
  );

  /** Une case se retient quand elle a — ou peut encore avoir — quelque chose à montrer. */
  const canSelect = useCallback(
    (date: CalendarDate): boolean => !busy && isSelectableState(stateOf(date)),
    [busy, stateOf],
  );

  /**
   * La case qui porte le `tabindex` — le *roving tabindex* du document de
   * conception.
   *
   * Une seule case est dans l'ordre de tabulation : `Tab` entre dans le
   * calendrier, les flèches y circulent, `Tab` en ressort vers la grille de
   * créneaux. Sans cela, un mois imposerait trente et une tabulations pour
   * atteindre le bloc suivant.
   */
  const [activeDate, setActiveDate] = useState<CalendarDate | null>(null);
  const ownRef = useRef<HTMLDivElement | null>(null);
  const gridNode = calendarRef ?? ownRef;
  /**
   * La date sur laquelle poser le focus au prochain rendu.
   *
   * Le déplacement au clavier peut franchir un mois — `→` le 30 septembre, ou
   * `PageSuiv` — et la case visée n'existe alors pas encore dans le document :
   * c'est le rendu qui suit `onMonthChange` qui la crée. Appeler `focus()` dans
   * le gestionnaire de touche ne trouverait rien, et le focus retomberait sur
   * `<body>` au milieu d'un geste délibéré, ce que `keyboard-navigation.md`
   * refuse partout ailleurs.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const pendingFocus = useRef<CalendarDate | null>(null);

  const days = useMemo(
    () => weeks.flat().filter((date): date is CalendarDate => date !== null),
    [weeks],
  );

  /**
   * La case réellement focalisable.
   *
   * On suit la journée retenue quand elle tombe dans le mois affiché — c'est
   * elle que la grille de créneaux détaille en dessous. Sinon on retombe sur la
   * première journée libre du mois, puis sur la première journée réservable,
   * puis sur la première tout court : un calendrier sans aucun arrêt de
   * tabulation serait inatteignable au clavier, ce qui est exactement le défaut
   * qu'on répare.
   */
  const tabbableDate =
    days.find((date) => date === activeDate) ??
    days.find((date) => date === selectedDate) ??
    days.find((date) => stateOf(date) === 'libre') ??
    days.find((date) => isWithinWindow(date, bounds)) ??
    days[0] ??
    null;

  /**
   * Le focus rattrapé une fois la case visée présente dans le document.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    const wanted = pendingFocus.current;

    if (wanted === null) {
      return;
    }

    const target = gridNode.current?.querySelector<HTMLButtonElement>(
      `[data-day="${wanted}"] button`,
    );

    if (target !== null && target !== undefined) {
      pendingFocus.current = null;
      target.focus();
    }
  });

  /** Retenir une journée : elle devient la case active, et la grille la détaille. */
  const choose = useCallback(
    (date: CalendarDate, activated: boolean) => {
      setActiveDate(date);

      if (!canSelect(date)) {
        return;
      }

      onSelect(date);

      if (activated) {
        onConfirm?.(date);
      }
    },
    [canSelect, onConfirm, onSelect],
  );

  /**
   * Les flèches circulent dans le calendrier.
   *
   * La touche est consommée dès qu'elle nous regarde, même quand la date ne
   * bouge pas : en bord de fenêtre, laisser passer `↓` ferait défiler la page
   * sous un focus resté sur place, ce qui se lit comme une commande qui a
   * fonctionné.
   */
  const moveFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const move = monthMoveForKey(event.key);

      if (move === null || tabbableDate === null) {
        return;
      }

      event.preventDefault();

      const target = moveInMonth(tabbableDate, move, bounds);
      const targetMonth = monthOf(target);

      // Armé seulement quand la case visée **change** : en bord de fenêtre la
      // touche ne mène nulle part, aucun état ne bouge, donc aucun rendu ne vient
      // consommer la cible — elle resterait armée et le premier rendu venu
      // ramènerait le focus dans le calendrier, qu'on l'ait quitté ou non.
      if (target !== tabbableDate) {
        pendingFocus.current = target;
      }

      choose(target, false);

      if (targetMonth !== month) {
        onMonthChange(targetMonth);
      }
    },
    [bounds, choose, month, onMonthChange, tabbableDate],
  );

  /**
   * Un chevron de période, et ce qu'il fait.
   *
   * Le focus **ne suit pas** — il reste sur le chevron, pour qu'on puisse
   * remonter trois mois en trois clics sans avoir à viser de nouveau. C'est la
   * différence avec les flèches, où le focus est déjà dans la grille et doit y
   * rester.
   */
  const step = (delta: -1 | 1): void => {
    const target = addMonths(month, delta);

    if (!isNavigableMonth(target, bounds)) {
      return;
    }

    // La journée active appartenait au mois qu'on quitte : la garder laisserait
    // le calendrier sans arrêt de tabulation. Le repli en choisit une autre.
    setActiveDate(null);
    onMonthChange(target);
  };

  const previousReachable = isNavigableMonth(addMonths(month, -1), bounds);
  const nextReachable = isNavigableMonth(addMonths(month, 1), bounds);
  // « septembre 2026 », « September 2026 » — le nom du mois vient d'`Intl`, pas
  // d'un catalogue : la bibliothèque standard le sait déjà dire.
  const monthLabel = formatMonth(month, display);

  return (
    <div className="spa-calendar">
      {/*
        « ‹ septembre 2026 › » — la navigation de période de `wireframes.md`,
        étape 3, que la bande rendait déjà à la semaine. Le mois **entre** les
        deux chevrons, comme la barre du back-office rend le même geste : posé
        avant eux, il laisserait deux contrôles orphelins. Le chevron est
        `aria-hidden` — un signe typographique ne se lit pas —, et c'est le
        libellé masqué qui nomme le contrôle.

        `aria-disabled` et non `disabled` : le chevron éteint reste atteignable
        au clavier, comme les journées complètes et les créneaux inertes. Trois
        contrôles inactifs, une seule façon de le dire.

        `role="status"` sur le libellé : un chevron cliqué ne déplace pas le
        focus, et sans lui rien n'annoncerait le changement de mois à qui ne voit
        pas l'écran. Un seul mot change, la région reste discrète.
      */}
      <div className="spa-calendar__nav">
        <Button
          variant="neutral"
          aria-disabled={previousReachable ? undefined : true}
          onClick={() => {
            step(-1);
          }}
        >
          <span aria-hidden="true">‹</span>
          <span className="spa-visually-hidden">{t('tunnel.calendar.previousMonth')}</span>
        </Button>

        <span className="spa-calendar__period" role="status">
          {monthLabel}
        </span>

        <Button
          variant="neutral"
          aria-disabled={nextReachable ? undefined : true}
          onClick={() => {
            step(1);
          }}
        >
          <span aria-hidden="true">›</span>
          <span className="spa-visually-hidden">{t('tunnel.calendar.nextMonth')}</span>
        </Button>
      </div>

      {/*
        Grille composite, comme celle des créneaux : `grid` › `row` ›
        `columnheader` / `gridcell` › `<button>` natif. Les initiales sont
        visibles, leur nom complet porté par l'`aria-label` de l'en-tête — trois
        colonnes s'appellent « M » ou « S » à l'écran, et un lecteur d'écran qui
        les énoncerait ainsi ne dirait rien.
      */}
      <div
        ref={gridNode}
        className="spa-calendar__grid"
        role="grid"
        aria-label={t('tunnel.calendar.gridLabel', { month: monthLabel })}
        onKeyDown={moveFocus}
      >
        <div role="row" className="spa-calendar__row spa-calendar__row--head">
          {WEEKDAY_KEYS.map((weekday) => (
            <span
              // Deux colonnes portent « M » et deux « S » : la clé du jour fait
              // la clé de liste, l'initiale ne suffirait pas à les distinguer.
              key={weekday}
              role="columnheader"
              className="spa-calendar__weekday"
              // Clés construites, comme dans `components/ui/locale-switcher.tsx` :
              // sept jours, deux formes, et quatorze `t(...)` littéraux ne
              // diraient rien de plus. L'`as` désigne des clés réelles, que
              // `WEEKDAY_KEYS` tient avec le catalogue.
              aria-label={t(`tunnel.calendar.weekdays.${weekday}` as 'tunnel.calendar.weekdays.monday')}
            >
              <span aria-hidden="true">
                {t(
                  `tunnel.calendar.weekdayInitials.${weekday}` as 'tunnel.calendar.weekdayInitials.monday',
                )}
              </span>
            </span>
          ))}
        </div>

        {weeks.map((week) => (
          // La semaine se nomme par son premier jour du mois : deux mois voisins
          // n'ont jamais le même, là où un rang de ligne se répéterait.
          <div
            role="row"
            className="spa-calendar__row"
            key={week.find((date) => date !== null) ?? month}
          >
            {week.map((date, column) =>
              date === null ? (
                // Une case hors du mois : rendue vide plutôt que remplie du jour
                // du mois voisin, dont on n'a pas demandé la disponibilité.
                <span
                  role="gridcell"
                  className="spa-calendar__cell spa-calendar__cell--outside"
                  key={`${month}-hors-${String(column)}`}
                />
              ) : (
                <CalendarDay
                  key={date}
                  date={date}
                  state={stateOf(date)}
                  label={dayLabel(date, stateOf(date), slotCounts?.get(date) ?? null)}
                  selected={date === selectedDate}
                  selectable={canSelect(date)}
                  tabbable={date === tabbableDate}
                  onChoose={choose}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface CalendarDayProps {
  readonly date: CalendarDate;
  readonly state: DayState;
  /** Le nom accessible déjà composé — date en toutes lettres et état (#846). */
  readonly label: string;
  readonly selected: boolean;
  readonly selectable: boolean;
  readonly tabbable: boolean;
  readonly onChoose: (date: CalendarDate, activated: boolean) => void;
}

/**
 * Une journée du calendrier.
 *
 * ## `aria-disabled` et non `disabled`
 *
 * Une journée inerte reste **atteignable au clavier**, comme les créneaux de la
 * grille : la désactiver pour de bon ferait un trou dans le calendrier — les
 * flèches y appellent `focus()`, qu'un bouton désactivé ignore, et la case
 * suivante deviendrait inatteignable. Elle est surtout ce qu'on vient lire :
 * savoir que le 24 est complet vaut mieux que de ne pas pouvoir s'y poser.
 *
 * ## La disponibilité ne se dit pas par la seule couleur
 *
 * Une journée libre porte une **pastille** sous son quantième, et son nom
 * accessible le nombre de créneaux ; une journée pleine n'en porte pas et
 * s'annonce « complet ». La forme et le mot portent donc l'information, que
 * l'atténuation ne fait qu'appuyer (WCAG 1.4.1).
 *
 * ## Une journée fermée porte son quantième **barré** (#742)
 *
 * Une journée fermée et une journée complète sont toutes deux atténuées et sans
 * pastille : rien ne les distinguait avant le clic, ce que le benchmark du
 * marché relève en propre — `BM-CRENEAU-04`, « un jour de fermeture est-il
 * distinguable autrement que par la seule couleur ? », où les cinq plateformes
 * observées grisent **ou barrent** les jours impossibles
 * ([parcours-client.md](../../../../docs/design/benchmark/parcours-client.md)).
 *
 * Le trait est porté par un `<s>` et non par une classe : `Button` n'accepte pas
 * de `className` — le design system garde la main sur l'allure d'un bouton —, et
 * le quantième vit **dans** le bouton. L'élément le barre de lui-même, sans
 * qu'aucune feuille n'ait à décrire un état de plus. Il est de surcroît
 * `aria-hidden` avec le quantième qu'il enveloppe : c'est le nom accessible qui
 * dit « fermé », le trait ne fait que le montrer.
 */
function CalendarDay({
  date,
  state,
  label,
  selected,
  selectable,
  tabbable,
  onChoose,
}: CalendarDayProps) {
  return (
    <span
      role="gridcell"
      aria-selected={selected}
      className="spa-calendar__cell"
      // La cible du rattrapage de focus. Porté par la cellule et non par le
      // bouton : `Button` ne déclare pas d'attribut `data-*`, et le design
      // system garde la main sur ce qu'un bouton porte.
      data-day={date}
    >
      <Button
        variant="neutral"
        aria-label={label}
        aria-disabled={selectable ? undefined : true}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => {
          // `onClick` couvre le clic **et** `Entrée`/`Espace` sur un `<button>`
          // natif : c'est exactement ce qu'on appelle une activation.
          onChoose(date, true);
        }}
      >
        <span aria-hidden="true" className="spa-calendar__day">
          {state === 'ferme' ? <s>{dayOfMonth(date)}</s> : dayOfMonth(date)}
        </span>
        {state === 'libre' ? <span aria-hidden="true" className="spa-calendar__mark" /> : null}
      </Button>
    </span>
  );
}
