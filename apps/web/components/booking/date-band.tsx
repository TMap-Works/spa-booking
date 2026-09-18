'use client';

import type { CalendarDate, OpeningHoursEntry } from '@spa/shared';
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
import { DateBlock } from '@/components/ui/date-block';
import { Icon } from '@/components/ui/icon';
import {
  BAND_DAYS,
  BAND_STEP,
  bandEntryDate,
  bandMoveForKey,
  bandStartShowing,
  moveInBand,
  type BandWindow,
} from '@/lib/booking/day-band';
import {
  dayStateOf,
  dayStateSaid,
  isSelectableState,
  type DayState,
  type DayStateContext,
} from '@/lib/booking/day-state';
import { addMonths, formatMonth, isNavigableMonth, type BookingWindow, type CalendarMonth } from '@/lib/booking/month-grid';
import { publishedOpenWeekdays } from '@/lib/booking/opening-days';
import { formatCalendarDate } from '@/lib/format';

/**
 * La bande de jours du sélecteur de créneau (#1049).
 *
 * ## Ce qu'elle change
 *
 * #827 avait posé un calendrier mensuel en tête de l'étape « créneau ». À 360 px,
 * cela met cinq à six lignes de cases entre le titre de la prestation et le
 * premier horaire : la grille des créneaux passe sous la ligne de flottaison, et
 * l'écran ne montre plus le choix qu'on est venu faire. C'est le constat de
 * l'audit `d20260918-1`, mesuré sur `/…/reservation?etape=creneau`.
 *
 * `BM-CRENEAU-01` (`docs/design/benchmark/parcours-client.md`) décrit ce que les
 * cinq plateformes observées font à cette étape : *« une rangée de jours
 * défilante (jour abrégé, numéro, mois) avec des flèches ; le calendrier du mois
 * complet s'ouvre à la demande ; sous la rangée, les seuls horaires du jour
 * sélectionné »*. Le calendrier ne disparaît donc pas — il devient le second
 * geste, celui qu'on fait pour aller loin, et le bouton de période l'ouvre.
 *
 * ## Elle ne repose aucune question au serveur
 *
 * Les journées qu'elle montre sont **calculées** depuis le mois affiché et les
 * bornes réservables ([`day-band.ts`](../../lib/booking/day-band.ts)), et non
 * déduites de la réponse. Deux conséquences voulues :
 *
 * - la bande reste opérable pendant le chargement, ce que `states.md` étape 3
 *   demande explicitement — *« en gardant la barre de dates interactive »* ;
 * - l'écran de report de l'espace client en hérite sans qu'une ligne ne change
 *   chez lui, puisqu'il charge déjà un mois. Le critère d'acceptation de l'issue
 *   interdit de toucher à l'API de disponibilité : il est tenu par construction.
 *
 * ## Le clavier
 *
 * `docs/design/appointments/keyboard-navigation.md`, « Barre de dates » : roving
 * tabindex, `←`/`→` au jour, `PagePréc`/`PageSuiv` à la semaine, et
 * `Début`/`Fin` aux bornes de la fenêtre visible, que le critère d'acceptation de
 * l'issue nomme. **Sans enroulement** — une flèche droite qui ramènerait de la
 * fin du mois au premier jour ferait réserver un mois plus tôt qu'on ne croit.
 *
 * Les flèches ne franchissent pas le mois chargé : ce sont les deux chevrons,
 * que le document place juste avant et juste après la bande dans l'ordre de
 * tabulation, qui portent ce geste-là — ils avancent d'une semaine, puis d'un
 * mois quand la plage s'arrête.
 */
