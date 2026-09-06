'use client';

import {
  MAX_AVAILABILITY_RANGE_DAYS,
  type CalendarDate,
  type DayAvailability,
  type PublicService,
  type PublicTenant,
  type UtcInstant,
} from '@spa/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import {
  addCalendarDays,
  calendarDateInTimeZone,
  calendarWindow,
  formatCalendarDayShort,
} from '@/lib/booking/calendar';
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

import { loadAvailabilityAction } from '../actions';

/** Fenêtre proposée d'emblée. Le contrat plafonne la plage à 31 jours. */
const WINDOW_DAYS = 14;

/**
 * Période de revalidation des disponibilités.
 *
 * Une minute est un compromis, pas une valeur ronde : assez court pour qu'une
 * cliente qui hésite ne choisisse pas dans une liste vieille de dix minutes,
 * assez long pour qu'une page laissée ouverte une après-midi ne fasse pas
 * quelques centaines d'appels. Le rendez-vous se joue de toute façon au verrou
 * serveur — ce rafraîchissement réduit la fenêtre d'erreur, il ne la ferme pas.
 */
const REFRESH_INTERVAL_MS = 60_000;

/** Valeur du choix « premier disponible » — l'absence de préférence, pas un praticien. */
const FIRST_AVAILABLE = '';

interface SlotStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly onBack: () => void;
  /** Remonte le praticien retenu au brouillon : il survit au rafraîchissement et sert à la réservation. */
  readonly onStaffChange: (staffId: string | null) => void;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/** « 3 créneaux », « 1 créneau » — le pluriel se voit à l'écran. */
function slotCountLabel(count: number): string {
  return count === 1 ? '1 créneau' : `${String(count)} créneaux`;
}

/**
 * Choix du praticien et du créneau (#44, #351).
 *
 * ## Le praticien se change **ici**, pas un écran plus haut
 *
 * Il se choisit déjà à l'étape prestation, mais c'est devant le calendrier qu'on
 * découvre qu'on s'y est mal pris : la personne demandée n'a rien de libre cette
 * semaine, ou au contraire il n'y avait aucune raison de la demander. Renvoyer à
 * l'étape précédente pour cela ferait perdre la journée qu'on regardait. Le
 * sélecteur est donc rendu dans les deux écrans, sur le même état du brouillon.
 *
 * « Premier disponible » n'est pas une valeur manquante (CDC §1.4) : c'est
 * l'absence de préférence, et c'est le serveur qui affecte alors le praticien.
 * Le front ne choisit jamais à sa place — il déciderait sur un agenda périmé.
 *
 * ## Les journées et leurs créneaux viennent du serveur découpés
 *
 * Regrouper des instants UTC en journées demande le fuseau de l'établissement,
 * et c'est exactement le calcul qu'on ne veut pas voir réimplémenté dans un
 * navigateur. Les heures sont affichées dans ce fuseau, avec sa mention dès que
 * le visiteur n'y est pas — « 09:00 » ne veut rien dire à qui réserve en voyage.
 *
 * ## Les disponibilités se rafraîchissent pendant qu'on hésite
 *
 * À intervalle court **et** au retour sur l'onglet (skill web-frontend §3) :
 * entre le moment où la cliente ouvre la page et celui où elle choisit, un
 * créneau a pu partir. Les recharger ne supprime pas le 409 — seul le verrou
 * serveur le fait — mais évite de proposer longtemps ce qui n'existe plus.
 *
 * ## La barre de dates et la grille suivent les documents de conception
 *
 * [keyboard-navigation.md](../../../../../../../docs/design/appointments/keyboard-navigation.md)
 * fixe le comportement clavier de ce sélecteur, et c'est lui qui fait foi ici :
 * `grid` › `row` › `gridcell` › `<button>`, *roving tabindex*, flèches et
 * `Début`/`Fin` (et `Ctrl` pour les bornes de la grille), **sans enroulement**
 * aux bords, région `aria-live` pour le nombre de créneaux, focus déplacé quand
 * un créneau disparaît sous lui. La barre de dates reprend le même roving
 * tabindex sur une ligne, avec `PagePréc`/`PageSuiv` à la semaine.
 *
 * [states.md](../../../../../../../docs/design/appointments/states.md) fixe ses
 * trois états non nominaux : squelette de grille **sous une barre de dates
 * restée opérable**, état vide qui offre d'élargir la fenêtre au-delà des
 * quatorze jours, état d'erreur qui offre de réessayer.
 *
 * Deux points de ces documents restent à faire, et chacun pour une raison qui
 * lui est propre.
 *
 * Le **rendu barré des créneaux indisponibles** est sans objet en l'état :
 * `availabilityResponse` ne rend que les créneaux libres, un créneau pris est
 * simplement absent, et il n'y a rien à barrer. À reprendre si l'API se met un
 * jour à rendre l'agenda complet.
 *
 * Le **libellé accessible complet** — « 14 h 00 » plutôt que « 14:00 » pour un
 * créneau lu hors de sa colonne — se pose en une ligne, mais il change le nom
 * accessible de chaque créneau. Or le tunnel entier est éprouvé au travers de
 * ces noms-là (`tests/unit/booking-tunnel.test.tsx`), qui sortent de l'empreinte
 * de fichiers de ce ticket, mené en parallèle d'autres sur la même base. Le
 * changement et la reprise de ces requêtes vont ensemble ; les séparer laisserait
 * la suite rouge.
 */
