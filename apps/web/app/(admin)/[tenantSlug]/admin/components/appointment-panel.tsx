'use client';

import {
  ERROR_CODES,
  type Appointment,
  type AppointmentStatus,
  type CalendarDate,
  type CustomerSummary,
  // Aliasé : `Notification` est aussi le composant du design system que ce
  // fichier importe deux lignes plus bas.
  type Notification as NotificationTrace,
  type Service,
  type ServiceStaffMember,
  type TimeZone,
} from '@spa/shared';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  // Aliasé : `KeyboardEvent` est aussi le type global du DOM, et c'est bien
  // l'événement synthétique de React que le tiroir reçoit.
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { TextArea } from '@/components/ui/textarea';
import {
  DESK_NO_SLOT_MESSAGE,
  DESK_SLOTS_UNREADABLE_MESSAGE,
  deskFailureMessage,
  deskSlotOptions,
  deskStatusActions,
  isReschedulable,
  isSlotConflict,
  nearestDeskSlot,
  offsetDateTimeInTenant,
  summarize,
  tenantFields,
  type DeskSlotOption,
} from '@/lib/admin/appointment-desk';
import { STATUS_LABELS, statusModifier } from '@/lib/admin/calendar-grid';
import { parseCalendarDate } from '@/lib/admin/calendar-range';
import { formatMoney } from '@/lib/format';

import {
  createDeskAppointmentAction,
  loadAppointmentNotificationsAction,
  loadDeskAvailabilityAction,
  loadDeskServiceStaffAction,
  markDeskAppointmentStatusAction,
  rescheduleDeskAppointmentAction,
} from '../calendrier/actions';

import { ClientPicker } from './client-picker';
import { NotificationStatusList } from './notification-status-list';

/**
 * Le tiroir de rendez-vous du comptoir — création et édition (#50).
 *
 * ## Un seul écran pour les deux
 *
 * Création et édition ne diffèrent que par trois choses : le titre, le libellé du
 * bouton de validation, et la présence des actions de fin de course. Le reste —
 * la prestation, le praticien, la date, l'heure, le récapitulatif calculé — est
 * identique, et deux gabarits auraient divergé à la première correction. C'est
 * ce que `styles/admin/appointment.css` et la maquette
 * `mockups/admin/rendez-vous.html` posent, et ce composant s'y tient.
 *
 * ## Ce qui ne se saisit pas, et pourquoi
 *
 * Fin, durée, tampon et montant découlent de la prestation. Les rendre
 * saisissables laisserait poser une fin incohérente avec le début, donc un
 * chevauchement que la contrainte d'exclusion refuserait **après** la saisie —
 * trop tard pour l'opérateur qui a la cliente au téléphone.
 *
 * ## L'heure ne se saisit plus : elle se choisit (#611)
 *
 * L'API n'accepte que les créneaux que le moteur de disponibilité a lui-même
 * rendus, à l'instant près. Le planning, lui, dessine une grille de trente
 * minutes qui ne coïncide pas avec eux — un praticien qui ouvre à 07:10 n'a pas
 * un seul créneau à la minute 00. Un champ d'heure libre amorcé par la rangée
 * cliquée menait donc à un refus quoi qu'on y saisisse.
 *
 * Le tiroir lit donc les créneaux de la journée — prestation, praticien et date
 * retenus — et n'offre qu'eux. La rangée cliquée n'est plus une heure de
 * réservation mais une **intention** : le créneau réel le plus proche est
 * préselectionné, et l'opérateur en change dans la liste. Voir
 * `lib/admin/appointment-desk.ts`.
 *
 * La lecture peut échouer — c'est une lecture de plus, sur une route de plus. Le
 * sélecteur retombe alors sur la saisie libre d'avant, avec un avertissement :
 * une disponibilité illisible ne doit pas fermer le comptoir, et c'est l'API qui
 * juge le créneau de toute façon.
 *
 * ## Le créneau perdu n'est pas une panne
 *
 * Sous concurrence, un autre poste peut avoir pris le créneau pendant la saisie.
 * C'est le cas normal du quatrième critère (web-frontend §3) : le tiroir affiche
 * un avertissement, **demande le rechargement de la période** au planning, et ne
 * touche à aucune autre saisie. L'opérateur change l'heure et renvoie.
 *
 * Ce que l'avertissement ne fait plus, c'est **nommer la cause** : le 409 couvre
 * cinq refus différents et n'en distingue aucun (#611).
 *
 * ## Le tiroir s'ouvre DANS la fenêtre (#617)
 *
 * Il était rendu dans le flux, sous la grille — à 1 290 px du haut de page en
 * 1920 × 1080, soit 210 px sous la ligne de flottaison, et 480 px sous elle en
 * 1280 × 800. Ni défilement, ni déplacement du focus : l'opératrice cliquait un
 * créneau et voyait un écran rigoureusement identique.
 *
 * Il est donc posé en surimpression, ancré au bord de la fenêtre
 * (`.spa-admin-calendar__drawer`), et le clavier y est conduit : le focus entre
 * dans le tiroir à l'ouverture, Échap referme, et le planning rend le focus au
 * créneau cliqué (`calendar-board.tsx`).
 *
 * **En surimpression et non en modale**, et c'est le point : le planning reste
 * lisible ET manœuvrable pendant la saisie — c'est ce qui permet de proposer
 * « et à 15 h, ça vous irait ? » sans rien fermer, et c'est pour cela que le
 * tiroir reste un `<aside>`. Un `<dialog>` ouvert par `showModal()` rendrait la
 * grille inerte, donc interdirait de cliquer un autre créneau sans refermer —
 * un geste que ce composant sait faire (voir la `key` du tiroir, côté planning).
 * Aucun voile n'est posé pour la même raison : il avalerait ces clics-là.
 *
 * ## La prestation ne se change pas en édition
 *
 * `rescheduleAppointmentRequestSchema` n'accepte que `startsAt` et `staffId`, et
 * ce n'est pas un manque : le prix est **figé à la réservation**
 * (`appointmentSchema.price`), et la durée avec lui. Changer la prestation d'un
 * rendez-vous existant est donc une annulation suivie d'une nouvelle prise, pas
 * une modification — le champ reste visible, désactivé, avec sa raison.
 */