interface DateBandProps {
  /**
   * La fenêtre visible, calculée par l'appelant.
   *
   * Elle ne l'est pas ici parce que le sélecteur de créneau en a besoin lui
   * aussi — c'est elle qui décide quelle journée la grille d'horaires détaille —
   * et que deux calculs de la même rangée finiraient par diverger.
   */
  readonly band: BandWindow;
  /** Le mois chargé, `YYYY-MM` — la plage que la bande peut montrer. */
  readonly month: CalendarMonth;
  /** Les bornes réservables ; au-delà, la journée est rendue mais inerte. */
  readonly bounds: BookingWindow;
  /** Le nombre de créneaux par date — `null` tant que la réponse n'est pas là. */
  readonly slotCounts: ReadonlyMap<CalendarDate, number> | null;
  /**
   * Les plages d'ouverture publiées par l'établissement.
   *
   * Elles ne servent qu'à **nommer** une journée déjà sans créneau : « fermé »
   * quand le salon n'ouvre pas ce jour-là, « complet » sinon (#742).
   */
  readonly openingHours?: readonly OpeningHoursEntry[] | undefined;
  /** La journée retenue, quand elle tombe dans le mois chargé. */
  readonly selectedDate: CalendarDate | null;
  /** Une action est en vol : plus rien ne se retient tant qu'elle n'a pas rendu. */
  readonly busy?: boolean;
  /** Le conteneur de la bande, quand l'appelant doit y poser le focus. */
  readonly bandRef?: RefObject<HTMLDivElement | null> | undefined;
  /**
   * La journée à poser en tête de bande — `null` remet la bande à son point de
   * départ naturel.
   *
   * Elle ne porte que le défilement **dans** le mois chargé. Franchir le mois
   * passe par `onMonthChange`, qui emporte les deux en un seul message.
   */
  readonly onFromChange: (from: CalendarDate | null) => void;
  /**
   * Changer de mois, en disant du même geste par quelle journée la bande entre
   * dans le mois d'arrivée — `null` pour son point de départ naturel.
   *
   * Les deux vont ensemble parce qu'ils se contredisaient autrement : le
   * sélecteur remet la tête de bande à zéro sur un changement de mois — c'est ce
   * qu'il faut quand la demande vient du calendrier —, et un `onFromChange` posé
   * juste avant se faisait donc écraser. Le chevron qui franchit le mois n'a
   * plus deux messages à ordonner, il en a un (#1084).
   */
  readonly onMonthChange: (month: CalendarMonth, from: CalendarDate | null) => void;
  readonly onSelect: (date: CalendarDate) => void;
  /** Ouvrir le mois complet — `BM-CRENEAU-01`, `BM-TUNNEL-12`. */
  readonly onOpenMonth: () => void;
}