export function SlotStep({
  tenant,
  service,
  staffId,
  onBack,
  onStaffChange,
  onChoose,
}: SlotStepProps) {
  const [days, setDays] = useState<readonly DayAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [selectedDate, setSelectedDate] = useState<CalendarDate | null>(null);
  /**
   * Largeur de la fenêtre demandée, en journées.
   *
   * Elle part à quatorze et ne s'élargit que sur demande explicite — « Voir plus
   * de jours », `states.md` étape 3. Trente et un jours d'agenda coûtent au
   * serveur, et la très grande majorité des clientes réservent dans la semaine.
   */
  const [windowDays, setWindowDays] = useState(WINDOW_DAYS);
  /**
   * Les dates civiles de la fenêtre en cours, posées au **lancement** de la
   * requête et non à son retour.
   *
   * C'est ce qui permet à la barre de dates d'être déjà là pendant que la grille
   * est en squelette. Elle est tenue en état plutôt que calculée au rendu parce
   * qu'elle dérive de `new Date()` : la calculer dans le corps du composant la
   * ferait diverger entre le rendu serveur et l'hydratation, une nuit sur
   * trois cent soixante-cinq, à minuit passé dans le fuseau du salon.
   */
  const [windowDates, setWindowDates] = useState<readonly CalendarDate[]>([]);
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
  const dateBarRef = useRef<HTMLDivElement | null>(null);
  /**
   * Le conteneur de l'état vide, pour pouvoir y poser le focus.
   *
   * Il n'est pas naturellement focalisable : c'est un `tabIndex={-1}` qui le
   * rend atteignable par programme sans l'ajouter à l'ordre de tabulation.
   */
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  /**
   * Où en est le rattrapage du focus après un élargissement de fenêtre.
   *
   * Trois états et non un booléen, parce qu'il faut laisser passer **deux**
   * rendus : celui du clic, où les journées de l'ancienne fenêtre sont encore
   * là, puis celui du chargement. S'arrêter au premier ferait poser le focus sur
   * l'écran que l'élargissement est précisément en train de remplacer.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchFocusAfterWidening = useRef<'inactif' | 'chargement' | 'resultat'>('inactif');
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
  /**
   * Numéro de la requête la plus récente.
   *
   * Deux chargements peuvent être en vol en même temps — un changement de
   * praticien pendant qu'une revalidation périodique traîne. Sans ce jeton, la
   * réponse la plus lente écraserait la plus fraîche, et l'écran afficherait
   * l'agenda du praticien qu'on vient de quitter.
   */
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const from = calendarDateInTimeZone(new Date(), tenant.timezone);
    const query = {
      serviceId: service.id,
      from,
      to: addCalendarDays(from, windowDays - 1),
      ...(staffId === null ? {} : { staffId }),
    };

    // Posée **avant** l'attente : c'est ce qui met la barre de dates à l'écran
    // en même temps que le squelette, et non une fois la réponse arrivée.
    setWindowDates(calendarWindow(from, windowDays));

    latestRequest.current += 1;
    const ticket = latestRequest.current;
    const result = await loadAvailabilityAction(tenant.slug, query);

    if (ticket !== latestRequest.current) {
      return;
    }

    if (result.ok) {
      setError(null);
      setDays(result.data.days);
    } else {
      setError(result.message);
      // Une revalidation qui échoue ne vide pas une liste déjà affichée : la
      // panne est passagère, les créneaux montrés restent la meilleure
      // information disponible. Seul un premier chargement en échec pose la
      // liste vide, pour que l'écran ne reste pas en squelette indéfiniment.
      setDays((current) => current ?? []);
    }
  }, [service.id, staffId, tenant.slug, tenant.timezone, windowDays]);

  useEffect(() => {
    // `load` ne change d'identité que lorsque la question posée change —
    // prestation, praticien, établissement, largeur de fenêtre. Les créneaux
    // affichés ne répondent alors plus à la question, et les garder à l'écran le
    // temps de l'aller-retour proposerait l'agenda du praticien précédent. On
    // repasse par le chargement.
    setDays(null);
    setError(null);
    void load();

    const revalidate = () => {
      // Un onglet caché n'a personne devant lui : le rafraîchir consommerait des
      // requêtes pour un écran que nul ne regarde.
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    const timer = globalThis.setInterval(revalidate, REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', revalidate);

    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [load]);

  /**
   * Le réessai explicite de l'état d'erreur — `states.md` étape 3.
   *
   * La revalidation périodique rattrape déjà seule au bout d'une minute, mais
   * une minute devant un écran en panne est très longue, et rien n'y dit que
   * quelque chose est en train de se faire. Le bouton se désactive le temps de
   * l'aller-retour : deux clics ne lancent pas deux requêtes (web-frontend §3).
   */
  const retry = useCallback(() => {
    setRetrying(true);
    void load().finally(() => {
      setRetrying(false);
    });
  }, [load]);

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
   * Le praticien demandé, tel qu'on peut le nommer à l'écran.
   *
   * `null` veut dire « aucune préférence », et **rien d'autre** : un `staffId`
   * relu du brouillon peut désigner quelqu'un que la prestation ne propose plus,
   * auquel cas le catalogue ne rend aucun nom. Le repli tient à ce que cette
   * préférence-là est justement celle dont il faut pouvoir sortir — la requête
   * la porte toujours, et elle ne rendra plus jamais un créneau.
   */
  const staffLabel =
    staffId === null
      ? null
      : (service.staff.find((member) => member.id === staffId)?.displayName ?? 'ce praticien');

  /**
   * La mention du fuseau, calculée **après** le chargement seulement.
   *
   * Elle lit le fuseau du navigateur, qui n'existe pas au rendu serveur. Ce
   * n'est pas une contrainte gênante ici : la branche qui l'affiche n'est
   * atteinte qu'une fois les disponibilités reçues, donc après le montage.
   */
  const zoneMention = days === null ? null : timeZoneMention(tenant.timezone);
  const dayHeading =
    activeDay === null
      ? ''
      : `Créneaux du ${formatCalendarDate(activeDay.date)}${
          zoneMention === null ? '' : ` — ${zoneMention}`
        }`;

  /** La journée affichée, découpée en lignes de grille — matin, après-midi, soir. */
  const rows = useMemo(
    () => (activeDay === null ? [] : slotRows(activeDay.slots, tenant.timezone)),
    [activeDay, tenant.timezone],
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
   */
  /**
   * Le focus rattrapé quand le bouton qu'on vient d'actionner s'est effacé.
   *
   * « Voir plus de jours » emporte l'état vide qui le portait : sans cela le
   * focus retombe sur `<body>`, et le clavier repart du haut du document juste
   * après un geste délibéré — exactement ce que `keyboard-navigation.md` refuse
   * ailleurs, quand une revalidation emporte le créneau focalisé.
   *
   * On attend le **résultat** et pas le squelette : l'élargissement repasse par
   * un chargement, et se poser sur la barre de dates de l'écran d'attente ferait
   * perdre le focus une seconde fois à l'arrivée des données. Selon ce que le
   * serveur rend, la cible est la journée retenue de la barre, ou l'état vide
   * lui-même — qui dit alors, en `role="status"`, ce que l'élargissement a donné.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    if (catchFocusAfterWidening.current === 'inactif') {
      return;
    }

    if (catchFocusAfterWidening.current === 'chargement') {
      if (days === null) {
        catchFocusAfterWidening.current = 'resultat';
      }

      return;
    }

    if (days === null) {
      return;
    }

    const target =
      dateBarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
      emptyStateRef.current;

    if (target !== null && target !== undefined) {
      catchFocusAfterWidening.current = 'inactif';
      target.focus();
    }
  });

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
  const moveFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
    },
    [],
  );

  /**
   * Les flèches circulent dans la barre de dates — `keyboard-navigation.md`,
   * « Barre de dates ».
   *
   * **Activation automatique** : la flèche déplace le focus *et* retient la
   * journée, comme dans tout `radiogroup`. Le document décrit `Entrée`/`Espace`
   * comme le geste de sélection, et ils le restent — mais un groupe de boutons
   * radio où la flèche ne sélectionnerait pas serait un groupe où un lecteur
   * d'écran annonce « non coché » sur quatorze journées d'affilée. La grille se
   * réécrit sous la barre, et la région `aria-live` annonce le nouveau nombre de
   * créneaux : c'est ce que la liste de vérification demande du changement de
   * jour.
   *
   * Le focus **reste dans la barre** plutôt que de partir sur le premier créneau
   * du nouveau jour, comme le suggère la prose du document : le déplacer
   * interdirait d'enchaîner deux flèches pour comparer deux journées, qui est
   * précisément ce à quoi une barre de dates sert.
   */
  const moveDay = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const move = dateBarMoveForKey(event.key);
      const dateBar = dateBarRef.current;

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
    [bar],
  );

  /**
   * La barre de dates — `keyboard-navigation.md`, « Barre de dates ».
   *
   * Un `radiogroup` et non un `<select>` natif : le document décrit une ligne de
   * journées parcourue aux flèches, et le `<select>` qui tenait ce rôle jusqu'ici
   * ne montrait qu'une journée à la fois. C'est un écart de forme qui coûtait
   * cher — comparer mardi et jeudi demandait d'ouvrir deux fois la liste.
   *
   * Les journées complètes restent rendues, inertes. Le serveur les renvoie avec
   * `slots: []` plutôt que de les omettre précisément pour qu'un calendrier
   * puisse afficher « complet » sans deviner les trous : les retirer ferait
   * croire à un salon fermé ce jour-là.
   */
  const dateBar =
    bar.length === 0 ? null : (
      <div
        ref={dateBarRef}
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
    <section aria-label="Choix du praticien et du créneau">
      <h2 className="spa-card__title">{service.name}</h2>

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

      <Select
        id="creneau-praticien"
        label="Praticien"
        value={staffId ?? FIRST_AVAILABLE}
        hint="Sans préférence, le salon vous attribue le premier praticien disponible."
        emptyLabel={
          service.staff.length === 0
            ? 'Aucun praticien ne propose cette prestation actuellement.'
            : undefined
        }
        onChange={(event) => {
          onStaffChange(event.target.value === FIRST_AVAILABLE ? null : event.target.value);
        }}
      >
        <option value={FIRST_AVAILABLE}>Premier disponible</option>
        {service.staff.map((member) => (
          <option key={member.id} value={member.id}>
            {member.displayName}
          </option>
        ))}
      </Select>

      {error === null ? null : (
        <Notification tone="danger" title="Les disponibilités n’ont pas pu être chargées">
          <p>{error}</p>
          <Button
            variant="neutral"
            loading={retrying}
            loadingLabel="Nouvelle tentative en cours…"
            onClick={retry}
          >
            Réessayer
          </Button>
        </Notification>
      )}

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
      ) : error !== null && allDays.length === 0 ? (
        // Le chargement a échoué et rien n'avait été affiché : la notification
        // ci-dessus le dit déjà, et annoncer sous elle « aucun créneau » ferait
        // passer une panne pour un agenda complet — en conseillant de changer de
        // prestation, ce qui n'y changerait rien.
        //
        // La condition porte sur les journées reçues, pas sur celles qui ont des
        // créneaux : le serveur rend toujours une entrée par jour demandé, même
        // vide, si bien qu'une liste de journées vide ne peut venir que d'un
        // premier chargement en échec. S'appuyer sur les journées *ouvertes*
        // ferait disparaître un état vide déjà affiché — et avec lui le bouton
        // qui lève la préférence de praticien — à la première revalidation ratée.
        null
      ) : open.length === 0 ? (
        <div className="spa-card spa-card--empty" role="status" ref={emptyStateRef} tabIndex={-1}>
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">
              {staffLabel === null
                ? `Aucun créneau sur les ${String(windowDays)} prochains jours`
                : `Aucun créneau avec ${staffLabel} sur les ${String(windowDays)} prochains jours`}
            </p>
            <p className="spa-empty-state__description">
              {staffLabel === null
                ? 'Essayez une autre prestation, ou contactez le salon directement.'
                : 'Un autre praticien a peut-être de la place, sinon contactez le salon directement.'}
            </p>
            {/*
              « Voir plus de jours » — `states.md` étape 3. Le contrat autorise
              trente et un jours ; on n'en demande quatorze d'emblée que parce
              que la très grande majorité des clientes réservent dans la semaine.
              Une fois la fenêtre élargie, le bouton disparaît : il n'aurait plus
              rien à élargir.
            */}
            {windowDays < MAX_AVAILABILITY_RANGE_DAYS ? (
              <Button
                variant="neutral"
                onClick={() => {
                  // Le clic emporte le bouton lui-même : la fenêtre élargie
                  // repasse par le chargement, l'état vide disparaît, et le
                  // focus retomberait sur `<body>` — le clavier repartirait du
                  // haut du document juste après un geste délibéré. On le
                  // rattrape sur la barre de dates, qui prend justement la
                  // place de cet écran (`keyboard-navigation.md`, « Parcours
                  // complet réalisable sans souris »).
                  catchFocusAfterWidening.current = 'chargement';
                  setWindowDays(MAX_AVAILABILITY_RANGE_DAYS);
                }}
              >
                Voir plus de jours
              </Button>
            ) : null}
            {staffLabel === null ? null : (
              <Button
                variant="neutral"
                onClick={() => {
                  onStaffChange(null);
                }}
              >
                Voir tous les praticiens
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          {dateBar}

          <h3 className="spa-card__meta" id="creneaux-titre">
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
            aria-labelledby="creneaux-titre"
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
                  <span role="gridcell" className="spa-slot-grid__cell" key={slot.startsAt}>
                    <Button
                      variant="neutral"
                      tabIndex={slot.startsAt === tabbableSlot ? 0 : -1}
                      onFocus={() => {
                        gridHasFocus.current = true;
                        setActiveSlot(slot.startsAt);
                      }}
                      onClick={() => {
                        onChoose(slot.startsAt);
                      }}
                    >
                      {formatTimeInTimeZone(slot.startsAt, tenant.timezone)}
                    </Button>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      <Button variant="quiet" onClick={onBack}>
        Changer de prestation
      </Button>
    </section>
  );
}
