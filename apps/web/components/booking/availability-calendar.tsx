'use client';

import type { CalendarDate } from '@spa/shared';
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
  WEEKDAY_INITIALS,
  WEEKDAY_NAMES,
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
import { formatCalendarDate } from '@/lib/format';

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
  /** La journée retenue, quand elle tombe dans le mois affiché. */
  readonly selectedDate: CalendarDate | null;
  /** Une action est en vol : plus rien ne se retient tant qu'elle n'a pas rendu. */
  readonly busy?: boolean;
  /** Le conteneur de la grille, quand l'appelant doit y poser le focus. */
  readonly calendarRef?: RefObject<HTMLDivElement | null> | undefined;
  readonly onMonthChange: (month: CalendarMonth) => void;
  readonly onSelect: (date: CalendarDate) => void;
}

/** « 3 créneaux », « 1 créneau » — le pluriel se voit à l'écran. */
function slotCountLabel(count: number): string {
  return count === 1 ? '1 créneau' : `${String(count)} créneaux`;
}

/** Ce qu'une case dit d'elle-même, au-delà de sa date. */
type DayState = 'chargement' | 'ferme' | 'complet' | 'libre';

/** Ce que le nom accessible d'une case ajoute à sa date, hors journée libre. */
const DAY_STATE_LABEL: Record<Exclude<DayState, 'libre'>, string> = {
  chargement: 'disponibilités en cours de chargement',
  ferme: 'hors de la période de réservation',
  complet: 'complet',
};

export function AvailabilityCalendar({
  month,
  bounds,
  slotCounts,
  selectedDate,
  busy = false,
  calendarRef,
  onMonthChange,
  onSelect,
}: AvailabilityCalendarProps) {
  const weeks = useMemo(() => monthWeeks(month), [month]);

  /**
   * L'état d'une case.
   *
   * Hors fenêtre prime sur tout le reste : une date de novembre n'est pas
   * « complète », elle n'est pas encore ouverte à la réservation, et les deux ne
   * se disent pas pareil.
   */
  const stateOf = useCallback(
    (date: CalendarDate): DayState => {
      if (!isWithinWindow(date, bounds)) {
        return 'ferme';
      }

      // Une date hors du mois affiché n'est dans aucune table de comptes : la
      // fenêtre chargée est celle du mois visible, et « le serveur n'a rien dit »
      // n'est pas « complet ». Seules les flèches y mènent — elles traversent les
      // mois —, et la traiter comme pleine ferait franchir le 30 septembre au
      // focus sans que le 1er octobre se retienne.
      if (slotCounts === null || monthOf(date) !== month) {
        return 'chargement';
      }

      return (slotCounts.get(date) ?? 0) > 0 ? 'libre' : 'complet';
    },
    [bounds, month, slotCounts],
  );

  /** Une case se retient quand elle a — ou peut encore avoir — quelque chose à montrer. */
  const canSelect = useCallback(
    (date: CalendarDate): boolean => {
      const state = stateOf(date);

      return !busy && (state === 'libre' || state === 'chargement');
    },
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
    (date: CalendarDate) => {
      setActiveDate(date);

      if (canSelect(date)) {
        onSelect(date);
      }
    },
    [canSelect, onSelect],
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

      pendingFocus.current = target;
      choose(target);

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
  const monthLabel = formatMonth(month);

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
          <span className="spa-visually-hidden">Mois précédent</span>
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
          <span className="spa-visually-hidden">Mois suivant</span>
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
        aria-label={`Journée — ${monthLabel}`}
        onKeyDown={moveFocus}
      >
        <div role="row" className="spa-calendar__row spa-calendar__row--head">
          {WEEKDAY_INITIALS.map((initial, column) => (
            <span
              // Deux colonnes portent « M » et deux « S » : le nom complet fait
              // la clé, l'initiale ne suffirait pas à les distinguer.
              key={WEEKDAY_NAMES[column]}
              role="columnheader"
              className="spa-calendar__weekday"
              aria-label={WEEKDAY_NAMES[column]}
            >
              <span aria-hidden="true">{initial}</span>
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
                  slotCount={slotCounts?.get(date) ?? null}
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
  /** Le nombre de créneaux, quand le serveur l'a dit — il fait le nom accessible. */
  readonly slotCount: number | null;
  readonly selected: boolean;
  readonly selectable: boolean;
  readonly tabbable: boolean;
  readonly onChoose: (date: CalendarDate) => void;
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
 */
function CalendarDay({
  date,
  state,
  slotCount,
  selected,
  selectable,
  tabbable,
  onChoose,
}: CalendarDayProps) {
  // `slotCount` ne peut pas manquer sur une journée libre — l'état en dérive —,
  // mais le compilateur ne le sait pas depuis deux propriétés indépendantes.
  const said = state === 'libre' ? slotCountLabel(slotCount ?? 0) : DAY_STATE_LABEL[state];

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
        aria-label={`${formatCalendarDate(date)} — ${said}`}
        aria-disabled={selectable ? undefined : true}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => {
          onChoose(date);
        }}
      >
        <span aria-hidden="true" className="spa-calendar__day">
          {dayOfMonth(date)}
        </span>
        {state === 'libre' ? <span aria-hidden="true" className="spa-calendar__mark" /> : null}
      </Button>
    </span>
  );
}
