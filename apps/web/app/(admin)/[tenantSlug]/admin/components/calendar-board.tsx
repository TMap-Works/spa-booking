'use client';

import type { Appointment, TimeZone } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { calendarFailureMessage } from '@/lib/admin/calendar-failure';
import {
  buildCalendarBoard,
  cellsInWindow,
  computeSlotWindow,
  statusModifier,
  STATUS_LABELS,
  type CalendarCell,
  type CalendarColumn,
  type SlotWindow,
} from '@/lib/admin/calendar-grid';
import {
  anchorOf,
  rangeKey,
  rangeLabel,
  rangeOf,
  shiftAnchor,
  todayInTimeZone,
  type CalendarView,
} from '@/lib/admin/calendar-range';

import type { AdminActionResult } from '../action-result';
import { loadCalendarRangeAction } from '../calendrier/actions';
import { adminCalendarPath, adminLoginPath } from '../paths';

/**
 * Le planning du back-office — vues jour et semaine (#49).
 *
 * ## Pourquoi ce composant est client alors que la page ne l'est pas
 *
 * Trois des cinq critères du ticket demandent un état vivant : naviguer entre
 * périodes sans recharger l'écran, précharger la période adjacente, et ne monter
 * que les rangées visibles. Le `"use client"` est donc posé ici — au niveau du
 * planning — et non sur la page, qui garde la garde de session, la lecture des
 * réglages et le premier chargement côté serveur (web-frontend §1).
 *
 * ## Les périodes déjà vues ne se rechargent pas
 *
 * Un cache par clé de période — `jour:2026-08-26`, `semaine:2026-08-24` — que la
 * page amorce avec la période demandée **et ses deux voisines**. Revenir sur
 * hier est alors instantané, et avancer d'un jour l'est aussi neuf fois sur dix :
 * le préchargement a couru pendant qu'on regardait.
 *
 * Le cache n'expire pas de lui-même. C'est un choix : la fenêtre d'un
 * planning se compte en minutes, le rendez-vous qu'on vient de poser depuis un
 * autre poste apparaîtra au prochain passage, et une invalidation périodique
 * ferait clignoter l'écran le plus regardé du salon pour un gain rare. #50 et #51,
 * qui écrivent, rafraîchiront la période qu'ils modifient.
 *
 * ## Ce que le trait d'heure courante impose
 *
 * Il n'est dessiné qu'**après** le montage : l'heure qu'il est au serveur n'est
 * pas celle qu'il est au navigateur, et un `new Date()` évalué des deux côtés
 * produirait un écart d'hydratation sur l'écran le plus ouvert du produit. Il se
 * redessine chaque minute, ce qui est exactement sa résolution.
 */

/** Ce que la page a déjà chargé, période par période. */
export type CalendarCache = Readonly<Record<string, readonly Appointment[]>>;

interface CalendarBoardProps {
  readonly tenantSlug: string;
  /** Fuseau de l'établissement — toutes les heures s'affichent dedans. */
  readonly timeZone: TimeZone;
  readonly view: CalendarView;
  /** Ancrage de la période ouverte, déjà normalisé par la page. */
  readonly date: string;
  readonly initialPeriods: CalendarCache;
  /** Message d'indisponibilité du premier chargement, s'il a échoué. */
  readonly loadError: string | null;
}

/** Rafraîchissement du trait d'heure courante — sa résolution est la minute. */
const NOW_REFRESH_MS = 60_000;

/** Ce que l'action serveur du planning rend — le type que le cache reçoit. */
type CalendarLoadResult = AdminActionResult<{ readonly appointments: Appointment[] }>;