export function DateBand({
  band,
  month,
  bounds,
  slotCounts,
  openingHours,
  selectedDate,
  busy = false,
  bandRef,
  onFromChange,
  onMonthChange,
  onSelect,
  onOpenMonth,
}: DateBandProps) {
  const { dates, start, visible } = band;
  const openWeekdays = useMemo(() => publishedOpenWeekdays(openingHours), [openingHours]);
  const context = useMemo<DayStateContext>(
    () => ({ month, bounds, slotCounts, openWeekdays }),
    [bounds, month, openWeekdays, slotCounts],
  );

  /**
   * La journée qui porte le `tabindex` — le roving tabindex du document de
   * conception.
   *
   * Une seule est dans l'ordre de tabulation : `Tab` entre dans la bande, les
   * flèches y circulent, `Tab` en ressort vers la grille de créneaux. Sans cela,
   * quatorze journées imposeraient quatorze tabulations pour atteindre le bloc
   * suivant.
   */
  const [activeDate, setActiveDate] = useState<CalendarDate | null>(null);
  const ownRef = useRef<HTMLDivElement | null>(null);
  const gridNode = bandRef ?? ownRef;
  /**
   * La date sur laquelle poser le focus au prochain rendu.
   *
   * Une flèche peut faire glisser la fenêtre visible, et la case visée n'existe
   * alors pas encore dans le document : c'est le rendu qui suit `onFromChange`
   * qui la crée. Appeler `focus()` dans le gestionnaire de touche ne trouverait
   * rien, et le focus retomberait sur `<body>` au milieu d'un geste délibéré.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un état
   * déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const pendingFocus = useRef<CalendarDate | null>(null);

  const stateOf = useCallback(
    (date: CalendarDate): DayState => dayStateOf(date, context),
    [context],
  );

  const canSelect = useCallback(
    (date: CalendarDate): boolean => !busy && isSelectableState(stateOf(date)),
    [busy, stateOf],
  );

  /**
   * La case réellement focalisable.
   *
   * On suit la journée retenue quand elle tombe dans la fenêtre visible — c'est
   * elle que la grille de créneaux détaille en dessous. Sinon on retombe sur la
   * première journée libre, puis sur la première tout court : une bande sans
   * aucun arrêt de tabulation serait inatteignable au clavier, ce qui est
   * exactement le défaut qu'on répare.
   */
  const tabbableDate =
    visible.find((date) => date === activeDate) ??
    visible.find((date) => date === selectedDate) ??
    visible.find((date) => stateOf(date) === 'libre') ??
    visible[0] ??
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

  /**
   * La journée retenue ramenée dans le champ de la rangée.
   *
   * La rangée défile : une journée peut appartenir à la fenêtre visible — donc
   * exister dans le document — et se trouver hors de l'écran. C'est le cas dès
   * qu'on choisit une date dans le calendrier, ou qu'à l'ouverture la première
   * journée libre est à plus de cinq blocs : la grille d'horaires détaillait
   * alors une journée que la bande ne montrait pas, et rien n'y paraissait
   * retenu.
   *
   * Le défilement est posé sur le conteneur plutôt que par `scrollIntoView` :
   * celui-ci remonte la chaîne des ancêtres et ferait sauter la page entière
   * sous la barre collante, là où l'on ne veut bouger qu'une rangée. Il ne joue
   * que si la case est réellement hors champ — sinon le moindre rendu
   * recadrerait la bande sous les doigts de qui vient de la faire glisser.
   */
  useEffect(() => {
    const grid = gridNode.current;

    if (grid === null || selectedDate === null) {
      return;
    }

    const cell = grid.querySelector<HTMLElement>(`[data-day="${selectedDate}"]`);

    if (cell === null) {
      return;
    }

    const cellBox = cell.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    // De quoi laisser voir qu'une journée suit, plutôt que de coller la case
    // contre l'arête.
    const margin = cellBox.width / 2;

    if (cellBox.left < gridBox.left) {
      grid.scrollLeft -= gridBox.left - cellBox.left + margin;
    } else if (cellBox.right > gridBox.right) {
      grid.scrollLeft += cellBox.right - gridBox.right + margin;
    }
  }, [gridNode, selectedDate]);

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

  const moveFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const move = bandMoveForKey(event.key);

      if (move === null || tabbableDate === null) {
        return;
      }

      // La touche est consommée dès qu'elle nous regarde, même quand la date ne
      // bouge pas : en bord de plage, laisser passer `→` ferait défiler la page
      // sous un focus resté sur place, ce qui se lit comme une commande qui a
      // fonctionné.
      event.preventDefault();

      const index = dates.indexOf(tabbableDate);
      const target = moveInBand(dates.length, start, index, move);
      const date = dates[target];

      if (date === undefined) {
        return;
      }

      // Le rattrapage n'est armé que lorsque la case visée **change**. En bord de
      // plage la touche ne mène nulle part : la journée retenue et la case active
      // sont déjà celles-là, aucun état ne bouge, donc aucun rendu ne vient
      // consommer la cible — elle resterait armée, et le premier rendu venu (un
      // créneau choisi, une revalidation) ramènerait le focus dans la bande alors
      // qu'on l'a depuis emmené dans la grille d'horaires.
      if (date !== tabbableDate) {
        pendingFocus.current = date;
      }

      choose(date);

      const shifted = bandStartShowing(dates.length, start, target);

      if (shifted !== start) {
        onFromChange(dates[shifted] ?? null);
      }
    },
    [choose, dates, onFromChange, start, tabbableDate],
  );

  /** Reste-t-il des journées chargées avant la fenêtre visible, ou un mois derrière ? */
  const previousMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const canGoBack = start > 0 || isNavigableMonth(previousMonth, bounds);
  const canGoForward = start + BAND_DAYS < dates.length || isNavigableMonth(nextMonth, bounds);

  /**
   * Un chevron de la bande, et ce qu'il fait.
   *
   * Il avance d'une semaine tant que le mois chargé en a, puis passe au mois
   * voisin — sur la fenêtre qui **touche** celle qu'on quitte, `bandEntryDate` :
   * la dernière du mois précédent en reculant, la première du suivant en
   * avançant. Sans quoi les deux chevrons cesseraient d'être inverses l'un de
   * l'autre et `‹` sauterait la fin du mois d'arrivée (#1084).
   *
   * Le focus **ne suit pas** : il reste sur le chevron, pour qu'on puisse
   * balayer trois semaines en trois clics sans avoir à viser de nouveau.
   */
  const step = (delta: -1 | 1): void => {
    const shifted = start + delta * BAND_STEP;

    if (delta < 0 ? start > 0 : start + BAND_DAYS < dates.length) {
      const bounded = Math.max(0, Math.min(shifted, Math.max(0, dates.length - BAND_DAYS)));

      onFromChange(dates[bounded] ?? null);
      return;
    }

    const target = delta < 0 ? previousMonth : nextMonth;

    if (!isNavigableMonth(target, bounds)) {
      return;
    }

    onMonthChange(target, bandEntryDate(target, bounds, delta));
  };

  const monthLabel = formatMonth(month);

  return (
    <div className="spa-date-band">
      {/*
        « ‹ septembre 2026 › » — la même grammaire que la navigation de période du
        calendrier, à ceci près que les chevrons portent ici la semaine et que le
        libellé de période est devenu le **bouton** qui ouvre le mois complet
        (`BM-CRENEAU-01`, `BM-TUNNEL-12`).

        Le chevron est `aria-hidden` — un signe typographique ne se lit pas —, et
        c'est le libellé masqué qui nomme le contrôle. `aria-disabled` et non
        `disabled` : un contrôle éteint reste atteignable au clavier, comme les
        journées complètes et les créneaux inertes. Trois contrôles inactifs, une
        seule façon de le dire.
      */}
      <div className="spa-date-band__nav">
        <Button
          variant="neutral"
          aria-disabled={canGoBack ? undefined : true}
          onClick={() => {
            step(-1);
          }}
        >
          <span aria-hidden="true">‹</span>
          <span className="spa-visually-hidden">Jours précédents</span>
        </Button>

        <Button
          variant="quiet"
          aria-haspopup="dialog"
          aria-label={`Ouvrir le calendrier — ${monthLabel}`}
          onClick={onOpenMonth}
        >
          <Icon name="calendar" />
          <span aria-hidden="true">{monthLabel}</span>
        </Button>

        <Button
          variant="neutral"
          aria-disabled={canGoForward ? undefined : true}
          onClick={() => {
            step(1);
          }}
        >
          <span aria-hidden="true">›</span>
          <span className="spa-visually-hidden">Jours suivants</span>
        </Button>
      </div>

      {/*
        Grille composite d'une seule ligne, comme la grille de créneaux :
        `grid` › `row` › `gridcell` › `<button>` natif. Une ligne et non une liste
        de boutons : c'est ce qui donne le roving tabindex et les flèches sans
        qu'aucun attribut n'ait à être inventé.

        Le défilement horizontal est celui du doigt (`calendar.css`) : quatorze
        blocs ne tiennent pas à 360 px, et `BM-CRENEAU-01` décrit précisément une
        rangée qu'on balaye.
      */}
      <div
        ref={gridNode}
        className="spa-date-band__grid"
        role="grid"
        aria-label={`Jour du rendez-vous — ${monthLabel}`}
        onKeyDown={moveFocus}
      >
        <div role="row" className="spa-date-band__row">
          {visible.map((date) => (
            <BandDay
              key={date}
              date={date}
              state={stateOf(date)}
              slotCount={slotCounts?.get(date) ?? null}
              selected={date === selectedDate}
              selectable={canSelect(date)}
              tabbable={date === tabbableDate}
              onChoose={choose}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface BandDayProps {
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
 * Une journée de la bande.
 *
 * ## `aria-disabled` et non `disabled`
 *
 * Une journée inerte reste **atteignable au clavier**, comme les cases du
 * calendrier et les créneaux de la grille : la désactiver pour de bon ferait un
 * trou dans la bande — les flèches y appellent `focus()`, qu'un bouton désactivé
 * ignore, et la journée suivante deviendrait inatteignable. Elle est surtout ce
 * qu'on vient lire : savoir que le 24 est complet vaut mieux que de ne pas
 * pouvoir s'y poser.
 *
 * ## La disponibilité ne se dit pas par la seule couleur
 *
 * Une journée libre porte une **pastille** sous sa date, et son nom accessible le
 * nombre de créneaux ; une journée sans place n'en porte pas et s'annonce
 * « complet », « fermé » ou « hors de la période de réservation ». Une journée
 * fermée porte en outre sa date **barrée**, comme dans le calendrier depuis #742
 * — `BM-CRENEAU-04`, où les cinq plateformes observées grisent ou barrent les
 * jours impossibles. La forme et le mot portent donc l'information, que
 * l'atténuation ne fait qu'appuyer (WCAG 1.4.1).
 *
 * L'état est porté par un `data-*` de la **cellule** et non par une classe du
 * bouton : `Button` n'accepte pas de `className` — le design system garde la main
 * sur l'allure d'un bouton — et c'est le même détour que `data-day`.
 */
function BandDay({
  date,
  state,
  slotCount,
  selected,
  selectable,
  tabbable,
  onChoose,
}: BandDayProps) {
  return (
    <span
      role="gridcell"
      aria-selected={selected}
      className="spa-date-band__cell"
      data-day={date}
      data-state={state}
    >
      <Button
        variant="neutral"
        aria-label={`${formatCalendarDate(date)} — ${dayStateSaid(state, slotCount)}`}
        aria-disabled={selectable ? undefined : true}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => {
          onChoose(date);
        }}
      >
        <DateBlock date={date} />
        {state === 'libre' ? <span aria-hidden="true" className="spa-date-band__mark" /> : null}
      </Button>
    </span>
  );
}
