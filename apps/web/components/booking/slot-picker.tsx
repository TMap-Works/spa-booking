'use client';

import type {
  AvailabilitySlot,
  CalendarDate,
  DayAvailability,
  OpeningHoursEntry,
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

import { AvailabilityCalendar } from '@/components/booking/availability-calendar';
import { DateBand } from '@/components/booking/date-band';
import { SlotGridSkeleton } from '@/components/booking/step-skeleton';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { bandStartShowing, bandWindow } from '@/lib/booking/day-band';
import { slotCountLabel } from '@/lib/booking/day-state';
import { type BookingWindow, type CalendarMonth } from '@/lib/booking/month-grid';
import {
  gridMoveForKey,
  moveInGrid,
  openDays as openDaysOf,
  resolveActiveDay,
  selectableDays,
  slotRows,
} from '@/lib/booking/slots';
import { formatCalendarDate, formatTimeInTimeZone, timeZoneMention } from '@/lib/format';

/**
 * Le sélecteur de créneau — un calendrier mensuel, puis la grille d'**une seule**
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
 * l'appelant qui décide de les rafraîchir, de changer de mois ou de rendre une
 * panne. Le sélecteur ne fait que **montrer** ce qu'on lui donne et dire ce qui a
 * été touché.
 *
 * ## Les documents de conception font foi
 *
 * [keyboard-navigation.md](../../../../docs/design/appointments/keyboard-navigation.md)
 * fixe le comportement clavier : `grid` › `row` › `gridcell` › `<button>`,
 * *roving tabindex*, flèches et `Début`/`Fin` (avec `Ctrl` pour les bornes de la
 * grille), **sans enroulement** aux bords, région `aria-live` pour le nombre de
 * créneaux, focus déplacé quand un créneau disparaît sous lui.
 *
 * [states.md](../../../../docs/design/appointments/states.md) fixe l'état de
 * chargement : squelette de grille **sous une navigation de dates restée
 * opérable**.
 *
 * ## Le choix de la date : une bande de jours, le mois à la demande (#827, #1049)
 *
 * #827 avait fait de ce choix un **calendrier mensuel** posé en tête de l'étape,
 * sur la foi de `wireframes.md` étape 3 et du « calendrier de disponibilité temps
 * réel » du CDC §1.4. La mesure a montré le coût : à 360 px, trente-cinq cases de
 * 40 px passent avant le premier horaire, et la grille des créneaux tombe sous la
 * ligne de flottaison — l'écran ne montre plus le choix qu'on est venu faire
 * (audit `d20260918-1`).
 *
 * `BM-CRENEAU-01` décrit ce que font les cinq plateformes observées : une rangée
 * de jours d'abord, le mois complet **à la demande**. Les deux contrôles vivent
 * donc ensemble — [`DateBand`](date-band.tsx) en premier plan,
 * [`AvailabilityCalendar`](availability-calendar.tsx) dans un panneau que le
 * bouton de période ouvre (`BM-TUNNEL-12`) — et ils partagent leur vocabulaire
 * d'état ([`day-state.ts`](../../lib/booking/day-state.ts)) pour ne pas dire deux
 * choses différentes de la même journée.
 *
 * Le mois visible et la fenêtre de réservation restent à l'appelant — lui seul
 * sait comment reposer la question au serveur. La bande, elle, ne demande rien de
 * plus : ses quatorze journées sont prises **dans** le mois déjà chargé, ce qui
 * tient le troisième critère d'acceptation de #1049 — *« aucune modification de
 * l'API de disponibilité ni du moteur »* — par construction, et fait hériter
 * l'écran de report sans qu'une ligne n'y change.
 */
interface SlotPickerProps {
  /**
   * Les journées à montrer, telles que l'API les rend.
   *
   * `null` veut dire « on ne sait pas encore » et non « il n'y a rien » : le
   * sélecteur rend alors le squelette de `states.md`, à côté d'un calendrier
   * resté opérable — il se pose sans le serveur, ce sont des dates.
   */
  readonly days: readonly DayAvailability[] | null;
  /**
   * Le mois que le calendrier affiche, `YYYY-MM`.
   *
   * `null` avec `bounds` : la date du jour n'est pas encore connue, et le
   * calendrier n'est pas rendu. C'est le cas du **premier rendu du tunnel**, où
   * « aujourd'hui dans le fuseau du salon » dérive de `new Date()` : le calculer
   * au rendu le ferait diverger entre le serveur et l'hydratation, une nuit sur
   * trois cent soixante-cinq, à minuit passé dans le fuseau du salon. Les écrans
   * rendus par le serveur, eux, le connaissent d'emblée et ne passent jamais par
   * là.
   */
  readonly month: CalendarMonth | null;
  /**
   * Les bornes réservables — première et dernière journée que le calendrier
   * laisse atteindre, et donc les mois entre lesquels il navigue.
   */
  readonly bounds: BookingWindow | null;
  /**
   * Les plages d'ouverture publiées par l'établissement.
   *
   * Traversées jusqu'au calendrier, qui s'en sert pour écrire « fermé » plutôt
   * que « complet » sur une journée où le salon n'ouvre pas (#742). Le sélecteur
   * n'en fait rien d'autre : elles ne décident d'aucun créneau.
   */
  readonly openingHours?: readonly OpeningHoursEntry[] | undefined;
  /** Ce que fait un changement de mois : c'est l'appelant qui recharge. */
  readonly onMonthChange: (month: CalendarMonth) => void;
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
  /**
   * Le conteneur du choix de la date, quand l'appelant doit y poser le focus.
   *
   * Il désigne la **bande de jours** depuis #1049, et non plus le calendrier :
   * celui-ci s'ouvre dans un panneau, et n'est donc pas dans le document quand un
   * changement de mois efface le bouton qui l'a demandé. La bande, elle, ne
   * disparaît jamais — c'est ce qui permet aux deux écrans de rattraper leur
   * focus sans changer une ligne. Le nom de la propriété est conservé parce que
   * l'écran de report, hors de l'empreinte de ce ticket, le passe déjà.
   */
  readonly calendarRef?: RefObject<HTMLDivElement | null>;
  readonly onChoose: (startsAt: UtcInstant) => void;
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
  month,
  bounds,
  openingHours,
  onMonthChange,
  timeZone,
  emptyState,
  selectedSlot,
  lockedSlotNote,
  busy = false,
  headingId = 'creneaux-titre',
  calendarRef,
  onChoose,
}: SlotPickerProps) {
  /** La journée que la bande et le calendrier montrent comme retenue. */
  const [selectedDate, setSelectedDate] = useState<CalendarDate | null>(null);
  /**
   * La journée posée en tête de bande, quand on l'a fait défiler.
   *
   * `null` — le cas nominal — laisse la bande s'ouvrir d'elle-même sur le premier
   * jour disponible (`BM-CRENEAU-02`). Elle est remise à `null` à chaque
   * changement de mois, la plage chargée changeant sous elle.
   */
  const [bandFrom, setBandFrom] = useState<CalendarDate | null>(null);
  /** Le mois complet est-il ouvert dans son panneau ? — `BM-TUNNEL-12`. */
  const [monthOpen, setMonthOpen] = useState(false);
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
   * Le conteneur de la bande, qu'un appelant fournisse le sien ou non.
   *
   * Les deux écrans y posent le focus après un changement de mois ; le sélecteur
   * en a besoin pour la même raison — le renvoi vers le prochain créneau libre
   * s'efface sous le clic qui l'actionne.
   */
  const ownBandRef = useRef<HTMLDivElement | null>(null);
  const bandNode = calendarRef ?? ownBandRef;
  /**
   * Le focus rattrapé quand le renvoi vers le prochain créneau s'efface.
   *
   * Le bouton vit dans l'état vide, que son propre clic remplace par la grille
   * d'horaires : il disparaît du document, et le focus retombe sur `<body>` —
   * le clavier repartirait du haut de la page juste après un geste délibéré, ce
   * que `keyboard-navigation.md` refuse partout ailleurs. La cible est la journée
   * que la bande retient, c'est-à-dire celle qu'on vient de demander.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un état
   * déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchBandFocus = useRef(false);
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
  /**
   * La fenêtre de quatorze journées que la bande montre.
   *
   * Calculée ici et passée à la bande plutôt que l'inverse : c'est elle qui
   * décide quelle journée la grille d'horaires détaille, et laisser chacun la
   * recalculer de son côté ferait exister deux vérités pour une seule rangée.
   *
   * `null` avec `month` ou `bounds` — le premier rendu du tunnel, où la date du
   * jour dans le fuseau du salon n'est pas encore connue : rien n'est rendu, et
   * la fenêtre est vide.
   */
  const band = useMemo(
    () =>
      month === null || bounds === null
        ? { dates: [], start: 0, visible: [] }
        : // À défaut de journée retenue, la bande s'ouvre sur la première qui a
          // des créneaux — `BM-CRENEAU-02`, *« la cliente ne tombe jamais sur un
          // écran vide au premier affichage »*. Elle ne se décale que si cette
          // journée-là sort de la première fenêtre : effacer aujourd'hui et
          // demain pour un jour libre situé au troisième rang n'apporterait rien.
          bandWindow(
            month,
            bounds,
            days === null ? null : allDays.map((day) => day.date),
            bandFrom,
            selectedDate ?? open[0]?.date ?? null,
          ),
    [allDays, bandFrom, bounds, days, month, open, selectedDate],
  );
  /**
   * Les journées ouvertes **de la fenêtre visible**.
   *
   * La grille d'horaires détaille une journée que la bande montre, jamais une
   * autre : retomber sur la première journée ouverte du mois entier ferait
   * afficher les heures du 28 sous une rangée qui s'arrête au 14, et le titre
   * démentirait la bande.
   */
  const visibleOpen = useMemo(
    () => open.filter((day) => band.visible.includes(day.date)),
    [band.visible, open],
  );
  const activeDay = resolveActiveDay(visibleOpen, selectedDate);
  /**
   * Le nombre de créneaux par date, tel que le calendrier peint ses cases.
   *
   * `null` tant que la réponse n'est pas là — « on ne sait pas encore » et « il
   * n'y a rien » ne se rendent ni ne se parcourent pareil, et c'est ce qui
   * permet au calendrier de rester opérable pendant le chargement (`states.md`
   * étape 3). Les journées complètes y figurent avec zéro : le serveur les rend
   * avec `slots: []` plutôt que de les omettre, précisément pour qu'un
   * calendrier puisse écrire « complet » sans deviner les trous.
   */
  const slotCounts = useMemo(
    () =>
      days === null
        ? null
        : new Map<CalendarDate, number>(allDays.map((day) => [day.date, day.slots.length])),
    [allDays, days],
  );
  /**
   * La journée que la bande et le calendrier montrent comme retenue — même en
   * cours de chargement.
   *
   * La journée choisie peut sortir de la plage chargée : un changement de mois
   * n'emporte pas la journée dont la grille montre encore les créneaux, et à
   * minuit passé « aujourd'hui » n'est plus le même jour. La vérification plutôt
   * qu'un simple `??` évite de marquer comme retenue une case que le mois visible
   * ne contient pas.
   */
  const calendarDate =
    activeDay?.date ??
    (selectedDate !== null && band.dates.includes(selectedDate) ? selectedDate : null);

  /**
   * La journée libre la plus proche, quand la fenêtre visible n'en a aucune.
   *
   * `BM-CRENEAU-03` — *« un jour plein devient une piste plutôt qu'une
   * impasse »* — et, pour qui n'a pas l'écran, la même exigence dans
   * `keyboard-navigation.md` : *« Aucun créneau ce jour, prochaine disponibilité
   * jeudi 28 à 9 h 00 »*. Sans cela, faire défiler la bande sur deux semaines
   * pleines laissait un cadre vide et aucune sortie.
   *
   * On regarde d'abord **après** la fenêtre, c'est-à-dire dans le sens du
   * parcours ; ce qui la précède ne sert que si l'on a défilé au-delà de tout ce
   * que le mois offrait. La comparaison de dates est une comparaison de chaînes :
   * sur un `YYYY-MM-DD` zéro-complété, l'ordre lexicographique **est** l'ordre
   * chronologique.
   */
  const firstVisible = band.visible[0] ?? null;
  const lastVisible = band.visible.at(-1) ?? null;
  const nearestOpen = useMemo(() => {
    const ahead = lastVisible === null ? undefined : open.find((day) => day.date > lastVisible);
    const behind =
      firstVisible === null
        ? undefined
        : [...open].reverse().find((day) => day.date < firstVisible);
    const day = ahead ?? behind;
    const first = day?.slots[0];

    if (day === undefined || first === undefined) {
      return null;
    }

    return {
      date: day.date,
      label: `${ahead === undefined ? 'Créneau précédent' : 'Prochain créneau'} : ${formatCalendarDate(
        day.date,
      )} à ${formatTimeInTimeZone(first.startsAt, timeZone)}`,
    };
  }, [firstVisible, lastVisible, open, timeZone]);

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

  /**
   * Le rattrapage lui-même, au premier rendu où la bande porte sa nouvelle
   * journée.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape.
   */
  useEffect(() => {
    if (!catchBandFocus.current) {
      return;
    }

    const target = bandNode.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]');

    if (target !== null && target !== undefined) {
      catchBandFocus.current = false;
      target.focus();
    }
  });

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
   * Changer de mois : la plage chargée change sous la bande, qui repart donc de
   * son point de départ naturel plutôt que de chercher une journée qui n'existe
   * plus.
   */
  const goToMonth = useCallback(
    (target: CalendarMonth) => {
      setBandFrom(null);
      onMonthChange(target);
    },
    [onMonthChange],
  );

  /**
   * Retenir une journée choisie **hors** de la fenêtre visible — depuis le
   * calendrier, ou depuis le renvoi vers le prochain créneau libre.
   *
   * La bande la ramène sous les yeux en bougeant le moins possible : sans cela,
   * choisir le 28 dans le calendrier laisserait une rangée arrêtée au 14 au-dessus
   * de la grille du 28.
   */
  const holdDate = useCallback(
    (date: CalendarDate) => {
      setSelectedDate(date);

      const target = band.dates.indexOf(date);

      if (target >= 0) {
        setBandFrom(band.dates[bandStartShowing(band.dates.length, band.start, target)] ?? null);
      }
    },
    [band.dates, band.start],
  );

  /**
   * Le mois complet, dans son panneau — `BM-CRENEAU-01`, `BM-TUNNEL-12`.
   *
   * Il n'est plus le contrôle de premier plan (#1049) mais il n'a pas disparu :
   * c'est lui qui mène à une date lointaine, et lui qui montre d'un coup d'œil
   * quels jours du mois ont des créneaux. Le panneau monte du bas sur un
   * téléphone, là où le pouce l'attend, et garde l'étape dessous.
   *
   * Le choix d'une date le referme : c'est le geste pour lequel on l'a ouvert, et
   * un panneau qui reste ouvert sur la réponse oblige à un second geste pour voir
   * ce qu'on vient de demander.
   *
   * `busy` le traverse : le report rend tous ses contrôles inertes le temps
   * qu'une confirmation parte, et une date retenue pendant ce vol désignerait une
   * journée que le rendu suivant remplace.
   */
  const calendar =
    month === null || bounds === null ? null : (
      <AvailabilityCalendar
        month={month}
        bounds={bounds}
        slotCounts={slotCounts}
        openingHours={openingHours}
        selectedDate={calendarDate}
        busy={busy}
        onMonthChange={goToMonth}
        onSelect={holdDate}
        // Seule l'activation referme : les flèches retiennent la journée au
        // passage — c'est le comportement de la bande d'avant #827 —, et refermer
        // le panneau à chaque `→` rendrait le mois impossible à parcourir au
        // clavier.
        onConfirm={() => {
          setMonthOpen(false);
        }}
      />
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

      {/*
        La bande est rendue dans **tous** les états, celui d'un mois sans créneau
        compris — ses journées sont des dates, le navigateur les pose sans le
        serveur (`states.md` étape 3). Un mois sans créneau est un mois qu'on
        quitte d'un chevron, sans que rien ne bouge autour.

        La grille des horaires vient **dessous**, et seulement dessous :
        `BM-CRENEAU-01`, *« sous la rangée, les seuls horaires du jour
        sélectionné »*. C'est ce qui change à 1 280 px, où le calendrier occupait
        une colonne entière à gauche pour que les heures se serrent à droite : la
        bande prend toute la largeur, et les horaires s'y étalent (`calendar.css`,
        `slot-grid.css`).
      */}
      <div className="spa-slot-picker">
        {month === null || bounds === null ? null : (
          <DateBand
            band={band}
            month={month}
            bounds={bounds}
            slotCounts={slotCounts}
            openingHours={openingHours}
            selectedDate={calendarDate}
            busy={busy}
            bandRef={bandNode}
            onFromChange={setBandFrom}
            onMonthChange={goToMonth}
            onSelect={setSelectedDate}
            onOpenMonth={() => {
              setMonthOpen(true);
            }}
          />
        )}

        <div className="spa-slot-picker__day">
          {days === null ? (
            // `states.md` étape 3 : « grille de créneaux en squelette, **en
            // gardant la barre de dates interactive** pour changer de jour sans
            // attendre ». La bande ci-dessus se pose sans le serveur — ce sont
            // des dates ; seuls les comptes de créneaux l'attendent.
            //
            // Le dessin est celui que le tunnel pose avant son hydratation
            // (`step-skeleton.tsx`, #1055) : des pastilles d'horaires, aux
            // places et à la hauteur de celles qui arrivent. Il remplace trois
            // lignes de carte grise, qui ne ressemblaient ni à la grille ni à
            // ce que le squelette d'avant hydratation montrait — la cliente
            // voyait alors un squelette céder la place à un autre.
            <div aria-busy="true">
              <span className="spa-visually-hidden">Chargement des disponibilités…</span>
              <SlotGridSkeleton />
            </div>
          ) : open.length === 0 ? (
            // `role="status"` et non un focus déplacé : la bande reste à l'écran,
            // et c'est elle que le focus suit après un changement de mois. La
            // région annonce d'elle-même ce que le mois a donné, sans arracher le
            // focus au contrôle qu'on vient d'actionner.
            <div className="spa-card spa-card--empty" role="status">
              {emptyState}
            </div>
          ) : activeDay === null ? (
            /*
              La fenêtre visible est pleine, mais le mois a encore quelque chose
              à offrir : `BM-CRENEAU-03`, *« un jour plein devient une piste
              plutôt qu'une impasse »*. Le bouton y mène d'un geste, et
              `role="status"` le dit à qui ne voit pas l'écran —
              `keyboard-navigation.md`, *« Aucun créneau ce jour, prochaine
              disponibilité jeudi 28 à 9 h 00 »*.
            */
            <div className="spa-card spa-card--empty" role="status">
              <div className="spa-empty-state">
                <p className="spa-empty-state__title">
                  {firstVisible === null || lastVisible === null
                    ? 'Aucun créneau sur ces journées'
                    : `Complet du ${formatCalendarDate(firstVisible)} au ${formatCalendarDate(lastVisible)}`}
                </p>
                {nearestOpen === null ? null : (
                  <Button
                    variant="accent"
                    onClick={() => {
                      // Le clic emporte le bouton lui-même : la grille du jour
                      // demandé remplace l'état vide qui le porte. Sans
                      // rattrapage, le focus retomberait sur `<body>`.
                      catchBandFocus.current = true;
                      holdDate(nearestOpen.date);
                    }}
                  >
                    {nearestOpen.label}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              <h3 className="spa-card__meta" id={headingId}>
                {dayHeading}
              </h3>

              {/*
                Grille composite, telle que `keyboard-navigation.md` la décrit :
                `grid` › `row` (un moment de la journée) › `gridcell` ›
                `<button>` natif. Le libellé du moment est un `rowheader`, ce qui
                le rend visible **et** l'annonce comme l'en-tête de sa ligne — un
                titre posé à côté de la grille ne dirait pas à quels créneaux il
                se rapporte.
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
                  // détaché** ne dit pas cela : c'est la disparition d'un
                  // créneau, pas un départ, et c'est le cas à rattraper.
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
                        pressed={
                          selectedSlot === undefined ? undefined : slot.startsAt === selectedSlot
                        }
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
        </div>
      </div>

      {/*
        Le mois complet, à la demande. Le `<dialog>` du panneau se charge du piège
        de focus, d'Échap, de l'inertie du fond et du retour du focus sur le
        bouton qui l'a appelé.

        Le calendrier n'est monté **que** panneau ouvert : fermé, il n'aurait rien
        à peindre, et laisser trente et une cases focalisables derrière un voile
        est le genre d'écart qu'un navigateur masque et qu'un lecteur d'écran
        trouve.
      */}
      <Sheet
        open={monthOpen}
        title="Choisir une date"
        onClose={() => {
          setMonthOpen(false);
        }}
      >
        {monthOpen ? calendar : null}
      </Sheet>
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
