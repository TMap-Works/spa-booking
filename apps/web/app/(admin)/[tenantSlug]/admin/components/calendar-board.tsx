'use client';

import type { Appointment, Service, StaffMemberSummary, TimeZone } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  isReschedulable,
  moveRefusal,
  planDeskMove,
  type DeskMove,
  type DeskMoveRefusal,
  type DeskMoveTarget,
} from '@/lib/admin/appointment-desk';
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
import { loadCalendarRangeAction, rescheduleDeskAppointmentAction } from '../calendrier/actions';
import { adminCalendarPath, adminSessionRefreshPath } from '../paths';

import { AppointmentPanel, type DeskTarget } from './appointment-panel';
import { CalendarMoveConfirm } from './calendar-move-confirm';

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
 * ferait clignoter l'écran le plus regardé du salon pour un gain rare. Les
 * écritures, elles, le corrigent : le tiroir relit la période qu'il modifie
 * (#50), le glisser-déposer y remplace le seul rendez-vous qu'il déplace (#51).
 *
 * ## Ce que le trait d'heure courante impose
 *
 * Il n'est dessiné qu'**après** le montage : l'heure qu'il est au serveur n'est
 * pas celle qu'il est au navigateur, et un `new Date()` évalué des deux côtés
 * produirait un écart d'hydratation sur l'écran le plus ouvert du produit. Il se
 * redessine chaque minute, ce qui est exactement sa résolution.
 *
 * ## Le report par glisser-déposer, et son retour arrière (#51)
 *
 * Un bloc se saisit et se lâche sur un créneau libre. Ce que cela déclenche est
 * un **report** — `POST /appointments/:id/reschedule`, donc une annulation suivie
 * d'une création liée côté serveur (booking-engine §5) — et jamais une mise à
 * jour des dates en place. Le calcul du report vit dans
 * `lib/admin/appointment-desk.ts` ; ce composant n'en tient que l'état.
 *
 * Trois choses s'enchaînent, et l'ordre est le sujet du ticket :
 *
 * 1. **Le bloc bouge tout de suite.** Le cache de la période affichée est corrigé
 *    au lâcher, sans attendre l'aller-retour. C'est ce qui rend l'agenda
 *    manipulable au rythme d'un comptoir.
 * 2. **Un refus le remet où il était**, et dit pourquoi. Un 409 est le cas normal
 *    sous concurrence, pas une panne : le créneau visé a pu être pris depuis un
 *    autre poste entre l'affichage et le lâcher. Le bloc reprend sa place, la
 *    bannière nomme le rendez-vous, son heure d'origine et la raison du refus.
 * 3. **Un changement de praticien se confirme** avant d'être envoyé.
 *
 * Aucune bibliothèque de glisser-déposer : l'API HTML5 native (`draggable`,
 * `dragstart` / `dragover` / `drop`) suffit à ce geste-là, et une dépendance de
 * plus sur l'écran le plus chargé du back-office se paierait à chaque ouverture.
 * Elle laisse en revanche le clavier de côté — d'où la **poignée** que porte
 * chaque bloc déplaçable : elle saisit le rendez-vous, les créneaux libres
 * deviennent des cibles nommées, Échap repose. Même mécanique, même code, sans
 * souris (web-frontend §7).
 */

/** Ce que la page a déjà chargé, période par période. */
export type CalendarCache = Readonly<Record<string, readonly Appointment[]>>;

/**
 * Ce que la grille sait du report en cours — passé de proche en proche jusqu'aux
 * cellules.
 *
 * Un objet plutôt que six propriétés : la colonne ne fait que transmettre, et
 * six paramètres de plus à chaque étage rendraient illisible ce qu'elle transmet.
 */