export function CalendarBoard({
  tenantSlug,
  timeZone,
  view: initialView,
  date: initialDate,
  initialPeriods,
  loadError,
}: CalendarBoardProps) {
  const router = useRouter();
  const [view, setView] = useState<CalendarView>(initialView);
  const [date, setDate] = useState<string>(initialDate);
  const [periods, setPeriods] = useState<Map<string, readonly Appointment[]>>(
    () => new Map(Object.entries(initialPeriods)),
  );
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(loadError);
  const [now, setNow] = useState<Date | null>(null);
  const [visible, setVisible] = useState<SlotWindow>({ first: 0, last: 0 });

  const columnsRef = useRef<HTMLDivElement | null>(null);
  // La requête en cours, et non seulement sa clé : un second appel sur la même
  // période s'y **greffe** au lieu d'abandonner. Voir `load`.
  const inFlight = useRef<Map<string, Promise<CalendarLoadResult>>>(new Map());
  // Combien de chargements de premier plan attendent — le dernier éteint
  // l'indicateur, sinon la réponse la plus rapide l'éteindrait pour les autres.
  const foreground = useRef(0);

  const currentKey = rangeKey(view, date);
  const appointments = periods.get(currentKey);

  // Lue par `load` **après** son aller-retour : une réponse qui arrive alors que
  // l'opérateur a déjà changé de période ne doit ni allumer sa bannière, ni
  // effacer celle de la période qu'il regarde maintenant.
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  const board = useMemo(
    () =>
      buildCalendarBoard({
        view,
        range: rangeOf(view, date),
        appointments: appointments ?? [],
        timeZone,
        ...(now === null ? {} : { now }),
      }),
    [view, date, appointments, timeZone, now],
  );

  // Une période qu'on n'a pas encore n'est pas une période vide : dire « aucun
  // rendez-vous » pendant l'aller-retour affirmerait un planning libre là où on
  // ne sait rien encore, et c'est exactement l'écran sur lequel le comptoir
  // décide de poser un client.
  const isPending = appointments === undefined && loading;
  // Une vue jour sans rendez-vous n'a aucune colonne : l'écran bascule alors sur
  // son état vide, et la grille — donc le conteneur mesuré — n'est pas montée.
  const isEmpty = !isPending && board.columns.length === 0;
  const showsGrid = !isPending && !isEmpty;

  /** Charge une période absente du cache, et la range dedans. */
  const load = useCallback(
    async (nextView: CalendarView, anchor: string, background: boolean): Promise<void> => {
      const key = rangeKey(nextView, anchor);
      // Une période déjà demandée ne repart pas — mais l'appel se **greffe** sur
      // la requête en cours au lieu d'abandonner. Abandonner laissait un clic
      // tombé pendant le préchargement de la même période sans indicateur, et
      // surtout sans message si ce préchargement échouait : l'opérateur voyait
      // un planning vide là où l'agenda n'avait simplement pas pu être lu.
      let pending = inFlight.current.get(key);
      const owned = pending === undefined;

      if (pending === undefined) {
        pending = loadCalendarRangeAction(tenantSlug, nextView, anchor);
        inFlight.current.set(key, pending);
      }

      if (!background) {
        foreground.current += 1;
        setLoading(true);
      }

      let received: CalendarLoadResult;
      try {
        received = await pending;
      } finally {
        if (owned) {
          inFlight.current.delete(key);
        }
        if (!background) {
          foreground.current -= 1;

          if (foreground.current === 0) {
            setLoading(false);
          }
        }
      }

      const result = received;
      // Seule la période **affichée** parle. Un préchargement n'a rien demandé,
      // et une réponse arrivée après qu'on a changé de jour parlerait par-dessus
      // un planning qui, lui, s'affiche très bien.
      const speaks = !background && currentKeyRef.current === key;

      if (result.ok) {
        setPeriods((known) => new Map(known).set(key, result.data.appointments));

        if (speaks) {
          setFailure(null);
        }
        return;
      }

      // Une session expirée ne se répare pas en réessayant : c'est la seule
      // issue qui ne boucle pas, faute de rotation du jeton dans le back-office.
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        router.push(adminLoginPath(tenantSlug));
        return;
      }

      if (speaks) {
        // La même traduction que le premier rendu, côté serveur : sans elle,
        // ouvrir la semaine suivante afficherait le « Cannot GET … » brut du
        // cadre HTTP là où la journée ouverte disait ce qui manque.
        setFailure(calendarFailureMessage(result.code, result.message));
      }
    },
    [router, tenantSlug],
  );

  /** Ouvre une période — depuis le cache si elle y est, sinon par l'action. */
  const openPeriod = useCallback(
    (nextView: CalendarView, rawDate: string): void => {
      const anchor = anchorOf(nextView, rawDate);

      setView(nextView);
      setDate(anchor);

      if (periods.has(rangeKey(nextView, anchor))) {
        // La période est déjà là et s'affiche : la bannière de celle qu'on vient
        // de quitter n'a plus rien à dire au-dessus d'un planning intact.
        setFailure(null);
        return;
      }

      void load(nextView, anchor, false);
    },
    [load, periods],
  );

  // L'URL suit la période affichée, sans repasser par le serveur : le planning
  // se partage et survit à un rafraîchissement, mais changer de jour ne rejoue
  // pas le rendu d'un écran dont seul le contenu des colonnes change.
  useEffect(() => {
    globalThis.history.replaceState(null, '', adminCalendarPath(tenantSlug, { view, date }));
  }, [tenantSlug, view, date]);

  // Préchargement des deux périodes voisines — deuxième critère du ticket.
  useEffect(() => {
    for (const step of [-1, 1]) {
      const anchor = shiftAnchor(view, date, step);

      if (!periods.has(rangeKey(view, anchor))) {
        void load(view, anchor, true);
      }
    }
  }, [view, date, periods, load]);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => {
      setNow(new Date());
    }, NOW_REFRESH_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  // Virtualisation : la fenêtre montée suit le défilement **de la page**, parce
  // que c'est la page qui défile — l'en-tête des colonnes est `position: sticky`
  // et le corps du calendrier ne défile pas de son côté (styles/admin/calendar.css).
  useEffect(() => {
    const measure = (): void => {
      const element = columnsRef.current;

      if (element === null) {
        return;
      }

      const box = element.getBoundingClientRect();

      setVisible(
        computeSlotWindow({
          // Le haut de la grille passé au-dessus du bord de la fenêtre.
          scrollTop: Math.max(0, -box.top),
          viewportHeight: globalThis.innerHeight,
          // Une sentinelle maintient la hauteur totale quoi qu'il soit monté :
          // la mesure est donc stable et ne rétroagit pas sur la fenêtre.
          slotHeight: board.slotCount === 0 ? 0 : element.clientHeight / board.slotCount,
          slotCount: board.slotCount,
        }),
      );
    };

    measure();
    globalThis.addEventListener('scroll', measure, { passive: true });
    globalThis.addEventListener('resize', measure);

    return () => {
      globalThis.removeEventListener('scroll', measure);
      globalThis.removeEventListener('resize', measure);
    };
    // `showsGrid` en dépendance et pas seulement `slotCount` : passer d'une
    // journée vide — ou d'une période en cours de chargement — à une semaine
    // remplie **monte** le conteneur qu'on mesure sans changer le nombre de
    // rangées. Sans cette dépendance, la mesure ne rejouait pas, la fenêtre
    // restait à zéro rangée, et la grille s'affichait sans un seul créneau —
    // c'est ce que la recette a montré.
  }, [board.slotCount, showsGrid]);

  const classes = [
    'spa-admin-calendar',
    view === 'semaine' ? 'spa-admin-calendar--week' : null,
    loading ? 'spa-admin-calendar--loading' : null,
    showsGrid ? null : 'spa-admin-calendar--empty',
  ]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <>
      <div className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <Button
            variant="neutral"
            onClick={() => {
              openPeriod(view, shiftAnchor(view, date, -1));
            }}
          >
            <span aria-hidden="true">‹</span>
            <span className="spa-visually-hidden">
              {view === 'jour' ? 'Jour précédent' : 'Semaine précédente'}
            </span>
          </Button>
          <span className="spa-admin-toolbar__caption">{rangeLabel(view, date)}</span>
          <Button
            variant="neutral"
            onClick={() => {
              openPeriod(view, shiftAnchor(view, date, 1));
            }}
          >
            <span aria-hidden="true">›</span>
            <span className="spa-visually-hidden">
              {view === 'jour' ? 'Jour suivant' : 'Semaine suivante'}
            </span>
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              openPeriod(view, todayInTimeZone(timeZone));
            }}
          >
            Aujourd’hui
          </Button>
        </div>

        <fieldset className="spa-admin-segmented">
          <legend className="spa-visually-hidden">Vue du planning</legend>
          <input
            className="spa-admin-segmented__input spa-visually-hidden"
            type="radio"
            name="vue"
            id="vue-jour"
            checked={view === 'jour'}
            onChange={() => {
              openPeriod('jour', date);
            }}
          />
          <label className="spa-admin-segmented__option" htmlFor="vue-jour">
            Jour
          </label>
          <input
            className="spa-admin-segmented__input spa-visually-hidden"
            type="radio"
            name="vue"
            id="vue-semaine"
            checked={view === 'semaine'}
            onChange={() => {
              openPeriod('semaine', date);
            }}
          />
          <label className="spa-admin-segmented__option" htmlFor="vue-semaine">
            Semaine
          </label>
        </fieldset>

        <div className="spa-admin-toolbar__group spa-admin-toolbar__spacer">
          <span className="spa-admin-toolbar__hint">
            Heures affichées dans le fuseau du salon ({timeZone})
          </span>
        </div>
      </div>

      {failure === null ? null : (
        <Notification tone="danger" title="Planning indisponible">
          <p>{failure}</p>
        </Notification>
      )}

      <div className={classes} aria-busy={loading}>
        {loading ? <p className="spa-visually-hidden">Chargement du planning…</p> : null}

        <div className="spa-admin-calendar__legend">
          {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((status) => (
            <span
              className={`spa-admin-badge spa-admin-badge--${statusModifier(status)}`}
              key={status}
            >
              {STATUS_LABELS[status]}
            </span>
          ))}
        </div>

        <div className="spa-admin-calendar__head">
          <div className="spa-admin-calendar__head-spacer" />
          {!showsGrid ? (
            <div className="spa-admin-calendar__column-head">
              <span className="spa-admin-calendar__column-name">{rangeLabel(view, date)}</span>
              <span className="spa-admin-calendar__column-meta">
                {isPending ? 'Chargement…' : 'Aucun rendez-vous'}
              </span>
            </div>
          ) : (
            board.columns.map((column) => (
              <div className="spa-admin-calendar__column-head" id={column.id} key={column.id}>
                <span className="spa-admin-calendar__column-name">{column.name}</span>
                <span className="spa-admin-calendar__column-meta">{column.meta}</span>
              </div>
            ))
          )}
        </div>

        <div className="spa-admin-calendar__body">
          {isPending ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">Chargement de la période…</p>
              <p className="spa-empty-state__description">
                Les rendez-vous de cette période arrivent.
              </p>
            </div>
          ) : isEmpty ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">Aucun rendez-vous sur cette période</p>
              <p className="spa-empty-state__description">
                Rien n’est encore posé ici. Changez de période, ou passez en vue semaine pour voir
                plus large.
              </p>
              <Button
                variant="neutral"
                onClick={() => {
                  openPeriod(view, shiftAnchor(view, date, 1));
                }}
              >
                {view === 'jour' ? 'Aller au jour suivant' : 'Aller à la semaine suivante'}
              </Button>
            </div>
          ) : (
            <>
              <div className="spa-admin-calendar__gutter" aria-hidden="true">
                {board.hours.map((hour) => (
                  <span className="spa-admin-calendar__hour" key={hour}>
                    {hour}
                  </span>
                ))}
              </div>
              <div className="spa-admin-calendar__columns" ref={columnsRef}>
                {board.columns.map((column) => (
                  <CalendarColumnView
                    column={column}
                    key={column.id}
                    slotCount={board.slotCount}
                    visible={visible}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Une colonne — un praticien en vue jour, une journée en vue semaine.
 *
 * Les positions sont posées en style **en ligne**, et c'est délibéré : une
 * rangée de départ et un couloir sont des données d'exécution, pas des jetons de
 * design. C'est la même distinction que `--now-offset` de
 * `styles/admin/calendar.css`, dont l'en-tête explique pourquoi une valeur qui
 * change à chaque rendu n'a rien à faire dans `tokens.css`.
 */
function CalendarColumnView({
  column,
  slotCount,
  visible,
}: {
  readonly column: CalendarColumn;
  readonly slotCount: number;
  readonly visible: SlotWindow;
}) {
  const mounted = cellsInWindow(column.cells, visible);

  return (
    <ul
      className="spa-admin-calendar__column"
      aria-labelledby={column.id}
      {...(column.laneCount > 1
        ? { style: { gridTemplateColumns: `repeat(${String(column.laneCount)}, minmax(0, 1fr))` } }
        : {})}
    >
      {mounted.map((cell) => (
        <CalendarCellView cell={cell} key={cell.key} laneCount={column.laneCount} />
      ))}
      {/* Sentinelle : elle tient la hauteur de la journée entière quoi que la
          virtualisation ait monté. Sans elle, la grille se replierait sur les
          seules rangées visibles et le défilement s'arrêterait à mi-journée. */}
      <li
        aria-hidden="true"
        className="spa-admin-calendar__cell"
        style={{ gridRow: `${String(slotCount)} / span 1` }}
      />
    </ul>
  );
}

function CalendarCellView({
  cell,
  laneCount,
}: {
  readonly cell: CalendarCell;
  readonly laneCount: number;
}) {
  const placement = {
    gridRow: `${String(cell.slot + 1)} / span ${String(cell.span)}`,
    gridColumn: cell.kind === 'event' ? String(cell.lane + 1) : `1 / span ${String(laneCount)}`,
  };

  if (cell.kind === 'free') {
    return (
      <li className="spa-admin-calendar__cell" style={placement}>
        <button
          className={`spa-admin-calendar__slot${cell.nowOffset === null ? '' : ' spa-admin-calendar__slot--now'}`}
          type="button"
          {...(cell.nowOffset === null
            ? {}
            : { style: { '--now-offset': cell.nowOffset } as Record<string, string> })}
        >
          <span className="spa-visually-hidden">
            {cell.timeLabel}
            {cell.nowOffset === null ? ', libre' : ', libre, heure courante'}
          </span>
        </button>
      </li>
    );
  }

  const status = cell.appointment.status;

  return (
    <li className="spa-admin-calendar__cell" style={placement}>
      <button
        className={`spa-admin-calendar__event spa-admin-calendar__event--${statusModifier(status)}`}
        type="button"
      >
        <span className="spa-admin-calendar__event-time">{cell.timeLabel}</span>
        <span className="spa-admin-calendar__event-client">{cell.clientLabel}</span>
        {cell.serviceLabel === null ? null : (
          <span className="spa-admin-calendar__event-service">{cell.serviceLabel}</span>
        )}
        {/* Le statut est porté par le liseré **et** par ce nom accessible :
            jamais par la seule couleur de fond (WCAG 1.4.1). */}
        <span className="spa-visually-hidden">Statut : {STATUS_LABELS[status]}.</span>
      </button>
    </li>
  );
}
