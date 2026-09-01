'use client';

import type {
  CalendarDate,
  DayAvailability,
  PublicService,
  PublicTenant,
  UtcInstant,
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
import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import {
  gridMoveForKey,
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
 * Choix du praticien et du créneau (#44).
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
 * ## La grille de créneaux suit le document de conception
 *
 * [docs/design/appointments/keyboard-navigation.md](../../../../../../../docs/design/appointments/keyboard-navigation.md)
 * fixe le comportement clavier de ce sélecteur, et c'est lui qui fait foi ici :
 * `grid` › `row` › `gridcell` › `<button>`, *roving tabindex*, flèches et
 * `Début`/`Fin` (et `Ctrl` pour les bornes de la grille), **sans enroulement**
 * aux bords, région `aria-live` pour le nombre de créneaux, focus déplacé quand
 * un créneau disparaît sous lui.
 *
 * Trois points de sa liste de vérification restent à faire, et demandent un
 * travail de style qui sort de ce ticket : la barre de dates aux flèches — la
 * journée se choisit ici par un `<select>` natif, donc déjà au clavier —, le
 * rendu barré des créneaux indisponibles — l'API ne les rend pas, ils sont
 * simplement absents — et le `scroll-margin` sous la barre collante.
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
      to: addCalendarDays(from, WINDOW_DAYS - 1),
      ...(staffId === null ? {} : { staffId }),
    };

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
  }, [service.id, staffId, tenant.slug, tenant.timezone]);

  useEffect(() => {
    // `load` ne change d'identité que lorsque la question posée change —
    // prestation, praticien, établissement. Les créneaux affichés ne répondent
    // alors plus à la question, et les garder à l'écran le temps de l'aller-retour
    // proposerait l'agenda du praticien précédent. On repasse par le chargement.
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

    const timer = window.setInterval(revalidate, REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', revalidate);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [load]);

  const allDays = useMemo(() => selectableDays(days ?? []), [days]);
  const open = useMemo(() => openDaysOf(allDays), [allDays]);
  const activeDay = resolveActiveDay(allDays, selectedDate);
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
        </Notification>
      )}

      {days === null ? (
        <div className="spa-card spa-card--loading" aria-busy="true">
          <span className="spa-visually-hidden">Chargement des disponibilités…</span>
          <span className="spa-skeleton spa-field__skeleton" />
          <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
          <span className="spa-skeleton spa-card__skeleton-line" />
          <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
        </div>
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
        <div className="spa-card spa-card--empty">
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">
              {staffLabel === null
                ? `Aucun créneau sur les ${String(WINDOW_DAYS)} prochains jours`
                : `Aucun créneau avec ${staffLabel} sur les ${String(WINDOW_DAYS)} prochains jours`}
            </p>
            <p className="spa-empty-state__description">
              {staffLabel === null
                ? 'Essayez une autre prestation, ou contactez le salon directement.'
                : 'Un autre praticien a peut-être de la place, sinon contactez le salon directement.'}
            </p>
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
          <Select
            id="creneau-journee"
            label="Journée"
            value={activeDay?.date ?? ''}
            onChange={(event) => {
              // La valeur vient des `value` posées juste en dessous, toutes
              // issues d'une `CalendarDate` du contrat : l'assertion ne fait que
              // reconduire ce que le DOM a perdu en la rendant en chaîne.
              setSelectedDate(event.target.value as CalendarDate);
            }}
          >
            {/*
              Les journées complètes restent listées, inertes. Le serveur les
              renvoie avec `slots: []` plutôt que de les omettre précisément pour
              qu'un calendrier puisse afficher « complet » sans deviner les
              trous : les retirer ferait croire à un salon fermé ce jour-là.
            */}
            {allDays.map((day) => (
              <option key={day.date} value={day.date} disabled={day.slots.length === 0}>
                {formatCalendarDate(day.date)} —{' '}
                {day.slots.length === 0 ? 'complet' : slotCountLabel(day.slots.length)}
              </option>
            ))}
          </Select>

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
              <div role="row" key={row.label}>
                <span role="rowheader" className="spa-card__meta">
                  {row.label}
                </span>
                {row.slots.map((slot) => (
                  <span role="gridcell" key={slot.startsAt}>
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