/** Ce qu'un clic sur le planning ouvre. */
export type DeskTarget =
  | {
      readonly kind: 'create';
      readonly day: CalendarDate;
      readonly time: string;
      /** Le praticien de la colonne cliquée — `null` en vue semaine. */
      readonly staffId: string | null;
    }
  | { readonly kind: 'edit'; readonly appointment: Appointment };

interface AppointmentPanelProps {
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
  /** Le catalogue, chargé une fois par la page — il ne change pas d'un clic à l'autre. */
  readonly services: readonly Service[];
  readonly target: DeskTarget;
  readonly onClose: () => void;
  /** Une écriture a abouti, ou un créneau a été perdu : la période est à relire. */
  readonly onReload: () => void;
  /** Session expirée — le planning la renouvelle et revient sur la période affichée. */
  readonly onExpired: () => void;
}

export function AppointmentPanel({
  tenantSlug,
  timeZone,
  services,
  target,
  onClose,
  onReload,
  onExpired,
}: AppointmentPanelProps) {
  const formId = useId();
  const editing = target.kind === 'edit' ? target.appointment : null;
  // La région du tiroir — c'est elle qui prend le focus à l'ouverture (#617).
  const drawerRef = useRef<HTMLElement | null>(null);

  // La fiche cliente n'est saisie qu'à la création : un report ne change pas de
  // cliente, et fabriquer ici un `CustomerSummary` à partir du résumé imbriqué du
  // rendez-vous — qui ne porte ni téléphone ni état d'activation — inventerait
  // deux champs que rien ne connaît.
  const [client, setClient] = useState<CustomerSummary | null>(null);
  const [serviceId, setServiceId] = useState<string>(
    editing?.service.id ?? services[0]?.id ?? '',
  );
  const [staffId, setStaffId] = useState<string>(
    editing?.staff.id ?? (target.kind === 'create' ? (target.staffId ?? '') : ''),
  );
  // L'amorce du formulaire : le créneau cliqué à la création, l'heure du
  // rendez-vous à l'édition — ramenée du stockage UTC au fuseau du salon, et
  // jamais à celui du navigateur.
  const opening =
    target.kind === 'create'
      ? { date: target.day, time: target.time }
      : tenantFields(target.appointment.startsAt, timeZone);
  const [day, setDay] = useState<CalendarDate>(opening.date);
  const [time, setTime] = useState<string>(opening.time);
  const [note, setNote] = useState<string>(editing?.clientNote ?? '');

  const [staff, setStaff] = useState<readonly ServiceStaffMember[] | null>(null);
  // Les créneaux réellement proposables de la journée retenue (#611). `null`
  // couvre les deux moments où il n'y a rien à offrir — pas encore lus, et pas
  // de prestation choisie — que le sélecteur distingue de la journée complète,
  // qui est une liste **vide**.
  const [slots, setSlots] = useState<readonly DeskSlotOption[] | null>(null);
  const [slotsFailure, setSlotsFailure] = useState<string | null>(null);
  // Un compteur, relu par l'effet de disponibilité : un créneau refusé par l'API
  // doit disparaître de la liste, sinon l'opératrice renvoie la même heure et
  // reçoit le même refus. Le planning se recharge déjà dans ce cas (`onReload`),
  // et le tiroir n'avait aucune raison de rester sur une liste périmée.
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Le journal d'envois du rendez-vous (#70). `null` couvre les deux cas où il
  // n'y a rien à montrer — pas encore lu, et création — que la section distingue
  // de l'échec de lecture.
  const [notifications, setNotifications] = useState<readonly NotificationTrace[] | null>(null);
  const [notificationsFailure, setNotificationsFailure] = useState<string | null>(null);

  // L'identifiant seul plutôt que l'objet en dépendance d'effet : `editing` est
  // une nouvelle référence à chaque rendu du parent, et l'effet rechargerait le
  // journal à chaque frappe dans le formulaire.
  const editingId = editing?.id ?? null;

  const service = services.find((candidate) => candidate.id === serviceId) ?? null;
  // La prestation d'un rendez-vous **posé** peut avoir quitté le catalogue actif
  // depuis : la page ne charge que les prestations vendables, et une prestation
  // retirée n'y est plus. Le rendez-vous, lui, porte son nom, sa durée et son
  // prix figés — c'est cette copie-là qui prend le relais, sans quoi l'écran
  // afficherait le nom d'une autre prestation dans le sélecteur désactivé et
  // escamoterait le montant dû.
  const booked = editing === null || service !== null ? null : editing.service;
  const summary =
    service !== null
      ? summarize(service, time)
      : booked === null
        ? null
        : summarize({ durationMinutes: booked.durationMinutes, bufferAfterMinutes: 0 }, time);
  // Le montant d'un rendez-vous **posé** est celui qui a été figé à la
  // réservation, pas celui du catalogue d'aujourd'hui : le tarif a pu changer
  // entre les deux, le montant dû par cette cliente-là, non
  // (`appointmentSchema.price`).
  const price = editing?.price ?? service?.price ?? null;

  // Les praticiens proposés sont **ceux qui tiennent la prestation choisie**, et
  // non l'équipe entière : en proposer d'autres ferait refuser la réservation
  // après la saisie. La liste se recharge donc à chaque changement de prestation.
  useEffect(() => {
    if (serviceId === '') {
      setStaff(null);
      return undefined;
    }

    let current = true;

    void loadDeskServiceStaffAction(tenantSlug, serviceId).then((result) => {
      if (!current) {
        return;
      }
      if (result.ok) {
        setStaff(result.data.staff.filter((member) => member.isActive));
        return;
      }
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }
      // L'affectation illisible ne bloque pas la saisie : le sélecteur retombe
      // sur « premier disponible », que le contrat autorise explicitement
      // (`createAppointmentRequestSchema.staffId` est facultatif).
      setStaff([]);
    });

    return () => {
      current = false;
    };
  }, [tenantSlug, serviceId, onExpired]);

  // Le journal d'envois du rendez-vous — cinquième critère de #70. Chargé une
  // fois à l'ouverture du tiroir : les messages d'une confirmation partent dans
  // la seconde qui suit la création, et rien dans cet écran ne les provoque.
  //
  // Rien à charger à la **création** : le rendez-vous n'existe pas encore, donc
  // aucun message n'a pu être émis. La section n'apparaît qu'en édition.
  useEffect(() => {
    if (editingId === null) {
      return undefined;
    }

    let current = true;
    setNotifications(null);
    setNotificationsFailure(null);

    void loadAppointmentNotificationsAction(tenantSlug, editingId).then((result) => {
      if (!current) {
        return;
      }
      if (result.ok) {
        setNotifications(result.data.notifications);
        return;
      }
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }
      // Le journal illisible ne bloque rien : c'est une information de contexte,
      // et le tiroir sert d'abord à poser et déplacer des rendez-vous. Le dire
      // vaut mieux que d'afficher un « aucun message » qui, lui, serait faux.
      setNotificationsFailure('Le journal d’envois n’a pas pu être lu.');
    });

    return () => {
      current = false;
    };
  }, [tenantSlug, editingId, onExpired]);

  // Les créneaux de la journée retenue — le cœur de #611.
  //
  // Relus à chaque changement de prestation, de praticien ou de date : les trois
  // changent la liste. Le praticien surtout — ses heures de travail sont ce sur
  // quoi le moteur aligne ses créneaux, et « premier disponible » rend l'union
  // de toute l'équipe.
  //
  // En édition, le rendez-vous déplacé ne doit pas s'occuper lui-même
  // (`excludeAppointmentId`, #442) : sans cela, un report d'un quart d'heure ne
  // trouverait jamais de créneau, le soin en cours de déplacement couvrant
  // précisément celui qu'on vise.
  //
  // La date est revalidée avant de partir : un `<input type="date">` rend une
  // valeur **vide** tant que l'opérateur n'a pas fini de retaper ses trois
  // segments, et interroger le serveur là-dessus ne rapporterait qu'un
  // `VALIDATION_ERROR` — que l'écran traduirait à tort en « disponibilité
  // illisible », donc en retour à la saisie libre, c'est-à-dire au 409 que ce
  // ticket supprime. Une date en cours de frappe est un **chargement**, pas une
  // panne.
  useEffect(() => {
    if (serviceId === '' || parseCalendarDate(day) === null) {
      setSlots(null);
      setSlotsFailure(null);
      return undefined;
    }

    let current = true;
    setSlots(null);
    setSlotsFailure(null);

    void loadDeskAvailabilityAction(tenantSlug, {
      serviceId,
      day,
      ...(staffId === '' ? {} : { staffId }),
      ...(editingId === null ? {} : { excludeAppointmentId: editingId }),
    }).then((result) => {
      if (!current) {
        return;
      }
      if (result.ok) {
        const options = deskSlotOptions(result.data.slots, timeZone);
        setSlots(options);
        // L'heure retenue est ramenée sur un créneau réel — celui d'après
        // l'heure visée, à défaut celui d'avant. La forme fonctionnelle évite
        // de mettre `time` en dépendance : l'effet rejouerait à chaque choix de
        // l'opérateur, et rechargerait la journée pour rien.
        //
        // **À la création seulement.** L'heure d'amorce y est une rangée de la
        // grille, donc une intention, et la résoudre est tout l'objet du ticket.
        // En édition, elle est l'heure **réelle** d'un rendez-vous posé : la
        // déplacer sans qu'on l'ait demandé ferait afficher une heure que le
        // rendez-vous n'a pas — le récapitulatif avec —, et un « Enregistrer »
        // cliqué de confiance le décalerait pour de bon. Le créneau du
        // rendez-vous reste offert dès lors qu'`excludeAppointmentId` le
        // libère (#442) ; quand le moteur ne le rend plus — horaires du
        // praticien changés depuis la réservation —, l'heure d'origine reste
        // affichée, non réservable, et c'est à l'opérateur d'en choisir une.
        if (editingId === null) {
          setTime((wanted) => nearestDeskSlot(options, wanted)?.time ?? wanted);
        }
        return;
      }
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }
      // La disponibilité illisible ne ferme pas le comptoir : le sélecteur
      // retombe sur la saisie libre, et l'API reste juge du créneau.
      setSlots(null);
      setSlotsFailure(DESK_SLOTS_UNREADABLE_MESSAGE);
    });

    return () => {
      current = false;
    };
  }, [tenantSlug, serviceId, staffId, day, editingId, timeZone, slotsVersion, onExpired]);

  // Le créneau retenu, quand il vient bien de la liste du moteur. `null` en
  // saisie libre — liste illisible — et pendant le chargement.
  const chosen = slots?.find((option) => option.time === time) ?? null;
  // Une heure qu'aucun créneau ne porte ne part pas à l'API : elle reviendrait
  // en 409, et c'est exactement le refus que ce ticket supprime. La saisie libre
  // fait exception — la liste étant illisible, c'est l'API qui tranchera.
  const bookable = slotsFailure !== null || chosen !== null;

  // Les praticiens réellement offerts par le sélecteur : ceux qui tiennent la
  // prestation, plus — en édition — celui déjà affecté au rendez-vous même s'il
  // n'y figure plus. Le retirer ferait retomber le sélecteur sur « premier
  // disponible » et changerait le praticien d'un rendez-vous qu'on venait
  // seulement déplacer.
  const offered: readonly ServiceStaffMember[] = useMemo(() => {
    const loaded = staff ?? [];

    if (editing === null || loaded.some((member) => member.id === editing.staff.id)) {
      return loaded;
    }

    return [
      { id: editing.staff.id, displayName: editing.staff.displayName, isActive: true },
      ...loaded,
    ];
  }, [staff, editing]);

  // Un praticien amorcé — la colonne cliquée, ou celui du rendez-vous — ne tient
  // pas forcément la prestation retenue. Sans cette remise à zéro, le sélecteur
  // n'aurait aucune option correspondante et afficherait « premier disponible »
  // pendant que l'état, lui, garde l'identifiant : l'opérateur enverrait un
  // praticien qu'il croit ne pas avoir choisi, et l'API refuserait après coup.
  useEffect(() => {
    if (staff === null || staffId === '') {
      return;
    }

    if (!offered.some((member) => member.id === staffId)) {
      setStaffId('');
    }
  }, [staff, offered, staffId]);

  /** Traite le refus d'une écriture — conflit, session, ou message de l'API. */
  const refuse = useCallback(
    (code: string, message: string): void => {
      if (code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }

      if (isSlotConflict(code)) {
        // Le planning est relu : le créneau perdu doit se voir occupé. Aucune
        // saisie n'est touchée — c'est tout l'objet du quatrième critère.
        setConflict(deskFailureMessage(code, message));
        setFailure(null);
        // …et la liste des créneaux avec lui (#611) : celui que l'API vient de
        // refuser n'a plus à être proposé, et le suivant se choisit sans quitter
        // le tiroir.
        setSlotsVersion((version) => version + 1);
        onReload();
        return;
      }

      setConflict(null);
      setFailure(deskFailureMessage(code, message));
    },
    [onExpired, onReload],
  );

  const submit = useCallback(async (): Promise<void> => {
    setSaving(true);
    // L'instant du créneau tel que le moteur l'a rendu, et non une reconversion
    // de l'heure civile : c'est sur cette chaîne que porte l'égalité exigée par
    // l'API (#611). La conversion locale ne sert plus qu'à la saisie libre, quand
    // la liste des créneaux n'a pas pu être lue.
    const startsAt = chosen?.startsAt ?? offsetDateTimeInTenant(day, time, timeZone);

    const result =
      editing === null
        ? await createDeskAppointmentAction(tenantSlug, {
            serviceId,
            startsAt,
            ...(staffId === '' ? {} : { staffId }),
            ...(client === null ? {} : { clientId: client.id }),
            ...(note.trim() === '' ? {} : { clientNote: note.trim() }),
          })
        : await rescheduleDeskAppointmentAction(tenantSlug, editing.id, {
            startsAt,
            ...(staffId === '' ? {} : { staffId }),
          });

    setSaving(false);

    if (result.ok) {
      onReload();
      onClose();
      return;
    }

    refuse(result.code, result.message);
  }, [
    chosen,
    day,
    time,
    timeZone,
    editing,
    tenantSlug,
    serviceId,
    staffId,
    client,
    note,
    onReload,
    onClose,
    refuse,
  ]);

  const mark = useCallback(
    async (status: AppointmentStatus): Promise<void> => {
      if (editing === null) {
        return;
      }

      setSaving(true);
      const result = await markDeskAppointmentStatusAction(tenantSlug, editing.id, { status });
      setSaving(false);

      if (result.ok) {
        onReload();
        onClose();
        return;
      }

      refuse(result.code, result.message);
    },
    [editing, tenantSlug, onReload, onClose, refuse],
  );

  /**
   * Le focus entre dans le tiroir à son ouverture (#617).
   *
   * Sur le tiroir lui-même et non sur son premier champ : le nom accessible de
   * la région est alors annoncé — « Nouveau rendez-vous » — avant la saisie, et
   * la tabulation suivante mène au premier contrôle sans en sauter aucun. C'est
   * aussi ce qui rend la fermeture par Échap atteignable tout de suite, le
   * gestionnaire étant posé sur la région.
   *
   * Au montage seulement, et le montage suffit : le planning donne au tiroir une
   * `key` par cible, donc cliquer un autre créneau le remonte.
   */
  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  /**
   * Échap referme, depuis n'importe où dans le tiroir.
   *
   * Le gestionnaire est posé sur la région et non sur la fenêtre : l'événement
   * doit **provenir** du tiroir — ce qui est le cas dès l'ouverture, le focus y
   * étant entré —, et non de n'importe où dans la page.
   *
   * La propagation n'est PAS coupée, et c'est délibéré. Le planning écoute Échap
   * sur la fenêtre pour reposer un rendez-vous saisi à la poignée (#51), et un
   * `stopPropagation()` ici l'empêchait de s'exécuter : ouvrir la fiche d'un
   * autre bloc alors qu'un rendez-vous est saisi, puis refermer par Échap,
   * laissait la saisie **armée** — tous les créneaux libres restaient des cibles
   * de dépôt, et le clic suivant, censé poser un nouveau rendez-vous, déplaçait
   * celui d'avant. Les deux gestes vont ensemble : Échap referme le tiroir et
   * repose ce qui était saisi.
   */
  const closeOnEscape = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Escape') {
        return;
      }

      onClose();
    },
    [onClose],
  );

  const title =
    editing === null
      ? 'Nouveau rendez-vous'
      : `${editing.client.firstName} ${editing.client.lastName}`;

  // Le catalogue vide est un état à part entière : un rendez-vous se pose sur une
  // prestation, et un sélecteur vide laisserait l'opérateur chercher son erreur.
  // …à la création seulement : un rendez-vous **déjà posé** porte sa prestation
  // avec lui, et refuser de l'ouvrir parce que le catalogue actif s'est vidé
  // interdirait de le marquer honoré ou non présenté.
  if (services.length === 0 && editing === null) {
    return (
      <aside
        aria-labelledby={`${formId}-titre`}
        className="spa-admin-calendar__drawer spa-admin-panel"
        onKeyDown={closeOnEscape}
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="spa-admin-panel__header">
          <h2 className="spa-admin-panel__title" id={`${formId}-titre`}>
            {title}
          </h2>
          <Button variant="quiet" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="spa-visually-hidden">Fermer le tiroir</span>
          </Button>
        </div>
        <div className="spa-admin-panel__body">
          <div className="spa-admin-appointment spa-admin-appointment--empty">
            <div className="spa-empty-state spa-empty-state--inline">
              <p className="spa-empty-state__title">Le catalogue est vide</p>
              <p className="spa-empty-state__description">
                Un rendez-vous se pose sur une prestation. Créez-en au moins une — durée et prix
                compris — avant de planifier.
              </p>
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-labelledby={`${formId}-titre`}
      className="spa-admin-calendar__drawer spa-admin-panel"
      onKeyDown={closeOnEscape}
      ref={drawerRef}
      tabIndex={-1}
    >
      <div className="spa-admin-panel__header">
        <h2 className="spa-admin-panel__title" id={`${formId}-titre`}>
          {title}
        </h2>
        {editing === null ? null : (
          <span
            className={`spa-admin-badge spa-admin-badge--${statusModifier(editing.status)}`}
          >
            {STATUS_LABELS[editing.status]}
          </span>
        )}
        <Button variant="quiet" onClick={onClose}>
          <span aria-hidden="true">×</span>
          <span className="spa-visually-hidden">Fermer le tiroir</span>
        </Button>
      </div>

      <div className="spa-admin-panel__body">
        {conflict === null ? null : (
          <div className="spa-admin-appointment__conflict">
            {/* « Indisponible » et non « déjà réservé » : le 409 couvre cinq
                refus différents et n'en distingue aucun (#611). */}
            <Notification tone="warning" title="Créneau indisponible">
              <p>{conflict}</p>
            </Notification>
          </div>
        )}

        {failure === null ? null : (
          <div className="spa-admin-appointment__conflict">
            <Notification tone="danger" title="Enregistrement impossible">
              <p>{failure}</p>
            </Notification>
          </div>
        )}

        <form
          className="spa-admin-appointment"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="spa-admin-appointment__grid">
            {editing === null ? (
              <ClientPicker
                tenantSlug={tenantSlug}
                selected={client}
                onSelect={setClient}
                onExpired={onExpired}
              />
            ) : null}

            <Select
              id={`${formId}-prestation`}
              label="Prestation"
              value={serviceId}
              disabled={editing !== null}
              {...(editing === null
                ? {}
                : {
                    hint: 'La prestation d’un rendez-vous posé ne se change pas : son prix et sa durée sont figés à la réservation. Annulez et reposez le rendez-vous.',
                  })}
              onChange={(event) => {
                setServiceId(event.target.value);
                // Le praticien retenu ne tient pas forcément la nouvelle
                // prestation : le remettre à « premier disponible » vaut mieux
                // que de laisser un choix que l'API refusera.
                setStaffId('');
              }}
            >
              {/* La prestation réservée d'abord, quand elle a quitté le
                  catalogue actif : sans son option, le sélecteur désactivé
                  afficherait le nom d'une autre prestation. */}
              {booked === null ? null : (
                <option value={booked.id}>
                  {booked.name} — {String(booked.durationMinutes)} min
                </option>
              )}
              {services.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {String(candidate.durationMinutes)} min
                </option>
              ))}
            </Select>

            <Select
              id={`${formId}-praticien`}
              label="Praticien"
              value={staffId}
              hint="Sans choix, le serveur affecte le premier disponible."
              onChange={(event) => {
                setStaffId(event.target.value);
              }}
            >
              <option value="">Premier disponible</option>
              {offered.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </Select>

            <Field
              id={`${formId}-date`}
              label="Date"
              required
              type="date"
              value={day}
              onChange={(event) => {
                setDay(event.target.value as CalendarDate);
              }}
            />

            {/* L'heure se choisit dans la liste du moteur, et ne se saisit à la
                main que si cette liste n'a pas pu être lue (#611). */}
            {slotsFailure === null ? (
              <Select
                id={`${formId}-heure`}
                label="Heure de début"
                value={time}
                disabled={slots === null}
                {...(slots !== null && slots.length === 0
                  ? { emptyLabel: DESK_NO_SLOT_MESSAGE }
                  : {})}
                {...(slots !== null && slots.length === 0
                  ? // Le message de liste vide dit déjà tout : y ajouter
                    // « seuls les créneaux honorables sont proposés » ferait
                    // affirmer au même contrôle qu'il propose quelque chose et
                    // qu'il ne propose rien.
                    {}
                  : {
                      hint:
                        slots === null
                          ? 'Lecture des créneaux disponibles…'
                          : 'Seuls les créneaux que le planning peut honorer sont proposés.',
                    })}
                onChange={(event) => {
                  setTime(event.target.value);
                }}
              >
                {/* L'heure retenue, quand aucun créneau ne la porte : pendant la
                    lecture, sur une journée sans créneau, et sur un rendez-vous
                    posé que le moteur n'offre plus. Sans elle, le sélecteur
                    tomberait sur du vide — l'écran cesserait de dire à quelle
                    heure le rendez-vous qu'il affiche est posé. Elle n'est pas
                    réservable pour autant : `bookable` la refuse, faute de
                    créneau correspondant. */}
                {slots === null || !slots.some((option) => option.time === time) ? (
                  <option value={time}>{time}</option>
                ) : null}
                {(slots ?? []).map((option) => (
                  <option key={option.time} value={option.time}>
                    {option.time}
                  </option>
                ))}
              </Select>
            ) : (
              <Field
                id={`${formId}-heure`}
                label="Heure de début"
                required
                type="time"
                value={time}
                hint={DESK_SLOTS_UNREADABLE_MESSAGE}
                onChange={(event) => {
                  setTime(event.target.value);
                }}
              />
            )}

            <p className="spa-admin-appointment__timezone">
              Heures saisies et affichées dans le fuseau du salon — {timeZone}. Le stockage se fait
              en UTC.
            </p>

            {editing === null ? (
              <div className="spa-admin-appointment__span">
                <TextArea
                  id={`${formId}-note`}
                  label="Note jointe au rendez-vous"
                  rows={2}
                  value={note}
                  hint="Reprise dans la confirmation : elle est visible de la cliente."
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              </div>
            ) : null}
          </div>

          {summary === null ? null : (
            <div className="spa-admin-appointment__summary">
              <div className="spa-admin-appointment__summary-row">
                <span className="spa-admin-appointment__summary-label">Début</span>
                <span className="spa-admin-appointment__summary-value">{summary.startTime}</span>
              </div>
              <div className="spa-admin-appointment__summary-row">
                <span className="spa-admin-appointment__summary-label">Fin (calculée)</span>
                <span className="spa-admin-appointment__summary-value">{summary.endTime}</span>
              </div>
              {summary.bufferMinutes === 0 ? null : (
                <div className="spa-admin-appointment__summary-row spa-admin-appointment__summary-row--buffer">
                  <span className="spa-admin-appointment__summary-label">
                    Tampon de remise en état
                  </span>
                  <span className="spa-admin-appointment__summary-value">
                    {String(summary.bufferMinutes)} min — libre à {summary.freeAtTime}
                  </span>
                </div>
              )}
              {price === null ? null : (
                <div className="spa-admin-appointment__summary-row spa-admin-appointment__summary-row--total">
                  <span className="spa-admin-appointment__summary-label">Montant</span>
                  <span className="spa-admin-appointment__summary-value">{formatMoney(price)}</span>
                </div>
              )}
            </div>
          )}
        </form>

        {/* Hors du `<form>`, et délibérément : c'est un bloc en lecture seule.
            L'y mettre lui aurait donné un `form=` implicite et fait remonter ses
            éventuels contrôles à la soumission du tiroir. */}
        {editingId === null ? null : (
          <NotificationStatusList
            notifications={notifications}
            timeZone={timeZone}
            loading={notifications === null && notificationsFailure === null}
            failure={notificationsFailure}
          />
        )}
      </div>

      <div className="spa-admin-panel__footer">
        {editing === null
          ? null
          : deskStatusActions(editing.status).map((action) => (
              <Button
                key={action.status}
                variant={action.variant}
                loading={saving}
                onClick={() => {
                  void mark(action.status);
                }}
              >
                {action.label}
              </Button>
            ))}

        <Button variant="neutral" onClick={onClose}>
          Fermer
        </Button>

        {/* Le pied est hors du `<form>` : le bouton doit désigner son formulaire
            par `form=`, sans quoi il ne soumet rien. C'est le contrat que la
            maquette a posé, et il est repris tel quel. */}
        <Button
          form={formId}
          type="submit"
          variant="accent"
          loading={saving}
          disabled={
            !bookable || (editing === null ? client === null : !isReschedulable(editing.status))
          }
        >
          {editing === null ? 'Créer le rendez-vous' : 'Enregistrer'}
        </Button>
      </div>
    </aside>
  );
}
