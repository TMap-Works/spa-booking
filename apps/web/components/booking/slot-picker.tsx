'use client';

import type {
  AvailabilitySlot,
  CalendarDate,
  DayAvailability,
  TimeZone,
  UtcInstant,
} from '@spa/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { formatCalendarDayShort } from '@/lib/booking/calendar';
import {
  canSelectDay,
  dateBarDays,
  dateBarMoveForKey,
  gridMoveForKey,
  moveInDateBar,
  moveInGrid,
  openDays as openDaysOf,
  resolveActiveDay,
  selectableDays,
  slotRows,
} from '@/lib/booking/slots';
import { formatCalendarDate, formatTimeInTimeZone, timeZoneMention } from '@/lib/format';

/**
 * Le sélecteur de créneau — une bande de journées, puis la grille d'**une seule**
 * journée.
 *
 * ## Pourquoi il vit ici et non dans le tunnel (#622)
 *
 * Il a été écrit pour l'étape 3 du tunnel de réservation, et le report d'un
 * rendez-vous en avait écrit un second, plus naïf : les onze journées dépliées
 * d'un coup, toutes leurs heures visibles. Mesuré à 360 px, cet écran-là faisait
 * 4 960 px de haut — six hauteurs d'écran — contre 1 230 px pour celui du
 * tunnel, et son bouton de validation restait deux mille pixels sous le créneau
 * qu'on venait de choisir.
 *
 * Deux composants pour le même geste, c'est deux comportements clavier, deux
 * façons d'annoncer un changement de journée, et une seule des deux qui reçoit
 * les corrections. Le sélecteur est donc **le même objet** pour les deux écrans,
 * et ce qui les distingue passe par des props :
 *
 * - le tunnel choisit un créneau et avance — `selectedSlot` reste indéfini, rien
 *   ne porte `aria-pressed` ;
 * - le report retient un créneau sous les yeux de la visiteuse avant de
 *   confirmer, et doit rendre l'heure **actuelle** du rendez-vous visible mais
 *   inerte (`lockedSlotNote`).
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne charge rien. Les journées lui sont données — par une action serveur dans
 * le tunnel, par le rendu serveur de la page dans le report —, et c'est
 * l'appelant qui décide de les rafraîchir, d'élargir la fenêtre ou de rendre une
 * panne. Le sélecteur ne fait que **montrer** ce qu'on lui donne et dire ce qui a
 * été touché.
 *
 * ## Les documents de conception font foi
 *
 * [keyboard-navigation.md](../../../../docs/design/appointments/keyboard-navigation.md)
 * fixe le comportement clavier : `grid` › `row` › `gridcell` › `<button>`,
 * *roving tabindex*, flèches et `Début`/`Fin` (avec `Ctrl` pour les bornes de la
 * grille), **sans enroulement** aux bords, région `aria-live` pour le nombre de
 * créneaux, focus déplacé quand un créneau disparaît sous lui. La barre de dates
 * reprend le même roving tabindex sur une ligne, avec `PagePréc`/`PageSuiv` à la
 * semaine.
 *
 * [states.md](../../../../docs/design/appointments/states.md) fixe l'état de
 * chargement : squelette de grille **sous une barre de dates restée opérable**.
 */
