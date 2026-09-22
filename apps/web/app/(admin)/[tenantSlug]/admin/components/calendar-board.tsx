'use client';

import type {
  Appointment,
  OpeningHoursEntry,
  Service,
  StaffMemberSummary,
  TimeZone,
} from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppointmentFeed } from '@/components/live/appointment-feed';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  deskMoment,
  isReschedulable,
  isSlotConflict,
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
  weekStartOf,
  type CalendarView,
} from '@/lib/admin/calendar-range';
import { calendarPeriodEmptyState, calendarStartState } from '@/lib/admin/calendar-start';
import { appointmentOutcomeLabel, appointmentStatusLabels } from '@/lib/appointment-status';
import type { DisplayLocale } from '@/lib/format';
import { initialsOf } from '@/lib/initials';

import type { AdminActionResult } from '../action-result';
import { loadCalendarRangeAction, rescheduleDeskAppointmentAction } from '../calendrier/actions';
import { adminCalendarPath, adminCatalogPath } from '../paths';
import { adminStaffPath } from '../personnel/paths';

import { AppointmentPanel, type DeskTarget } from './appointment-panel';
import { CalendarMoveConfirm } from './calendar-move-confirm';
import { PeriodNav } from './period-nav';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

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
 *
 * ## Deux calques, et non un seul (#753)
 *
 * Un rendez-vous soldé — honoré, annulé, non présenté — n'occupe plus son
 * créneau : le tableau du cycle de vie le dit statut par statut, la contrainte
 * d'exclusion l'exclut de son prédicat partiel, et le calcul des créneaux libres
 * ne retranche que les `pending` et les `confirmed` (booking-engine §1, §3, §5).
 * La grille émet donc des **cellules libres sous lui**, et le soldé n'est plus
 * qu'un repère (`CalendarGhostCell`) : `styles/admin/calendar.css` laisse la
 * cellule passer les clics et ne les rend qu'au repère lui-même.
 *
 * Ce que cela rend au comptoir : reposer un client sur une heure annulée, ce que
 * l'agenda interdisait alors que le moteur l'acceptait. Ce que cela préserve :
 * le rendez-vous annulé reste à l'écran, à son heure, et sa fiche s'ouvre d'un
 * clic — il explique le trou dans la journée.
 *
 * ## Un seul état vide pour les deux vues (#758)
 *
 * Le basculement vers l'état vide se décide sur l'**établissement**, jamais sur
 * la vue ni sur la période : voir `hasNothingToPlan`. Tant qu'il se décidait sur
 * le nombre de colonnes, la même donnée donnait deux écrans opposés — la journée
 * expliquait ce qui manque, la semaine offrait sept colonnes de créneaux sans
 * un mot. Toute condition ajoutée ici doit rester vraie dans les deux vues.
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
  /**
   * Les deux listes ci-dessus ont bien été lues (#751).
   *
   * Elles arrivent vides pour deux raisons opposées — un salon qui n'a rien
   * créé, ou une API qui n'a pas répondu (`calendrier/page.tsx` retombe sur une
   * liste vide plutôt que de fermer l'agenda) — et l'état vide ne doit
   * diagnostiquer l'installation du salon que dans le premier cas. `false`, il
   * reprend son énoncé neutre : la période est creuse, allez voir la suivante.
   *
   * Facultatif, et vrai par défaut : les écrans qui n'ont qu'un catalogue à
   * passer n'ont pas à répondre d'une question qu'ils ne se posent pas.
   */
  readonly setupKnown?: boolean;
  /**
   * Les heures que l'établissement annonce ouvrir (#752).
   *
   * Lues sur la vitrine publique que la page consulte déjà pour son fuseau. Les
   * rangées qu'elles ne couvrent pas cessent d'être des créneaux libres : elles
   * deviennent le fond inactif nommé de la maquette — « Fermé », « Pause »,
   * « Hors horaires » —, ni cliquable, ni cible de dépôt. Ce que l'agenda
   * présente comme réservable redevient ce que le moteur sait honorer.
   *
   * Facultatif, et **vide par défaut** : sans horaires connus, le planning garde
   * son comportement d'avant ce ticket plutôt que de peindre une semaine close.
   */
  readonly openingHours?: readonly OpeningHoursEntry[];
  /**
   * Le pays de l'établissement — `Tenant.countryCode`, lu sur la vitrine
   * publique (#848).
   *
   * Il décide de deux choses, et d'aucune autre : la **région** des formats de
   * date, et le **jour qui ouvre la semaine**. Ni l'une ni l'autre n'est la
   * langue de qui regarde — un salon de Boston tient son planning du dimanche au
   * samedi, y compris consulté en français —, et ni l'une ni l'autre ne touche
   * au fuseau, qui reste celui du salon.
   */
  readonly countryCode?: string | null;
}