interface CalendarDragState {
  /** Le rendez-vous saisi — à la souris ou à la poignée —, `null` sinon. */
  readonly picked: Appointment | null;
  /** Le rendez-vous dont le report est en vol : son bloc est en attente. */
  readonly movingId: string | null;
  /** Le rendez-vous qu'un refus vient de replacer : son bloc le signale. */
  readonly revertedId: string | null;
  /** La poignée : saisit le rendez-vous, ou le repose s'il l'était déjà. */
  readonly onToggle: (appointment: Appointment) => void;
  /** Le glissement à la souris commence — la saisie ne bascule pas, elle se pose. */
  readonly onPick: (appointment: Appointment) => void;
  /** Le glissement s'achève sans lâcher utile, ou Échap : on repose. */
  readonly onRelease: () => void;
  /** Le lâcher sur un créneau libre. */
  readonly onDrop: (appointment: Appointment, target: DeskMoveTarget) => void;
}

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
  /**
   * Le catalogue de l'établissement, pour le tiroir de rendez-vous (#50).
   *
   * Chargé une fois par la page plutôt qu'à chaque ouverture du tiroir : il ne
   * change pas entre deux clics, et le faire attendre l'opérateur qui vient de
   * cliquer sur un créneau serait exactement la lenteur que ce chemin doit
   * éviter. Vide, le tiroir bascule sur son état « catalogue vide ».
   */
  readonly services: readonly Service[];
  /**
   * Les praticiens actifs de l'établissement — les colonnes de la vue jour (#507).
   *
   * Chargé par la page en même temps que le catalogue, pour la même raison : le
   * répertoire ne change pas entre deux journées, et le relire à chaque
   * navigation ferait payer un aller-retour à la flèche « jour suivant ».
   *
   * Vide — répertoire illisible, ou salon sans aucune fiche —, la vue jour
   * retombe sur les praticiens occupés, c'est-à-dire sur le comportement d'avant
   * ce ticket. Une journée creuse y redevient un état vide, mais le planning
   * reste consultable : lire l'agenda ne dépend pas du répertoire.
   */
  readonly staff: readonly StaffMemberSummary[];
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
  services,
  staff,
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
  /** Ce que le tiroir de rendez-vous est en train de montrer, s'il est ouvert (#50). */
  const [target, setTarget] = useState<DeskTarget | null>(null);
  /** Le rendez-vous saisi, tant qu'il n'est pas lâché — souris ou poignée (#51). */
  const [picked, setPicked] = useState<Appointment | null>(null);
  /** Le report en vol, et la période où son état optimiste a été appliqué. */
  const [moving, setMoving] = useState<{ move: DeskMove; key: string } | null>(null);
  /** Le report qui attend la confirmation du changement de praticien. */
  const [confirming, setConfirming] = useState<{ move: DeskMove; key: string } | null>(null);
  /** Le retour arrière à annoncer, et le bloc qu'il vient de replacer. */
  const [refusal, setRefusal] = useState<{
    notice: DeskMoveRefusal;
    appointmentId: string;
  } | null>(null);

  const columnsRef = useRef<HTMLDivElement | null>(null);
  // La requête en cours, et non seulement sa clé : un second appel sur la même
  // période s'y **greffe** au lieu d'abandonner. Voir `load`.
  const inFlight = useRef<Map<string, Promise<CalendarLoadResult>>>(new Map());
  // Combien de chargements de premier plan attendent — le dernier éteint
  // l'indicateur, sinon la réponse la plus rapide l'éteindrait pour les autres.
  const foreground = useRef(0);
  // Le numéro du cache courant. Une écriture du tiroir le vide et l'incrémente ;
  // une réponse partie **avant** cette écriture ne s'y range plus. Sans ce
  // compteur, un chargement en vol au moment où l'on pose un rendez-vous
  // rerangerait dans le cache une période sans lui, et le rendez-vous qu'on
  // vient de créer disparaîtrait de l'écran (#50).
  const cacheAge = useRef(0);

  const currentKey = rangeKey(view, date);
  const appointments = periods.get(currentKey);
  /** L'URL de la période affichée — celle que l'effet d'historique y écrit. */
  const currentPath = adminCalendarPath(tenantSlug, { view, date });

  // Lue par `load` **après** son aller-retour : une réponse qui arrive alors que
  // l'opérateur a déjà changé de période ne doit ni allumer sa bannière, ni
  // effacer celle de la période qu'il regarde maintenant.
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  // Même raison, pour le retour après renouvellement : c'est la période que
  // l'opérateur **regarde** qui doit lui être rendue, jamais celle dont le
  // préchargement a découvert que la session avait expiré.
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  // La confirmation en attente, lue par l'effet de changement de période sans
  // qu'il ait à en dépendre : en dépendre le ferait annuler la question à
  // l'instant même où le lâcher vient de la poser.
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  /**
   * Renouvelle la session, puis revient sur la période affichée (#458).
   *
   * L'écran poussait jusqu'ici vers la connexion, au motif qu'il n'y avait « pas
   * de rotation du jeton dans le back-office ». Ce n'est plus vrai depuis #48 :
   * la route `admin/session/refresh` pose une session neuve et renvoie d'où l'on
   * vient. Le planning était le seul écran à ne pas en profiter — celui-là même
   * dont les huit heures d'ouverture d'affilée justifient toute la mécanique.
   *
   * `replace` et non `push` : un renouvellement n'est pas une destination, et le
   * laisser dans l'historique ferait renouveler une seconde fois au premier
   * retour arrière.
   *
   * Ce chemin ne boucle pas. La route repart vers la connexion quand le jeton de
   * rafraîchissement manque lui aussi, et efface les deux cookies quand l'API le
   * refuse — un `UNAUTHORIZED` né d'une session révoquée finit donc sur l'écran
   * de connexion, en un aller-retour de plus et sans jamais revenir ici.
   */
  const renewSession = useCallback((): void => {
    router.replace(adminSessionRefreshPath(tenantSlug, currentPathRef.current));
  }, [router, tenantSlug]);

  const board = useMemo(
    () =>
      buildCalendarBoard({
        view,
        range: rangeOf(view, date),
        appointments: appointments ?? [],
        staff,
        timeZone,
        ...(now === null ? {} : { now }),
      }),
    [view, date, appointments, staff, timeZone, now],
  );

  // Une période qu'on n'a pas encore n'est pas une période vide : dire « aucun
  // rendez-vous » pendant l'aller-retour affirmerait un planning libre là où on
  // ne sait rien encore, et c'est exactement l'écran sur lequel le comptoir
  // décide de poser un client.
  const isPending = appointments === undefined && loading;
  // Aucune colonne à rendre : l'écran bascule sur son état vide, et la grille —
  // donc le conteneur mesuré — n'est pas montée. Depuis #507 la vue jour ouvre
  // une colonne par praticien du répertoire : il n'y reste donc que le salon
  // sans aucune fiche praticien, et le cas où le répertoire n'a pas pu être lu.
  const isEmpty = !isPending && board.columns.length === 0;
  const showsGrid = !isPending && !isEmpty;

  /** Charge une période absente du cache, et la range dedans. */
  const load = useCallback(
    async (nextView: CalendarView, anchor: string, background: boolean): Promise<void> => {
      const key = rangeKey(nextView, anchor);
      const age = cacheAge.current;
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
        // Seulement si l'entrée est encore la sienne : `reloadPeriods` vide la
        // table et une nouvelle requête peut déjà s'y être inscrite sous la même
        // clé. L'effacer aveuglément la rendrait injoignable, et la période
        // repartirait une troisième fois.
        if (owned && inFlight.current.get(key) === pending) {
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
      // Une réponse d'avant la dernière écriture décrit un agenda périmé.
      const stale = cacheAge.current !== age;

      if (result.ok) {
        if (!stale) {
          setPeriods((known) => new Map(known).set(key, result.data.appointments));
        }

        if (speaks) {
          setFailure(null);
        }
        return;
      }

      // Une session expirée ne se répare pas en réessayant — mais elle se
      // renouvelle : on part vers la route de renouvellement, qui rend la main
      // sur la période affichée.
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        renewSession();
        return;
      }

      if (speaks) {
        // La même traduction que le premier rendu, côté serveur : sans elle,
        // ouvrir la semaine suivante afficherait le « Cannot GET … » brut du
        // cadre HTTP là où la journée ouverte disait ce qui manque.
        setFailure(calendarFailureMessage(result.code, result.message));
      }
    },
    [renewSession, tenantSlug],
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

  /**
   * Vide le cache et relit la période affichée — après une écriture du tiroir,
   * ou après un créneau perdu (#50, quatrième critère).
   *
   * Tout le cache et non la seule période ouverte : le tiroir laisse changer la
   * date, si bien qu'un rendez-vous peut être né dans une période **voisine**,
   * qui est justement celle que le préchargement a déjà rangée. Ne relire que la
   * période visible la laisserait périmée jusqu'au prochain rechargement de page.
   */
  const reloadPeriods = useCallback((): void => {
    cacheAge.current += 1;
    inFlight.current.clear();
    setPeriods(new Map());
    void load(view, date, false);
  }, [load, view, date]);

  /**
   * Remplace un rendez-vous d'une période déjà chargée — et rien d'autre (#51).
   *
   * C'est le geste de l'état optimiste, de sa confirmation par le serveur et de
   * son retour arrière : les trois ne diffèrent que par le rendez-vous qu'on
   * range à la place. Relire la période entière ferait clignoter l'écran à chaque
   * lâcher et perdrait exactement ce que l'état optimiste apporte ; et il n'y a
   * rien d'autre à relire — un créneau libre appartient à la période affichée,
   * donc un report par glissement ne peut sortir ni de la journée ouverte, ni de
   * la semaine ouverte.
   *
   * Le numéro de cache est incrémenté pour la même raison qu'à l'écriture du
   * tiroir : une réponse d'agenda partie **avant** ce remplacement décrit une
   * période sans lui, et se ranger dans le cache lui ferait ravaler le bloc qu'on
   * vient de déplacer.
   */
  const replaceAppointment = useCallback(
    (key: string, appointmentId: string, next: Appointment): void => {
      cacheAge.current += 1;
      inFlight.current.clear();
      setPeriods((known) => {
        const current = known.get(key);

        if (current === undefined) {
          return known;
        }

        return new Map(known).set(
          key,
          current.map((item) => (item.id === appointmentId ? next : item)),
        );
      });
    },
    [],
  );

  /**
   * Envoie le report, puis range ce que le serveur en dit.
   *
   * Au succès, ce n'est **pas** le rendez-vous optimiste qui reste : le report
   * rend un rendez-vous neuf, d'identifiant neuf, que `rescheduled_from_id` relie
   * à celui qu'il remplace (booking-engine §5). L'écran range celui-là.
   *
   * Au refus, le bloc reprend sa place et la bannière dit pourquoi — le troisième
   * critère du ticket. Une session expirée s'y ajoute d'un renouvellement : sans
   * lui, le retour arrière serait juste et l'opérateur ne saurait pas quoi en
   * faire.
   */
  const commitMove = useCallback(
    async (move: DeskMove, key: string): Promise<void> => {
      setMoving({ move, key });

      const result = await rescheduleDeskAppointmentAction(
        tenantSlug,
        move.previous.id,
        move.request,
      );

      setMoving(null);

      if (result.ok) {
        replaceAppointment(key, move.previous.id, result.data);
        return;
      }

      replaceAppointment(key, move.previous.id, move.previous);
      setRefusal({
        notice: moveRefusal(move.previous, timeZone, result.code, result.message),
        appointmentId: move.previous.id,
      });

      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        renewSession();
      }
    },
    [tenantSlug, timeZone, replaceAppointment, renewSession],
  );

  /**
   * Le lâcher : l'état optimiste d'abord, la question ensuite s'il y en a une.
   *
   * Un report déjà en vol ou une confirmation en attente **bloquent** le suivant.
   * Deux états optimistes concurrents sur la même période ne se démêleraient pas
   * au retour arrière — le second replacerait le rendez-vous là où le premier
   * l'avait mis, et non là où il était.
   */
  const dropOn = useCallback(
    (appointment: Appointment, target: DeskMoveTarget): void => {
      setPicked(null);

      if (moving !== null || confirming !== null) {
        return;
      }

      const move = planDeskMove(appointment, target, timeZone);

      if (move === null) {
        return;
      }

      const key = currentKeyRef.current;

      setRefusal(null);
      replaceAppointment(key, move.previous.id, move.optimistic);

      if (move.changesStaff) {
        setConfirming({ move, key });
        return;
      }

      void commitMove(move, key);
    },
    [moving, confirming, timeZone, replaceAppointment, commitMove],
  );

  /** Échap repose le rendez-vous saisi à la poignée, sans rien déplacer. */
  useEffect(() => {
    if (picked === null) {
      return undefined;
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPicked(null);
      }
    };

    globalThis.addEventListener('keydown', onKey);

    return () => {
      globalThis.removeEventListener('keydown', onKey);
    };
  }, [picked]);

  /**
   * Changer de période repose ce qui n'y a plus de sens (#51).
   *
   * Un rendez-vous saisi n'est plus à l'écran une fois la journée tournée : le
   * garder saisi ferait d'un créneau de la période suivante une cible de dépôt
   * pour un bloc qui n'y est pas, et le lâcher partirait à l'API sans que rien
   * ne bouge — `replaceAppointment` ne trouverait le rendez-vous dans aucune des
   * deux périodes, l'ancienne resterait périmée dans le cache.
   *
   * La bannière de retour arrière parle d'une heure de la période qu'on vient de
   * quitter : elle s'en va avec elle. Et la question de changement de praticien
   * se **replace**, comme un refus — rien n'est parti vers le serveur, et une
   * question posée au-dessus d'un planning qui n'est plus le sien ne peut pas se
   * répondre en connaissance de cause.
   */
  useEffect(() => {
    setPicked(null);
    setRefusal(null);

    const pending = confirmingRef.current;

    if (pending !== null) {
      setConfirming(null);
      replaceAppointment(pending.key, pending.move.previous.id, pending.move.previous);
    }
  }, [currentKey, replaceAppointment]);

  // Un report en vol ou une question en attente **bloquent** le suivant
  // (`dropOn`). La saisie se ferme donc aussi : sans cela les créneaux libres
  // s'annonceraient comme des cibles — `--drop`, « déplacer ici le rendez-vous
  // de X » — pour un lâcher dont on sait déjà qu'il ne fera rien.
  const busy = moving !== null || confirming !== null;

  const drag: CalendarDragState = useMemo(
    () => ({
      picked: busy ? null : picked,
      movingId: moving?.move.previous.id ?? null,
      revertedId: refusal?.appointmentId ?? null,
      onToggle: (appointment: Appointment) => {
        if (busy) {
          return;
        }

        setPicked((current) => (current?.id === appointment.id ? null : appointment));
      },
      onPick: (appointment: Appointment) => {
        if (busy) {
          return;
        }

        setPicked(appointment);
      },
      onRelease: () => {
        setPicked(null);
      },
      onDrop: dropOn,
    }),
    [busy, picked, moving, refusal, dropOn],
  );

  // L'URL suit la période affichée, sans repasser par le serveur : le planning
  // se partage et survit à un rafraîchissement, mais changer de jour ne rejoue
  // pas le rendu d'un écran dont seul le contenu des colonnes change.
  //
  // C'est aussi ce qui rend le retour de renouvellement exact : la barre
  // d'adresse porte déjà la vue et la date, et `renewSession` n'a qu'à les
  // reprendre.
  useEffect(() => {
    globalThis.history.replaceState(null, '', currentPath);
  }, [currentPath]);

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

      {refusal === null ? null : (
        <Notification tone={refusal.notice.tone} title={refusal.notice.title}>
          <p>{refusal.notice.body}</p>
        </Notification>
      )}

      {confirming === null ? null : (
        <CalendarMoveConfirm
          move={confirming.move}
          onCancel={() => {
            // Refuser replace le rendez-vous exactement comme le ferait un 409 :
            // c'est le même retour arrière, par le même chemin. Sans bannière —
            // l'opérateur vient de dire non, il sait pourquoi.
            const { move, key } = confirming;

            setConfirming(null);
            replaceAppointment(key, move.previous.id, move.previous);
          }}
          onConfirm={() => {
            const { move, key } = confirming;

            setConfirming(null);
            void commitMove(move, key);
          }}
          timeZone={timeZone}
        />
      )}

      {/* Ce que le clavier et les lecteurs d'écran suivent d'un report en cours :
          le glisser-déposer n'annonce rien de lui-même, et la poignée serait
          muette sans cette ligne. */}
      <p aria-live="polite" className="spa-visually-hidden">
        {picked === null
          ? moving === null
            ? ''
            : 'Report en cours…'
          : `${picked.client.firstName} ${picked.client.lastName} est saisi : choisissez un créneau libre, ou Échap pour reposer.`}
      </p>

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
                    drag={drag}
                    key={column.id}
                    onOpen={setTarget}
                    slotCount={board.slotCount}
                    visible={visible}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {target === null ? null : (
        // La `key` est ce qui remonte le tiroir quand on clique un autre créneau
        // sans l'avoir refermé : sa saisie vit dans des `useState` amorcés au
        // montage, et sans elle React réutiliserait l'instance — le titre
        // suivrait la nouvelle cible, mais la date, l'heure, le praticien et la
        // note resteraient ceux de l'ancienne. « Enregistrer » déplacerait alors
        // le rendez-vous qu'on vient d'ouvrir à l'heure de celui d'avant.
        <AppointmentPanel
          key={
            target.kind === 'create'
              ? `create:${target.day}:${target.time}:${target.staffId ?? ''}`
              : `edit:${target.appointment.id}`
          }
          onClose={() => {
            setTarget(null);
          }}
          onExpired={renewSession}
          onReload={reloadPeriods}
          services={services}
          target={target}
          tenantSlug={tenantSlug}
          timeZone={timeZone}
        />
      )}
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
  drag,
  onOpen,
  slotCount,
  visible,
}: {
  readonly column: CalendarColumn;
  readonly drag: CalendarDragState;
  readonly onOpen: (target: DeskTarget) => void;
  readonly slotCount: number;
  readonly visible: SlotWindow;
}) {
  const mounted = cellsInWindow(column.cells, visible);
  // Le praticien de la colonne, nom compris : le lâcher en a besoin pour dire
  // « de Hasina à Tiana » sans une requête de plus. `null` en vue semaine, où la
  // colonne est une journée de toute l'équipe.
  const staff = column.staffId === null ? null : { id: column.staffId, displayName: column.name };

  return (
    <ul
      className="spa-admin-calendar__column"
      aria-labelledby={column.id}
      {...(column.laneCount > 1
        ? { style: { gridTemplateColumns: `repeat(${String(column.laneCount)}, minmax(0, 1fr))` } }
        : {})}
    >
      {mounted.map((cell) => (
        <CalendarCellView
          cell={cell}
          drag={drag}
          key={cell.key}
          laneCount={column.laneCount}
          onOpen={onOpen}
          staff={staff}
        />
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
  drag,
  laneCount,
  onOpen,
  staff,
}: {
  readonly cell: CalendarCell;
  readonly drag: CalendarDragState;
  readonly laneCount: number;
  readonly onOpen: (target: DeskTarget) => void;
  /** Praticien de la colonne — `null` en vue semaine, où elle vaut pour l'équipe. */
  readonly staff: Appointment['staff'] | null;
}) {
  const placement = {
    gridRow: `${String(cell.slot + 1)} / span ${String(cell.span)}`,
    gridColumn: cell.kind === 'event' ? String(cell.lane + 1) : `1 / span ${String(laneCount)}`,
  };

  if (cell.kind === 'free') {
    const dropping = drag.picked;
    // Le créneau porte déjà sa journée et son heure civiles, converties une fois
    // avec le fuseau du salon (`calendar-grid.ts`) : ni le tiroir ni le report
    // n'ont à recalculer, et surtout pas à reconvertir avec celui du navigateur.
    const spot: DeskMoveTarget = { day: cell.day, time: cell.time, staff };

    return (
      <li className="spa-admin-calendar__cell" style={placement}>
        <button
          className={[
            'spa-admin-calendar__slot',
            cell.nowOffset === null ? null : 'spa-admin-calendar__slot--now',
            dropping === null ? null : 'spa-admin-calendar__slot--drop',
          ]
            .filter((name) => name !== null)
            .join(' ')}
          type="button"
          onClick={() => {
            // Un rendez-vous saisi à la poignée se lâche par un clic ou une
            // touche sur le créneau visé : c'est le chemin clavier du glissement,
            // et il passe par le même `onDrop`.
            if (dropping !== null) {
              drag.onDrop(dropping, spot);
              return;
            }

            onOpen({ kind: 'create', day: cell.day, time: cell.time, staffId: staff?.id ?? null });
          }}
          onDragOver={(event) => {
            // Sans ce `preventDefault`, aucun lâcher n'est permis : c'est la
            // façon dont l'API HTML5 déclare une zone de dépôt.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(event) => {
            event.preventDefault();

            if (dropping !== null) {
              drag.onDrop(dropping, spot);
            }
          }}
          {...(cell.nowOffset === null
            ? {}
            : { style: { '--now-offset': cell.nowOffset } as Record<string, string> })}
        >
          <span className="spa-visually-hidden">
            {cell.timeLabel}
            {cell.nowOffset === null ? ', libre' : ', libre, heure courante'}
            {/* « à partir de cette heure », et non « à cette heure » : la rangée
                de la grille n'est pas un créneau du moteur, et le tiroir
                proposera le premier créneau réel qui la suit (#611). Promettre
                l'heure exacte était le mensonge que la campagne de QA a relevé —
                six refus au comptoir sur une journée entièrement libre. */}
            {dropping === null
              ? ' — poser un rendez-vous à partir de cette heure'
              : ` — déplacer ici le rendez-vous de ${dropping.client.firstName} ${dropping.client.lastName}`}
          </span>
        </button>
      </li>
    );
  }

  const appointment = cell.appointment;
  const status = appointment.status;
  // Un rendez-vous soldé — honoré, annulé, non présenté — ne se déplace plus : le
  // serveur le refuserait en `INVALID_STATE_TRANSITION`, et une poignée qui mène
  // à un refus est une poignée qui ment. Même règle que le pied du tiroir.
  const movable = isReschedulable(status);
  const held = drag.picked?.id === appointment.id;
  const inFlight = drag.movingId === appointment.id;

  return (
    <li className="spa-admin-calendar__cell" style={placement}>
      <button
        aria-busy={inFlight}
        className={[
          'spa-admin-calendar__event',
          `spa-admin-calendar__event--${statusModifier(status)}`,
          held ? 'spa-admin-calendar__event--picked' : null,
          inFlight ? 'spa-admin-calendar__event--moving' : null,
          drag.revertedId === appointment.id ? 'spa-admin-calendar__event--reverted' : null,
        ]
          .filter((name) => name !== null)
          .join(' ')}
        draggable={movable}
        type="button"
        onClick={() => {
          onOpen({ kind: 'edit', appointment });
        }}
        onDragStart={(event) => {
          // Le transfert porte l'identifiant pour la forme — Firefox refuse de
          // démarrer un glissement dont aucune donnée n'est posée —, mais ce
          // n'est pas lui qui désigne la source : le lâcher lit l'état React, qui
          // porte le rendez-vous entier.
          event.dataTransfer.setData('text/plain', appointment.id);
          event.dataTransfer.effectAllowed = 'move';
          drag.onPick(appointment);
        }}
        onDragEnd={() => {
          drag.onRelease();
        }}
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

      {/* La poignée est un frère du bloc, jamais son enfant : un bouton dans un
          bouton n'est pas du HTML valide, et le clavier n'atteindrait pas le
          second. C'est le CSS qui la pose dans le coin du bloc. */}
      {movable ? (
        <button
          aria-pressed={held}
          className="spa-admin-calendar__grip"
          type="button"
          onClick={() => {
            drag.onToggle(appointment);
          }}
        >
          <span aria-hidden="true">⠿</span>
          <span className="spa-visually-hidden">Déplacer {cell.clientLabel}</span>
        </button>
      ) : null}
    </li>
  );
}