interface SlotPickerProps {
  /**
   * Les journées à montrer, telles que l'API les rend.
   *
   * `null` veut dire « on ne sait pas encore » et non « il n'y a rien » : le
   * sélecteur rend alors le squelette de `states.md`, sous une barre de dates
   * posée sur `windowDates`.
   */
  readonly days: readonly DayAvailability[] | null;
  /**
   * Les dates civiles de la fenêtre demandée, pour que la barre soit à l'écran
   * **avant** la réponse. Sans objet quand `days` est toujours fourni.
   */
  readonly windowDates?: readonly CalendarDate[];
  /** Le fuseau de l'établissement : les heures s'affichent dans celui-là. */
  readonly timeZone: TimeZone;
  /**
   * Ce qui s'affiche quand aucune journée n'a de créneau.
   *
   * Il est rendu par l'appelant parce que la sortie de cet écran lui appartient :
   * le tunnel offre d'élargir la fenêtre ou de lever la préférence de praticien,
   * le report renvoie vers le salon.
   */
  readonly emptyState: ReactNode;
  /**
   * Le créneau retenu, quand l'écran en retient un avant de confirmer.
   *
   * `undefined` — le cas du tunnel, où le clic avance aussitôt — n'est pas
   * `null` : il n'y a alors aucun état à porter, et aucun bouton ne reçoit
   * `aria-pressed`. Annoncer « non pressé » sur trente créneaux ferait chercher
   * un état qui n'existe pas.
   */
  readonly selectedSlot?: UtcInstant | null;
  /**
   * Le mot qui dit pourquoi un créneau est rendu sans pouvoir être choisi —
   * « actuel » pour l'heure du rendez-vous qu'on déplace. `null` : il se choisit.
   *
   * Un prédicat et non une liste d'instants : le report compare des **instants**
   * et non des chaînes, rien ne garantissant que le calendrier et l'historique
   * écrivent le même moment avec la même précision.
   */
  readonly lockedSlotNote?: (startsAt: UtcInstant) => string | null;
  /** Une action est en vol : plus rien ne se choisit tant qu'elle n'a pas rendu. */
  readonly busy?: boolean;
  /** L'identifiant du titre de la grille — unique dans la page qui l'emploie. */
  readonly headingId?: string;
  /** Le conteneur de la barre de dates, quand l'appelant doit y poser le focus. */
  readonly dateBarRef?: RefObject<HTMLDivElement | null>;
  /** Le conteneur de l'état vide, pour la même raison. */
  readonly emptyStateRef?: RefObject<HTMLDivElement | null>;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/**
 * La fenêtre vide par défaut.
 *
 * Une constante de module et non un `[]` littéral dans la signature : ce dernier
 * rend un tableau neuf à chaque rendu, ce qui suffit à invalider la mémoïsation
 * de la barre de dates — et, avec elle, celle du gestionnaire de touches qui en
 * dépend — chez tout appelant qui ne passe pas la prop, c'est-à-dire le report.
 */
const NO_WINDOW_DATES: readonly CalendarDate[] = [];

/** « 3 créneaux », « 1 créneau » — le pluriel se voit à l'écran. */
function slotCountLabel(count: number): string {
  return count === 1 ? '1 créneau' : `${String(count)} créneaux`;
}

/**
 * L'heure telle qu'elle **s'énonce** — « 14 h 00 » quand la grille affiche
 * « 14:00 » (`keyboard-navigation.md`, « États et attributs par créneau »).
 *
 * Les deux formes ne disent pas la même chose parce qu'elles ne sont pas lues
 * dans le même contexte. Dans sa colonne, sous l'en-tête « Après-midi », « 14:00 »
 * se comprend d'un coup d'œil et tient sur un téléphone. Énoncé seul par un
 * lecteur d'écran, il s'entend « un quatre deux points zéro zéro » — ou passe
 * pour un score. L'heure en toutes lettres, elle, se suffit.
 *
 * Elle est **composée ici**, chiffre à chiffre, plutôt que demandée à une locale
 * qui la rend déjà : `fr-CA` écrit « 14 h 00 » avec une espace fine insécable
 * dont la présence et la forme dépendent de la version d'ICU du moteur, si bien
 * que le libellé différerait entre la CI et le poste — et avec lui les requêtes
 * par nom accessible qui éprouvent tout le tunnel.
 *
 * La dériver du texte affiché plutôt que d'un second formateur garantit en outre
 * que les deux formes ne peuvent pas diverger : mêmes chiffres, même fuseau,
 * seul le séparateur change.
 */
function spokenTime(shortTime: string): string {
  return shortTime.replace(':', ' h ');
}

export function SlotPicker({
  days,
  windowDates = NO_WINDOW_DATES,
  timeZone,
  emptyState,
  selectedSlot,
  lockedSlotNote,
  busy = false,
  headingId = 'creneaux-titre',
  dateBarRef,
  emptyStateRef,
  onChoose,
}: SlotPickerProps) {
  /** La journée que la barre de dates montre comme retenue. */
  const [selectedDate, setSelectedDate] = useState<CalendarDate | null>(null);
  /**
   * Le créneau qui porte le `tabindex` de la grille — le *roving tabindex* de
   * `keyboard-navigation.md`.
   *
   * Un seul créneau est dans l'ordre de tabulation : `Tab` entre dans la grille,
   * les flèches y circulent, `Tab` en ressort vers le bloc suivant. Sans cela,
   * une journée de trente créneaux imposerait trente tabulations pour atteindre
   * le bouton d'après — c'est exactement l'écueil que le document décrit.
   *
   * Il est retenu par son instant et non par son rang : entre deux
   * revalidations, le rang d'un créneau change dès qu'un créneau plus tôt
   * disparaît, et le `tabindex` sauterait tout seul sur un autre horaire.
   */
  const [activeSlot, setActiveSlot] = useState<UtcInstant | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  /**
   * Le conteneur de la barre de dates.
   *
   * La barre est parcourue aux flèches, ce qui demande de relire ses boutons
   * dans le DOM : le sélecteur en tient donc toujours un `ref`. Quand l'appelant
   * en veut un aussi — pour y rattraper un focus —, c'est le sien qui sert, ce
   * qui évite d'avoir à fusionner deux `ref` sur un même nœud.
   */
  const ownDateBarRef = useRef<HTMLDivElement | null>(null);
  const dateBarNode = dateBarRef ?? ownDateBarRef;
  /**
   * `true` tant que le focus est **dans** la grille.
   *
   * Suivi par un drapeau et non relu sur `document.activeElement` au moment où
   * l'on en aurait besoin : quand un créneau disparaît d'une revalidation, React
   * a déjà retiré son bouton du document, et le focus est retombé sur `<body>`
   * avant que le moindre effet ne s'exécute. Lire l'état d'après ne dirait donc
   * jamais que la grille tenait le focus juste avant.
   */
  const gridHasFocus = useRef(false);

  const allDays = useMemo(() => selectableDays(days ?? []), [days]);
  const open = useMemo(() => openDaysOf(allDays), [allDays]);
  const activeDay = resolveActiveDay(open, selectedDate);
  /**
   * Les journées de la barre de dates : la fenêtre civile tant que la réponse
   * n'est pas là, la réponse elle-même ensuite.
   */
  const bar = useMemo(
    () => dateBarDays(windowDates, days === null ? null : allDays),
    [windowDates, days, allDays],
  );
  /**
   * La journée que la barre montre comme retenue — même en cours de chargement.
   *
   * Le repli sur la première journée n'est pas décoratif : c'est elle qui porte
   * le `tabindex` de la barre, et une barre où aucune pastille ne serait retenue
   * n'aurait plus aucun arrêt de tabulation. La journée choisie peut sortir de
   * la fenêtre — à minuit passé, « aujourd'hui » n'est plus le même jour et la
   * fenêtre a glissé —, d'où la vérification plutôt qu'un simple `??`.
   */
  const barActiveDate =
    activeDay?.date ??
    (bar.some((day) => day.date === selectedDate) ? selectedDate : null) ??
    bar[0]?.date ??
    null;

  /**
   * La mention du fuseau, calculée **après le montage** seulement.
   *
   * Elle lit le fuseau du navigateur, qui n'existe pas au rendu serveur : là-bas
   * `Intl` rend celui du conteneur, c'est-à-dire UTC. Le tunnel n'a rien à
   * afficher avant sa première réponse et n'y voyait donc que du feu ; le report,
   * lui, reçoit ses journées du rendu serveur, et le titre « Créneaux du 1er
   * septembre — heure de Europe/Paris » rendu par le serveur ne s'accorderait pas
   * avec celui qu'un navigateur parisien écrit (sans mention du tout) — React
   * signale la divergence et réécrit le nœud. D'où le drapeau plutôt que la
   * présence des journées, qui ne disait « après le montage » que par accident.
   *
   * C'est le même garde-fou que `booking-tunnel.tsx` pose sur cette fonction.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const zoneMention = mounted ? timeZoneMention(timeZone) : null;
  const dayHeading =
    activeDay === null
      ? ''
      : `Créneaux du ${formatCalendarDate(activeDay.date)}${
          zoneMention === null ? '' : ` — ${zoneMention}`
        }`;

  /** La journée affichée, découpée en lignes de grille — matin, après-midi, soir. */
  const rows = useMemo(
    () => (activeDay === null ? [] : slotRows(activeDay.slots, timeZone)),
    [activeDay, timeZone],
  );
  const slotsShown = useMemo(() => rows.flatMap((row) => row.slots), [rows]);

  /**
   * Le créneau qui porte réellement le `tabindex`.
   *
   * Le créneau retenu peut avoir disparu du dernier rechargement : on retombe
   * alors sur le premier de la journée, faute de quoi la grille n'aurait plus
   * aucun arrêt de tabulation et deviendrait inatteignable au clavier.
   */
  const tabbableSlot =
    slotsShown.find((slot) => slot.startsAt === activeSlot)?.startsAt ??
    slotsShown[0]?.startsAt ??
    null;

  /**
   * Le focus suit le créneau qu'une revalidation vient d'emporter.
   *
   * C'est la dernière ligne de la liste de vérification du document de
   * conception, et le piège propre à une liste qui se rafraîchit toute seule :
   * le bouton focalisé disparaît du DOM, le focus retombe sur `<body>`, et la
   * navigation au clavier repart du haut du document au moment précis où l'on
   * choisissait son heure. Le déplacement n'a lieu que si la grille tenait
   * effectivement le focus — sinon ce serait un vol de focus.
   *
   * Sans tableau de dépendances explicite au-delà de ce qu'il lit : l'effet
   * n'agit que sur la disparition du créneau actif.
   */
  useEffect(() => {
    const grid = gridRef.current;

    if (grid === null || !gridHasFocus.current || activeSlot === null) {
      return;
    }

    if (slotsShown.some((shown) => shown.startsAt === activeSlot)) {
      return;
    }

    grid.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [slotsShown, activeSlot]);

  /**
   * Les flèches circulent dans la grille — `keyboard-navigation.md`, « Touches
   * dans la grille de créneaux ».
   *
   * Les boutons sont relus dans le DOM à chaque frappe plutôt que suivis par des
   * `ref` : la grille se réécrit à chaque revalidation, et une collection de
   * `ref` y survivrait mal.
   */
  const moveFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const move = gridMoveForKey(event.key, event.ctrlKey || event.metaKey);
    const grid = gridRef.current;

    if (move === null || grid === null) {
      return;
    }

    const cells = [...grid.querySelectorAll<HTMLDivElement>('[role="row"]')].map((row) => [
      ...row.querySelectorAll<HTMLButtonElement>('button'),
    ]);
    const row = cells.findIndex((buttons) =>
      buttons.some((button) => button === document.activeElement),
    );

    if (row === -1) {
      return;
    }

    const column = cells[row]?.indexOf(document.activeElement as HTMLButtonElement) ?? -1;
    const target = moveInGrid(
      cells.map((buttons) => buttons.length),
      { row, column },
      move,
    );

    // Le défilement de la page par les flèches est écarté seulement quand le
    // focus est bien dans la grille : ailleurs, la touche est au navigateur.
    event.preventDefault();
    cells[target.row]?.[target.column]?.focus();
  }, []);