/** Rafraîchissement du trait d'heure courante — sa résolution est la minute. */
const NOW_REFRESH_MS = 60_000;

/**
 * Le repli d'horaires inconnus, hissé hors du composant.
 *
 * Un `[]` littéral en valeur par défaut serait une référence neuve à chaque
 * rendu, et le `useMemo` qui construit la grille se rejouerait à chaque fois —
 * sur l'écran dont la virtualisation existe précisément pour éviter ce coût.
 */
const EMPTY_OPENING_HOURS: readonly OpeningHoursEntry[] = [];

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
  setupKnown = true,
  openingHours = EMPTY_OPENING_HOURS,
  countryCode = null,
}: CalendarBoardProps) {
  const t = useTranslations('admin-planning');
  const locale = useLocale();
  const display: DisplayLocale = useMemo(() => ({ locale, countryCode }), [locale, countryCode]);
  /** Le jour qui ouvre la semaine — celui de la région du salon (#848). */
  const weekStart = useMemo(() => weekStartOf(countryCode), [countryCode]);
  const { renew } = useAdminSessionRenewal(tenantSlug);
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
  // Le contrôle qui a ouvert le tiroir — le créneau libre ou le bloc cliqué. Le
  // focus y retourne à la fermeture : sans lui, Échap laisserait le curseur sur
  // le `<body>` et l'opératrice au clavier repartirait du haut de la page (#617).
  const openerRef = useRef<HTMLElement | null>(null);
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

  const currentKey = rangeKey(view, date, weekStart);
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
   * Le départ passe par le helper commun des écrans (#856), qui dit pourquoi
   * `replace` et pourquoi ce chemin ne boucle pas. Le planning ne lui laisse
   * pas lire la barre d'adresse : c'est la période **regardée** qui doit être
   * rendue, et l'effet qui l'écrit dans l'URL peut ne pas avoir encore joué.
   */
  const renewSession = useCallback((): void => {
    renew(currentPathRef.current);
  }, [renew]);

  const board = useMemo(
    () =>
      buildCalendarBoard({
        view,
        range: rangeOf(view, date, weekStart),
        appointments: appointments ?? [],
        staff,
        openingHours,
        timeZone,
        display,
        ...(now === null ? {} : { now }),
      }),
    [view, date, weekStart, appointments, staff, openingHours, timeZone, display, now],
  );

  // Une période qu'on n'a pas encore n'est pas une période vide : dire « aucun
  // rendez-vous » pendant l'aller-retour affirmerait un planning libre là où on
  // ne sait rien encore, et c'est exactement l'écran sur lequel le comptoir
  // décide de poser un client.
  const isPending = appointments === undefined && loading;

  /**
   * Ce que l'état vide dit, et ce qu'il propose (#751).
   *
   * Un planning sans agenda n'est presque jamais une journée creuse : depuis
   * #507 la vue jour ouvre une colonne par praticien du répertoire, si bien
   * qu'il n'y reste que le salon qui n'a **aucune** fiche. Lui conseiller le
   * lendemain était un cul-de-sac — il est vide à l'identique, indéfiniment.
   * C'est le module qui tranche, sur les deux seuls comptes qui décident.
   *
   * Encore faut-il que ces comptes veuillent dire quelque chose : un catalogue
   * ou un répertoire que l'API n'a pas rendus arrivent vides eux aussi, et le
   * diagnostic annoncerait alors à un salon installé qu'il ne l'est pas. Tant
   * qu'un doute subsiste — `setupKnown` faux, ou la période elle-même en échec —
   * l'écran reprend son énoncé neutre et son bouton de période.
   */
  const start = useMemo(
    () =>
      setupKnown && failure === null
        ? calendarStartState(
            { serviceCount: services.length, staffCount: staff.length },
            { catalog: adminCatalogPath(tenantSlug), staff: adminStaffPath(tenantSlug) },
            locale,
          )
        : calendarPeriodEmptyState(locale),
    [setupKnown, failure, services.length, staff.length, tenantSlug, locale],
  );

  // Aucune colonne à rendre : il n'y a littéralement rien à dessiner, et la
  // grille — donc le conteneur mesuré — ne doit pas être montée. C'est un cas
  // de la seule **vue jour** : la vue semaine a toujours ses sept journées, et
  // c'est bien là qu'était le défaut.
  const hasNoColumn = board.columns.length === 0;
  /**
   * Rien à montrer, et rien pour l'accueillir (#758).
   *
   * L'état vide se décidait sur le nombre de **colonnes**, qui dépend de la vue :
   * une par praticien en vue jour — donc zéro dans un salon sans fiche —, une par
   * journée en vue semaine — donc sept, toujours. Sur la même donnée et le même
   * établissement neuf, la journée rendait son bloc « ce salon n'est pas encore
   * installé » quand la semaine rendait une grille pleine de créneaux offerts,
   * sans un mot d'explication, dont les cent soixante-huit boutons menaient tous
   * au même cul-de-sac. Un même écran, deux vues, deux modèles mentaux — et un
   * état vide sans explication ni issue, ce que
   * `docs/design/appointments/states.md` (« Règles générales ») interdit.
   *
   * Le verdict est donc repris sur l'**établissement**, qui ne change pas d'une
   * vue à l'autre : la période ne porte aucun rendez-vous, **et** le module a
   * nommé ce qui manque au salon pour en poser un — c'est exactement ce que
   * `start.links` porte, et rien d'autre ne le dit sans risque.
   *
   * Compter les fiches praticien ici serait tentant et faux : elles arrivent
   * vides aussi quand `GET /v1/staff` n'a pas répondu (`setupKnown` faux), et un
   * salon installé perdrait alors sa semaine entière de créneaux cliquables
   * parce qu'une liste annexe est tombée. `start.links` ne se remplit que
   * lorsque les comptes font foi ; dans le doute il reste vide, et l'écran garde
   * le comportement d'avant ce ticket — grille en semaine, repli sur
   * `hasNoColumn` en jour.
   *
   * Les deux conditions comptent, et la première protège la seconde : un salon
   * qui retire toutes ses prestations du catalogue garde des rendez-vous déjà
   * posés, et les masquer derrière une amorce d'installation les rendrait
   * introuvables depuis l'écran qui existe pour les montrer.
   */
  const hasNothingToPlan = board.appointmentCount === 0 && start.links.length > 0;
  const isEmpty = !isPending && (hasNoColumn || hasNothingToPlan);
  const showsGrid = !isPending && !isEmpty;

  /** Charge une période absente du cache, et la range dedans. */
  const load = useCallback(
    async (nextView: CalendarView, anchor: string, background: boolean): Promise<void> => {
      const key = rangeKey(nextView, anchor, weekStart);
      const age = cacheAge.current;
      // Une période déjà demandée ne repart pas — mais l'appel se **greffe** sur
      // la requête en cours au lieu d'abandonner. Abandonner laissait un clic
      // tombé pendant le préchargement de la même période sans indicateur, et
      // surtout sans message si ce préchargement échouait : l'opérateur voyait
      // un planning vide là où l'agenda n'avait simplement pas pu être lu.
      let pending = inFlight.current.get(key);
      const owned = pending === undefined;

      if (pending === undefined) {
        // Le jour d'ouverture part avec la requête : l'ancrage est déjà celui de
        // la région du salon, et l'action recalcule la plage à partir de lui.
        // Sans lui, un ancrage posé un dimanche serait ramené au lundi précédent
        // côté serveur, et la semaine chargée ne serait pas celle qu'on affiche.
        pending = loadCalendarRangeAction(tenantSlug, nextView, anchor, weekStart);
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
        setFailure(calendarFailureMessage(result.code, result.message, locale));
      }
    },
    [renewSession, tenantSlug, weekStart, locale],
  );

  /** Ouvre une période — depuis le cache si elle y est, sinon par l'action. */
  const openPeriod = useCallback(
    (nextView: CalendarView, rawDate: string): void => {
      const anchor = anchorOf(nextView, rawDate, weekStart);

      setView(nextView);
      setDate(anchor);

      if (periods.has(rangeKey(nextView, anchor, weekStart))) {
        // La période est déjà là et s'affiche : la bannière de celle qu'on vient
        // de quitter n'a plus rien à dire au-dessus d'un planning intact.
        setFailure(null);
        return;
      }

      void load(nextView, anchor, false);
    },
    [load, periods, weekStart],
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
  /**
   * Le retour arrière rendu lisible — troisième critère de #51, et **traduit**
   * depuis #848.
   *
   * La composition vit ici et non plus dans `lib/admin/appointment-desk.ts` :
   * elle assemble quatre phrases du catalogue, et un module de calcul pur n'a
   * pas de traducteur sous la main. Le **verdict**, lui, reste au module — c'est
   * `isSlotConflict` qui dit si le refus est passager, et lui seul.
   *
   * Ce que la bannière annonce n'a pas changé d'un mot : où le rendez-vous est
   * revenu, et pourquoi il n'a pas pu aller ailleurs. Le ton distingue le
   * passager du définitif — un créneau pris depuis un autre poste est le cas
   * normal de la concurrence (web-frontend §3), un autre horaire le lève.
   */
  const refusalOf = useCallback(
    (previous: Appointment, code: string, message: string): DeskMoveRefusal => {
      const transient = isSlotConflict(code);
      // `NOT_FOUND` et `HTTP_404` sont les deux façons dont un 404 remonte du
      // client d'API. Sur un report, ni l'un ni l'autre ne dit l'absence de
      // route — elle est servie depuis #464 : ils disent que le rendez-vous
      // qu'on vient de saisir n'est plus là.
      const gone = code === ERROR_CODES.NOT_FOUND || code === 'HTTP_404';
      const reason = transient
        ? t('move.conflictBody')
        : gone
          ? t('move.goneBody')
          : message;

      return {
        // « Indisponible » et non « déjà pris » : le titre est la première chose
        // que l'opératrice lit, et le refus ne donne pas sa cause (#611).
        title: transient ? t('move.conflictTitle') : t('move.refusedTitle'),
        // « Le rendez-vous de X est resté le … » plutôt que « X est resté au … » :
        // la phrase s'accorde sur le rendez-vous, et non sur une cliente dont le
        // contrat ne porte pas le genre.
        body: `${t('move.restored', {
          client: `${previous.client.firstName} ${previous.client.lastName}`,
          moment: deskMoment(previous.startsAt, timeZone, display),
          staff: previous.staff.displayName,
        })} ${reason}`,
        tone: transient ? 'warning' : 'danger',
      };
    },
    [t, timeZone, display],
  );

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
        notice: refusalOf(move.previous, result.code, result.message),
        appointmentId: move.previous.id,
      });

      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        renewSession();
      }
    },
    [tenantSlug, refusalOf, replaceAppointment, renewSession],
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

  /**
   * Ouvre le tiroir en retenant d'où on l'a ouvert (#617).
   *
   * Le tiroir est en surimpression depuis ce ticket : il ne se trouve plus en
   * faisant défiler la page, et le clavier doit donc être conduit — le focus y
   * entre à l'ouverture (`AppointmentPanel`) et revient ici à la fermeture.
   *
   * `document.activeElement` et non l'élément de l'événement : un clic souris
   * comme une validation au clavier laissent tous deux le focus sur le bouton
   * cliqué, et c'est ce contrôle-là — pas son conteneur — qu'il faut retrouver.
   * Le déclencheur est **remplacé** quand on ouvre un autre créneau sans avoir
   * refermé : c'est le dernier cliqué que l'opératrice cherche des yeux.
   */
  const openTarget = useCallback((next: DeskTarget): void => {
    const active = globalThis.document.activeElement;

    openerRef.current = active instanceof HTMLElement ? active : null;
    setTarget(next);
  }, []);

  /**
   * Le focus revient au déclencheur quand le tiroir se referme (#617).
   *
   * `isConnected` parce que le planning se relit après une écriture : le créneau
   * libre d'où l'on est parti peut avoir été remplacé par le bloc qu'on vient de
   * poser, et rendre le focus à un nœud détaché le renverrait au `<body>`.
   */
  useEffect(() => {
    if (target !== null) {
      return;
    }

    const opener = openerRef.current;

    openerRef.current = null;

    if (opener !== null && opener.isConnected) {
      opener.focus();
    }
  }, [target]);

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

  // Un changement signalé pendant un report en vol ou une question en attente,
  // que `refreshLive` a mis de côté — voir ci-dessous.
  const liveStale = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /**
   * Le planning temps réel : un rendez-vous vient de changer ailleurs — une
   * réservation en ligne, une collègue qui déplace ou solde, une cliente qui
   * annule. Le flux ne dit pas quoi (`components/live/appointment-feed.tsx`) :
   * la période affichée est relue.
   *
   * Pas `reloadPeriods`, qui vide l'écran le temps de l'aller-retour : sur un
   * planning ouvert toute la journée, chaque réservation ferait clignoter la
   * grille. La période affichée **reste** à l'écran et se remplace à l'arrivée
   * de la réponse ; les autres sont oubliées, et le préchargement relit les
   * voisines en arrière-plan.
   *
   * Et pas pendant un report en vol ou une question en attente : l'état
   * optimiste serait écrasé par un agenda qui ne le contient pas encore, et le
   * bloc qu'on vient de lâcher sauterait en arrière. Le changement est mis de
   * côté, et relu dès que le geste est tranché.
   */
  const refreshLive = useCallback((): void => {
    if (busyRef.current) {
      liveStale.current = true;
      return;
    }

    liveStale.current = false;
    cacheAge.current += 1;
    inFlight.current.clear();

    const key = currentKeyRef.current;

    setPeriods((known) => {
      const shown = known.get(key);

      return shown === undefined ? new Map() : new Map([[key, shown]]);
    });
    void load(view, date, true);
  }, [load, view, date]);

  useAppointmentFeed(() => {
    refreshLive();
  });

  useEffect(() => {
    if (!busy && liveStale.current) {
      refreshLive();
    }
  }, [busy, refreshLive]);

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
      const anchor = shiftAnchor(view, date, step, weekStart);

      if (!periods.has(rangeKey(view, anchor, weekStart))) {
        void load(view, anchor, true);
      }
    }
  }, [view, date, weekStart, periods, load]);

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
        {/* La barre de période est partagée avec l'encaissement (#629) : c'est
         * le même geste, il se rend au même endroit. Ici les contrôles sont des
         * gestes et non des liens — la période voisine est déjà en cache, et la
         * faire repasser par le serveur annulerait ce préchargement. */}
        <PeriodNav
          label={rangeLabel(view, date, display, weekStart)}
          next={{
            onSelect: () => {
              openPeriod(view, shiftAnchor(view, date, 1, weekStart));
            },
          }}
          nextLabel={view === 'jour' ? t('toolbar.nextDay') : t('toolbar.nextWeek')}
          previous={{
            onSelect: () => {
              openPeriod(view, shiftAnchor(view, date, -1, weekStart));
            },
          }}
          previousLabel={view === 'jour' ? t('toolbar.previousDay') : t('toolbar.previousWeek')}
          today={{
            onSelect: () => {
              openPeriod(view, todayInTimeZone(timeZone));
            },
          }}
        />

        <fieldset className="spa-admin-segmented">
          <legend className="spa-visually-hidden">{t('toolbar.viewLegend')}</legend>
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
            {t('toolbar.day')}
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
            {t('toolbar.week')}
          </label>
        </fieldset>

        <div className="spa-admin-toolbar__group spa-admin-toolbar__spacer">
          <span className="spa-admin-toolbar__hint">{t('toolbar.timeZone', { timeZone })}</span>
        </div>
      </div>

      {failure === null ? null : (
        <Notification tone="danger" title={t('failure.title')}>
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
          display={display}
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
            : t('board.moving')
          : t('board.picked', {
              client: `${picked.client.firstName} ${picked.client.lastName}`,
            })}
      </p>

      <div className={classes} aria-busy={loading}>
        {loading ? <p className="spa-visually-hidden">{t('board.loading')}</p> : null}

        <div className="spa-admin-calendar__legend">
          {/* La légende décrit les cinq **statuts**, sans les raconter : elle dit
              ce que chaque couleur veut dire, pas ce qu'un rendez-vous précis est
              devenu. C'est la seule surface du planning qui lise la table brute
              plutôt qu'`appointmentOutcomeLabel` (#917). */}
          {(
            Object.entries(appointmentStatusLabels(locale)) as [
              keyof ReturnType<typeof appointmentStatusLabels>,
              string,
            ][]
          ).map(([status, label]) => (
            <span
              className={`spa-admin-badge spa-admin-badge--${statusModifier(status)}`}
              key={status}
            >
              {label}
            </span>
          ))}
        </div>

        <div className="spa-admin-calendar__head">
          <div className="spa-admin-calendar__head-spacer" />
          {!showsGrid ? (
            <div className="spa-admin-calendar__column-head">
              <span className="spa-admin-calendar__column-name">
                {rangeLabel(view, date, display, weekStart)}
              </span>
              <span className="spa-admin-calendar__column-meta">
                {isPending ? t('board.columnLoading') : t('board.columnEmpty')}
              </span>
            </div>
          ) : (
            board.columns.map((column) => (
              <div className="spa-admin-calendar__column-head" id={column.id} key={column.id}>
                {/* En vue jour, une colonne est un praticien : ses initiales le
                    repèrent d'un coup d'œil. En vue semaine, c'est un jour. */}
                {view === 'jour' ? (
                  <span aria-hidden="true" className="spa-admin-calendar__column-avatar">
                    {initialsOf(column.name)}
                  </span>
                ) : null}
                <span className="spa-admin-calendar__column-text">
                  <span className="spa-admin-calendar__column-name">{column.name}</span>
                  <span className="spa-admin-calendar__column-meta">{column.meta}</span>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="spa-admin-calendar__body">
          {isPending ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">{t('board.loadingTitle')}</p>
              <p className="spa-empty-state__description">{t('board.loadingDescription')}</p>
            </div>
          ) : isEmpty ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">{start.title}</p>
              <p className="spa-empty-state__description">{start.description}</p>
              {start.links.length === 0 ? (
                // Rien ne manque au salon : la période est vraiment creuse, et
                // changer de période est alors le bon conseil.
                <Button
                  variant="neutral"
                  onClick={() => {
                    openPeriod(view, shiftAnchor(view, date, 1, weekStart));
                  }}
                >
                  {view === 'jour' ? t('board.goNextDay') : t('board.goNextWeek')}
                </Button>
              ) : (
                // Des liens et non des boutons : ce sont des destinations, elles
                // s'ouvrent dans un onglet et se copient. Le premier porte
                // l'accent — c'est par là qu'on commence.
                //
                // Empilés directement dans `.spa-empty-state`, sans conteneur :
                // c'est déjà une colonne centrée avec son écart, et une classe de
                // rangée propre au planning devrait être montrée par une maquette
                // pour ne pas devenir du style mort (`tests/admin-mockups.test.mjs`).
                start.links.map((link, index) => (
                  <Link
                    className={`spa-button spa-button--${index === 0 ? 'accent' : 'neutral'}`}
                    href={link.href}
                    key={link.key}
                  >
                    <span className="spa-button__label">{link.label}</span>
                  </Link>
                ))
              )}
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
                    onOpen={openTarget}
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
          countryCode={countryCode}
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
          seules rangées visibles et le défilement s'arrêterait à mi-journée.

          Sa colonne est dite, et ne se devine plus : sans `gridColumn`, elle
          était placée d'office là où la dernière rangée était libre — c'est-à
          -dire dans une piste **implicite** de plus dès que cette rangée était
          occupée, ce qui rétrécissait d'autant les cellules de la journée. Et
          elle ne capte rien : ainsi posée sur la dernière rangée, elle
          recouvrirait sinon le créneau qui s'y trouve. */}
      <li
        aria-hidden="true"
        className="spa-admin-calendar__cell"
        style={{
          gridRow: `${String(slotCount)} / span 1`,
          gridColumn: '1 / -1',
          pointerEvents: 'none',
        }}
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
  // Les crochets sont appelés ici plutôt que passés de proche en proche :
  // `next-intl` mémoïse le traducteur sur le contexte de la requête, si bien
  // qu'une cellule n'en monte pas un de plus — et une grille en compte plusieurs
  // centaines en vue semaine.
  const t = useTranslations('admin-planning');
  const locale = useLocale();
  const placement = {
    gridRow: `${String(cell.slot + 1)} / span ${String(cell.span)}`,
    gridColumn: cell.kind === 'event' ? String(cell.lane + 1) : `1 / span ${String(laneCount)}`,
  };

  if (cell.kind === 'closed') {
    // Ni bouton, ni cible de dépôt : le salon ne travaille pas cette rangée, et
    // le moteur refuserait le rendez-vous qu'on y poserait. Un `<div>` inerte
    // dans la cellule — c'est le balisage que la maquette du planning montre
    // depuis #30 (`mockups/admin/calendrier.html`), et il retire d'un même geste
    // le clic vers le tiroir et le lâcher du glisser-déposer.
    return (
      <li className="spa-admin-calendar__cell" style={placement}>
        <div
          className={[
            'spa-admin-calendar__blocked',
            cell.nowOffset === null ? null : 'spa-admin-calendar__blocked--now',
          ]
            .filter((name) => name !== null)
            .join(' ')}
          {...(cell.nowOffset === null
            ? {}
            : { style: { '--now-offset': cell.nowOffset } as Record<string, string> })}
        >
          <span className="spa-admin-calendar__blocked-label">{cell.label}</span>
          {/* Le trait d'heure courante traverse aussi les fermetures — midi, le
              soir, un dimanche entier. Sans cette annonce, il ne serait visible
              que des voyants. */}
          {cell.nowOffset === null ? null : (
            <span className="spa-visually-hidden">{t('grid.currentTime')}</span>
          )}
        </div>
      </li>
    );
  }

  if (cell.kind === 'ghost') {
    // Un rendez-vous soldé n'occupe plus son créneau (booking-engine §5) : la
    // grille a émis des cellules libres sous lui, et c'est à elles que doivent
    // aller les clics. Le repère ne garde donc que sa propre surface — le `<li>`
    // laisse tout passer, le bouton seul reprend la main. Sans cela, la cellule
    // de la grille recouvrirait le créneau libre sur toute la durée du soin
    // annulé, et le comptoir ne pourrait toujours rien y poser (#753).
    const settled = cell.appointment;

    return (
      <li className="spa-admin-calendar__cell spa-admin-calendar__cell--ghost" style={placement}>
        <div
          className={[
            'spa-admin-calendar__event',
            `spa-admin-calendar__event--${statusModifier(settled.status)}`,
            'spa-admin-calendar__event--ghost',
          ].join(' ')}
          style={
            {
              // Les couloirs d'un calque qui en compte plusieurs ne rétrécissent
              // que les repères — jamais un rendez-vous vivant, ni la cellule
              // libre, qui garde toute la largeur de la colonne.
              '--ghost-lane': String(cell.lane),
              '--ghost-lanes': String(cell.laneCount),
            } as Record<string, string>
          }
        >
          <span className="spa-admin-calendar__event-time">{cell.timeLabel}</span>
          <span className="spa-admin-calendar__event-client">{cell.clientLabel}</span>
          {cell.serviceLabel === null ? null : (
            <span className="spa-admin-calendar__event-service">{cell.serviceLabel}</span>
          )}
          {/* Ce que la couleur seule ne dit pas, et qui est le cœur du ticket :
              le créneau est de nouveau à prendre. Sans cette phrase, un écran
              lu au clavier verrait un rendez-vous et des créneaux libres au
              même endroit sans comprendre lequel des deux fait foi. */}
          <span className="spa-visually-hidden">
            {cell.detailLabel === null ? null : `${cell.detailLabel} `}
            {t('grid.status', { status: appointmentOutcomeLabel(settled, 'desk', locale) })}{' '}
            {t('grid.reopened')}
          </span>

          {/* La fiche s'ouvre par ce bouton-là, et non par le repère entier.
              Un repère pleine hauteur qui capterait le clic recouvrirait les
              créneaux libres rendus dessous sur toute la durée du soin annulé,
              et le constat de l'audit tiendrait toujours — la recette l'a
              montré. Même dispositif que la poignée de déplacement : un petit
              contrôle dans le coin, discret tant qu'on ne s'y intéresse pas. */}
          <button
            className="spa-admin-calendar__ghost-open"
            type="button"
            // Même infobulle que le bloc vivant (#762), mais portée par ce
            // contrôle-ci et non par le repère : le repère est
            // `pointer-events: none` sur toute sa surface — c'est ce qui rend
            // les créneaux libres de dessous cliquables (#753) —, il ne connaît
            // donc pas le survol et un `title` y resterait lettre morte. Le
            // coin « ⋯ » est le seul point du repère qui reçoit la souris.
            {...(cell.tooltip === null ? {} : { title: cell.tooltip })}
            onClick={() => {
              onOpen({ kind: 'edit', appointment: settled });
            }}
          >
            <span aria-hidden="true">⋯</span>
            <span className="spa-visually-hidden">
              {t('grid.openRecord', { client: cell.clientLabel, time: cell.timeLabel })}
            </span>
          </button>
        </div>
      </li>
    );
  }

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
            {cell.nowOffset === null ? t('grid.free') : t('grid.freeNow')}
            {/* « à partir de cette heure », et non « à cette heure » : la rangée
                de la grille n'est pas un créneau du moteur, et le tiroir
                proposera le premier créneau réel qui la suit (#611). Promettre
                l'heure exacte était le mensonge que la campagne de QA a relevé —
                six refus au comptoir sur une journée entièrement libre. */}
            {dropping === null
              ? t('grid.freeHint')
              : t('grid.dropHint', {
                  client: `${dropping.client.firstName} ${dropping.client.lastName}`,
                })}
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
        // L'infobulle de la vue semaine — le rendez-vous entier sous le curseur,
        // là où le bloc n'a la place que d'une heure et d'un nom abrégé (#762).
        // `null` en vue jour, où tout est déjà écrit : `title` y doublerait
        // l'annonce des lecteurs d'écran, qui le rendent en description.
        {...(cell.tooltip === null ? {} : { title: cell.tooltip })}
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
            jamais par la seule couleur de fond (WCAG 1.4.1). La prestation et le
            praticien l'y rejoignent en vue semaine, où rien ne les écrit — JSX
            mange le saut de ligne, d'où l'espace posé ici à la main (#762). */}
        <span className="spa-visually-hidden">
          {cell.detailLabel === null ? null : `${cell.detailLabel} `}
          {t('grid.status', { status: appointmentOutcomeLabel(appointment, 'desk', locale) })}
        </span>
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
          <span className="spa-visually-hidden">
            {t('grid.move', { client: cell.clientLabel })}
          </span>
        </button>
      ) : null}
    </li>
  );
}