  /**
   * Les flèches circulent dans la barre de dates — `keyboard-navigation.md`,
   * « Barre de dates ».
   *
   * **Activation automatique** : la flèche déplace le focus *et* retient la
   * journée, comme dans tout `radiogroup`. Le document décrit `Entrée`/`Espace`
   * comme le geste de sélection, et ils le restent — mais un groupe de boutons
   * radio où la flèche ne sélectionnerait pas serait un groupe où un lecteur
   * d'écran annonce « non coché » sur quatorze journées d'affilée.
   *
   * Le focus **reste dans la barre** plutôt que de partir sur le premier créneau
   * du nouveau jour, comme le suggère la prose du document : le déplacer
   * interdirait d'enchaîner deux flèches pour comparer deux journées, qui est
   * précisément ce à quoi une barre de dates sert.
   */
  const moveDay = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const move = dateBarMoveForKey(event.key);
      const dateBar = dateBarNode.current;

      if (move === null || dateBar === null) {
        return;
      }

      const buttons = [...dateBar.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.findIndex((button) => button === document.activeElement);

      if (index === -1) {
        return;
      }

      const target = moveInDateBar(bar, index, move);
      const day = bar[target];

      // `PagePréc` et `PageSuiv` défileraient la page ; les flèches la
      // déplaceraient latéralement. Seulement quand le focus est dans la barre.
      event.preventDefault();

      if (day === undefined) {
        return;
      }

      buttons[target]?.focus();

      // En bord de barre — ou quand plus rien n'est ouvert dans la direction
      // demandée —, `moveInDateBar` rend le rang de départ. Celui-ci peut être
      // une journée complète : la souris peut poser le focus dessus, là où les
      // flèches ne s'y arrêtent jamais. La retenir mettrait `selectedDate` sur
      // une date que `resolveActiveDay` ne retrouvera jamais, et la pastille
      // cochée s'en irait ailleurs que là où le focus est.
      if (canSelectDay(day)) {
        setSelectedDate(day.date);
      }
    },
    [bar, dateBarNode],
  );

  /**
   * La barre de dates — `keyboard-navigation.md`, « Barre de dates ».
   *
   * Un `radiogroup` et non un `<select>` natif : le document décrit une ligne de
   * journées parcourue aux flèches, et un `<select>` ne montre qu'une journée à
   * la fois — comparer mardi et jeudi demanderait d'ouvrir deux fois la liste.
   *
   * Les journées complètes restent rendues, inertes. Le serveur les renvoie avec
   * `slots: []` plutôt que de les omettre précisément pour qu'un calendrier
   * puisse afficher « complet » sans deviner les trous : les retirer ferait
   * croire à un salon fermé ce jour-là.
   */
  const dateBar =
    bar.length === 0 ? null : (
      <div
        ref={dateBarNode}
        className="spa-date-bar"
        role="radiogroup"
        aria-label="Journée"
        onKeyDown={moveDay}
      >
        {bar.map((day) => {
          const selectable = canSelectDay(day);
          const checked = day.date === barActiveDate;
          const state =
            day.slotCount === null
              ? 'disponibilités en cours de chargement'
              : day.slotCount === 0
                ? 'complet'
                : slotCountLabel(day.slotCount);

          return (
            <Button
              key={day.date}
              variant="neutral"
              role="radio"
              aria-checked={checked}
              aria-disabled={selectable ? undefined : true}
              aria-label={`${formatCalendarDate(day.date)} — ${state}`}
              tabIndex={checked ? 0 : -1}
              onClick={() => {
                // Une journée complète reste affichée et lisible, mais ne se
                // retient pas : il n'y aurait rien à montrer dessous.
                if (selectable) {
                  setSelectedDate(day.date);
                }
              }}
            >
              <span aria-hidden="true" className="spa-date-bar__day">
                {formatCalendarDayShort(day.date)}
              </span>
              <span aria-hidden="true" className="spa-date-bar__count">
                {day.slotCount === null ? '…' : day.slotCount === 0 ? 'complet' : day.slotCount}
              </span>
            </Button>
          );
        })}
      </div>
    );

  return (
    <>
      {/*
        Ce que le changement de liste annonce à qui ne la voit pas. Le texte est
        dérivé de la journée affichée : il ne bouge donc qu'au changement de
        journée ou de nombre de créneaux, et une revalidation qui ne change rien
        reste silencieuse.
      */}
      <p role="status" className="spa-visually-hidden">
        {activeDay === null
          ? ''
          : `${slotCountLabel(activeDay.slots.length)} le ${formatCalendarDate(activeDay.date)}${
              zoneMention === null ? '' : `, ${zoneMention}`
            }.`}
      </p>

      {days === null ? (
        // `states.md` étape 3 : « grille de créneaux en squelette, **en gardant
        // la barre de dates interactive** pour changer de jour sans attendre ».
        // La fenêtre est une suite de dates civiles, que le navigateur sait
        // poser sans le serveur ; seuls les comptes de créneaux l'attendent.
        <>
          {dateBar}
          <div className="spa-card spa-card--loading" aria-busy="true">
            <span className="spa-visually-hidden">Chargement des disponibilités…</span>
            <span className="spa-skeleton spa-field__skeleton" />
            <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
            <span className="spa-skeleton spa-card__skeleton-line" />
            <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
          </div>
        </>
      ) : open.length === 0 ? (
        <div className="spa-card spa-card--empty" role="status" ref={emptyStateRef} tabIndex={-1}>
          {emptyState}
        </div>
      ) : (
        <>
          {dateBar}

          <h3 className="spa-card__meta" id={headingId}>
            {dayHeading}
          </h3>

          {/*
            Grille composite, telle que `keyboard-navigation.md` la décrit :
            `grid` › `row` (un moment de la journée) › `gridcell` › `<button>`
            natif. Le libellé du moment est un `rowheader`, ce qui le rend
            visible **et** l'annonce comme l'en-tête de sa ligne — un titre posé
            à côté de la grille ne dirait pas à quels créneaux il se rapporte.
          */}
          <div
            ref={gridRef}
            className="spa-slot-grid"
            role="grid"
            aria-labelledby={headingId}
            onKeyDown={moveFocus}
            onBlur={(event) => {
              // Le focus quitte la grille pour de bon — le prochain
              // rafraîchissement n'a plus à le rattraper. Un bouton **déjà
              // détaché** ne dit pas cela : c'est la disparition d'un créneau,
              // pas un départ, et c'est précisément le cas à rattraper.
              if (event.target.isConnected) {
                gridHasFocus.current = event.currentTarget.contains(event.relatedTarget);
              }
            }}
          >
            {rows.map((row) => (
              <div role="row" className="spa-slot-grid__row" key={row.label}>
                <span role="rowheader" className="spa-slot-grid__rowheader spa-card__meta">
                  {row.label}
                </span>
                {row.slots.map((slot) => (
                  <SlotCell
                    key={slot.startsAt}
                    slot={slot}
                    timeZone={timeZone}
                    note={lockedSlotNote?.(slot.startsAt) ?? null}
                    busy={busy}
                    pressed={selectedSlot === undefined ? undefined : slot.startsAt === selectedSlot}
                    tabbable={slot.startsAt === tabbableSlot}
                    onFocus={() => {
                      gridHasFocus.current = true;
                      setActiveSlot(slot.startsAt);
                    }}
                    onChoose={onChoose}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

interface SlotCellProps {
  readonly slot: AvailabilitySlot;
  readonly timeZone: TimeZone;
  /** Non `null` : le créneau est rendu, et ce mot dit pourquoi il ne se choisit pas. */
  readonly note: string | null;
  readonly busy: boolean;
  readonly pressed: boolean | undefined;
  readonly tabbable: boolean;
  readonly onFocus: () => void;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/**
 * Un créneau de la grille.
 *
 * ## `aria-disabled` et non `disabled`
 *
 * Un créneau inerte reste **atteignable au clavier**. Le désactiver pour de bon
 * en ferait un trou dans la grille : les flèches calculent une position, y
 * appellent `focus()`, et un bouton désactivé l'ignore — le focus resterait sur
 * place, et le créneau suivant deviendrait inatteignable. C'est aussi ce que
 * fait déjà la barre de dates pour ses journées complètes, et les deux se lisent
 * donc pareil.
 *
 * L'atténuation ne porte pas seule l'information : le mot est écrit sous
 * l'heure, et le nom accessible le reprend (WCAG 1.4.1).
 */
function SlotCell({
  slot,
  timeZone,
  note,
  busy,
  pressed,
  tabbable,
  onFocus,
  onChoose,
}: SlotCellProps) {
  const time = formatTimeInTimeZone(slot.startsAt, timeZone);
  const locked = note !== null || busy;
  const spoken = spokenTime(time);

  return (
    <span role="gridcell" className="spa-slot-grid__cell">
      <Button
        variant="neutral"
        // Le nom accessible dit l'heure en toutes lettres, le texte visible
        // garde la forme courte : hors de sa colonne, un créneau est lu seul.
        aria-label={note === null ? spoken : `${spoken} (${note})`}
        aria-disabled={locked ? true : undefined}
        aria-pressed={pressed}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
        onClick={() => {
          if (!locked) {
            onChoose(slot.startsAt);
          }
        }}
      >
        {note === null ? (
          time
        ) : (
          <>
            <span aria-hidden="true">{time}</span>
            <span aria-hidden="true" className="spa-slot-grid__note">
              {note}
            </span>
          </>
        )}
      </Button>
    </span>
  );
}
