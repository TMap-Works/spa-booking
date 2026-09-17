'use client';

import {
  ERROR_CODES,
  REASON_MAX_LENGTH,
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
import Link from 'next/link';
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
  DESK_CANCEL_QUESTION,
  DESK_CANCEL_REASON_HINT,
  DESK_NO_SLOT_MESSAGE,
  DESK_SLOTS_UNREADABLE_MESSAGE,
  deskCancelFailureMessage,
  deskFailureMessage,
  deskSlotOptions,
  deskStatusActions,
  isCancellable,
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
import {
  catalogStartLink,
  CATALOG_EMPTY_DESCRIPTION,
  CATALOG_EMPTY_TITLE,
} from '@/lib/admin/calendar-start';
import { formatMoney } from '@/lib/format';

import {
  cancelDeskAppointmentAction,
  createDeskAppointmentAction,
  loadAppointmentNotificationsAction,
  loadDeskAvailabilityAction,
  loadDeskServiceStaffAction,
  markDeskAppointmentStatusAction,
  rescheduleDeskAppointmentAction,
} from '../calendrier/actions';
import { adminCatalogPath } from '../paths';

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
 * ## La note du rendez-vous se lit en édition — #757
 *
 * Elle ne se **saisit** qu'à la création — un report ne réécrit pas ce que la
 * cliente a joint à sa réservation —, mais elle se **lit** sur tout rendez-vous
 * posé, à côté du récapitulatif : voir `AppointmentNote`, au bas de ce fichier.
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
  // L'annulation au comptoir, en deux temps — #754. Le premier clic n'annule
  // rien : il pose la question. C'est ce que web-frontend §5 exige d'une action
  // destructive, et c'est aussi ce qui protège du clic au téléphone, le pied du
  // tiroir mettant « Annuler le rendez-vous » à quelques pixels de « Marquer
  // honoré ».
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
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
    // La question d'annulation retire « Enregistrer » du pied, mais laisse le
    // `<form>` vivant. En édition il n'y reste qu'un seul champ qui bloque la
    // soumission implicite — la date —, et un formulaire sans bouton de
    // soumission se soumet alors **de lui-même** sur `Entrée` : le rendez-vous
    // qu'on est en train d'annuler partait au report, sans passer par aucune
    // des gardes que portait le bouton disparu.
    if (confirmingCancel) {
      return;
    }

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
    confirmingCancel,
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
   * L'annulation proprement dite — second temps, après la question (#754).
   *
   * Le motif part **élagué**, et absent quand il ne reste rien : le contrat
   * distingue « pas de motif » de « motif vide », et trois espaces envoyés tels
   * quels feraient compter comme motivée une annulation qui ne l'est pas
   * (`cancel-appointment.dto.ts`). L'auteur, lui, n'est pas transmis : la route
   * gardée inscrit `STAFF` depuis sa porte.
   *
   * Le planning est relu avant la fermeture : le créneau est déjà réservable
   * quand la réponse arrive — la ligne a quitté le filtre partiel de la
   * contrainte d'exclusion au `COMMIT` —, et le bloc doit disparaître de la
   * grille sans qu'on ait à changer de jour.
   */
  const cancel = useCallback(async (): Promise<void> => {
    if (editing === null) {
      return;
    }

    const reason = cancelReason.trim();

    setSaving(true);
    const result = await cancelDeskAppointmentAction(
      tenantSlug,
      editing.id,
      reason === '' ? {} : { reason },
    );
    setSaving(false);

    if (result.ok) {
      onReload();
      onClose();
      return;
    }

    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      onExpired();
      return;
    }

    // La question reste posée : l'opérateur voit le refus au-dessus du motif
    // qu'il vient d'écrire, et renvoie sans le ressaisir.
    //
    // Le refus ne passe **pas** par `refuse` : celui-ci lit un `CONFLICT` comme
    // un créneau perdu et un `NOT_FOUND` comme une route absente — deux lectures
    // que l'annulation ne supporte pas, sa route étant servie et n'ayant pas de
    // créneau à reprendre (`deskCancelFailureMessage`).
    setConflict(null);
    setFailure(deskCancelFailureMessage(result.code, result.message));
  }, [editing, cancelReason, tenantSlug, onReload, onClose, onExpired]);

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
    const catalogue = catalogStartLink(adminCatalogPath(tenantSlug));

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
              <p className="spa-empty-state__title">{CATALOG_EMPTY_TITLE}</p>
              <p className="spa-empty-state__description">{CATALOG_EMPTY_DESCRIPTION}</p>
              {/* L'explication seule restait un cul-de-sac : elle nommait ce qui
                  manque sans donner le moyen d'y remédier (#751). Le lien est le
                  même que celui de l'état vide du planning — même impasse, même
                  sortie. */}
              <Link className="spa-button spa-button--accent" href={catalogue.href}>
                <span className="spa-button__label">{catalogue.label}</span>
              </Link>
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
        {/* La référence citable, en tête du tiroir — #796.

            C'est le premier bloc du corps, avant même le formulaire, et sa place
            tient à ce qu'on en fait : quand le téléphone sonne, la personne qui
            décroche entend « RDV-A5HY-14 » et doit retrouver ce code sous les
            yeux. Le mettre plus bas, parmi les valeurs calculées du
            récapitulatif, l'aurait rangé avec ce qui décrit le rendez-vous — or
            elle ne le décrit pas, elle le désigne.

            Absente à la création : la référence est tirée par le serveur à
            l'insertion, et l'écran ne peut pas l'inventer avant que le
            rendez-vous existe.

            Le libellé est celui de l'écran de confirmation de la cliente
            (« Réf. »), au mot près : les deux surfaces montrent le même code, et
            le nommer autrement de chaque côté du comptoir aurait obligé à
            traduire au téléphone. */}
        {editing === null ? null : (
          <div className="spa-admin-appointment__summary">
            <div className="spa-admin-appointment__summary-row">
              <span className="spa-admin-appointment__summary-label">Réf.</span>
              <span className="spa-admin-appointment__summary-value">{editing.reference}</span>
            </div>
          </div>
        )}

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

        {/* La question d'annulation, et le motif qui l'accompagne — #754.

            Dans le corps et non dans le pied : le motif est une saisie, et une
            saisie posée dans un pied de deux lignes aurait poussé les boutons
            hors du tiroir. Elle est rendue **avant** le formulaire pour être vue
            sans défiler — c'est une question qui attend une réponse, pas un
            champ de plus.

            Hors du `<form>`, et pour la raison qui vaut déjà pour le journal
            d'envois : l'y mettre ferait remonter ce `<textarea>` à la soumission
            du tiroir, c'est-à-dire au report — et le motif d'une annulation n'a
            rien à voir avec un déplacement d'heure. */}
        {!confirmingCancel ? null : (
          <div className="spa-admin-appointment__cancel">
            <Notification tone="warning" title="Annuler ce rendez-vous">
              <p>{DESK_CANCEL_QUESTION}</p>
            </Notification>
            <TextArea
              // Le focus suit la question : sans cela, l'opérateur qui vient de
              // déclencher la confirmation au clavier se retrouverait sans point
              // d'appui, le bouton qu'il avait sous le doigt ayant disparu du
              // pied avec le premier temps.
              autoFocus
              id={`${formId}-motif`}
              label="Motif de l’annulation"
              rows={2}
              value={cancelReason}
              hint={DESK_CANCEL_REASON_HINT}
              maxLength={REASON_MAX_LENGTH}
              onChange={(event) => {
                setCancelReason(event.target.value);
              }}
            />
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
                    // L'invite ne désigne que le geste réellement offert (#754).
                    // Elle disait « Annulez et reposez le rendez-vous » alors que
                    // le tiroir n'avait pas d'annulation : elle renvoyait à une
                    // action absente. Le pied en porte une depuis, et l'invite la
                    // nomme là où elle se trouve — mais seulement tant qu'elle y
                    // est : sur un rendez-vous soldé, annulé ou non présenté, le
                    // cycle de vie refuse l'annulation, et l'invite retombe au
                    // constat seul.
                    hint: isCancellable(editing.status)
                      ? 'La prestation d’un rendez-vous posé ne se change pas : son prix et sa durée sont figés à la réservation. Pour en changer, annulez ce rendez-vous au pied du tiroir, puis reposez-en un nouveau.'
                      : 'La prestation d’un rendez-vous posé ne se change pas : son prix et sa durée sont figés à la réservation.',
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
                  hint="Reprise dans la confirmation : elle est visible du client."
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

        {/* La note du rendez-vous, en lecture — #757.

            Juste après le récapitulatif, et hors du `<form>` pour la même raison
            que le journal d'envois : c'est un bloc en lecture seule, et l'y
            mettre lui aurait donné un `form=` implicite.

            En édition seulement : à la création, le même texte est un champ de
            saisie quelques lignes plus haut, et le rendre deux fois aurait
            affiché côte à côte une note qu'on écrit et la même note qu'on lit. */}
        {editing === null ? null : (
          <AppointmentNote note={editing.clientNote ?? null} titleId={`${formId}-note`} />
        )}

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

      {/* Le pied, en deux visages — #754.

          Pendant la confirmation d'annulation, il ne porte que la réponse à la
          question posée. Les autres actions sont retirées, et c'est délibéré :
          « Enregistrer » y déplacerait le rendez-vous qu'on est en train
          d'annuler, et « Marquer honoré » le solderait. Laisser trois issues
          ouvertes à une question fermée est ce qui fait cliquer à côté. */}
      <div className="spa-admin-panel__footer">
        {confirmingCancel ? (
          <>
            <Button
              variant="quiet"
              disabled={saving}
              onClick={() => {
                setConfirmingCancel(false);
                // Le bouton qu'on vient d'activer disparaît avec la question,
                // et le focus retomberait sur `document.body` : Échap, posé sur
                // la région, cesserait de refermer le tiroir et la tabulation
                // repartirait du haut de la page, derrière lui. Le focus revient
                // donc au tiroir, comme à son ouverture (#617).
                drawerRef.current?.focus();
              }}
            >
              Garder ce rendez-vous
            </Button>
            <Button
              variant="danger"
              loading={saving}
              loadingLabel="Annulation en cours…"
              onClick={() => {
                void cancel();
              }}
            >
              Confirmer l’annulation
            </Button>
          </>
        ) : (
          <>
            {/* L'annulation ouvre le pied, avant les transitions de statut : une
                action destructive ne se range pas au milieu des gestes
                courants, et la mettre à l'opposé d'« Enregistrer » est ce qui
                évite de l'atteindre en visant autre chose. Elle n'apparaît que
                sur un rendez-vous que le cycle de vie laisse encore annuler. */}
            {editing !== null && isCancellable(editing.status) ? (
              <Button
                variant="danger"
                disabled={saving}
                onClick={() => {
                  setConfirmingCancel(true);
                }}
              >
                Annuler le rendez-vous
              </Button>
            ) : null}

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

            {/* Le pied est hors du `<form>` : le bouton doit désigner son
                formulaire par `form=`, sans quoi il ne soumet rien. C'est le
                contrat que la maquette a posé, et il est repris tel quel. */}
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
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * La note jointe au rendez-vous, telle que le comptoir la lit — #757.
 *
 * ## Pourquoi ce bloc existe
 *
 * Le champ « Note jointe au rendez-vous » n'était rendu qu'à la **création**. À
 * l'ouverture d'un rendez-vous existant, le tiroir montrait prestation,
 * praticien, date, heure, récapitulatif et messages envoyés — jamais la note.
 * Or c'est précisément ce que le tunnel de réservation invite la cliente à
 * écrire (`docs/design/appointments/wireframes.md`, étape 4, « Remarque
 * (facultatif) »), et ce que son espace client lui montre en retour. Une
 * consigne d'allergie écrite à la réservation n'atteignait donc jamais la
 * praticienne qui allait la recevoir.
 *
 * ## Ce n'est pas la note interne du salon, et c'est écrit
 *
 * Deux textes libres cohabitent dans ce produit et ne se confondent sous aucun
 * prétexte : `clientNote`, jointe au rendez-vous et **reprise dans la
 * confirmation** — la cliente en connaît le texte —, et `internalNote`, la note
 * interne de la fiche cliente, que `client-note-form.tsx` marque « Interne au
 * salon » et qui ne sort par aucune route publique. Les deux se lisent au
 * comptoir, et une opératrice qui les mélangerait lirait à voix haute ce qui ne
 * doit pas l'être. L'appartenance est donc écrite **en toutes lettres** sous le
 * titre, jamais portée par une teinte (WCAG 1.4.1) — même doctrine que la
 * marque « Interne au salon ».
 *
 * `staffNote` du rendez-vous n'est pas rendue ici : le contrat la sert à cette
 * route, mais c'est une note de séance, et l'afficher dans le même bloc aurait
 * reproduit exactement la confusion que ce composant existe pour lever.
 *
 * ## L'absence se dit
 *
 * Ne rien rendre quand il n'y a pas de note laisserait la même question ouverte
 * qu'avant le ticket : la cliente n'a rien écrit, ou l'écran ne le montre pas ?
 * Sur une consigne d'allergie, le doute coûte plus cher que la ligne. Le bloc
 * est donc toujours là en édition, et dit son vide — comme le journal d'envois
 * juste en dessous, et comme la note interne sur la fiche.
 *
 * Et « vide » se juge sur le **texte**, pas sur le seul `null` : `longTextSchema`
 * n'a pas de `.min(1)`, si bien qu'une chaîne vide traverse tout le contrat. Une
 * remarque tapée en espaces dans le tunnel y arrive intacte — l'étape de contact
 * soumet `getValues()`, donc la valeur brute que le `.trim()` de Zod n'a pas
 * touchée, et le récapitulatif n'omet le champ que s'il vaut exactement `''` —,
 * l'API la range élaguée à `''` plutôt qu'à `null`, et l'agenda la sert telle
 * quelle. S'arrêter à `null` afficherait alors un bloc titré « Visible du
 * client » au-dessus d'un paragraphe vide : le tiroir affirmerait une note qu'il
 * ne montre pas, exactement le doute que ce composant existe pour lever.
 * `appointment-card.tsx`, côté espace client, garde déjà ce cas.
 *
 * ## Aucune feuille de style n'est ajoutée
 *
 * Le bloc compose deux familles existantes, chargées par le layout du
 * back-office (`styles/admin/index.css`) : `spa-admin-notes` — la présentation
 * d'une note du design system, celle-là même qui rend la note interne — et
 * `spa-empty-state--inline`, déjà employé par ce tiroir pour le catalogue vide.
 * Reprendre la famille de la note interne est délibéré : les deux notes se
 * ressemblent à l'œil, et ce sont leurs **libellés** qui les distinguent, ce qui
 * est la seule distinction qui survive à une impression en gris.
 */
function AppointmentNote({
  note,
  titleId,
}: {
  /**
   * Le texte joint au rendez-vous, ou `null` — le contrat rend le champ absent.
   *
   * Une chaîne vide ou blanche compte pour une absence : voir l'en-tête.
   */
  readonly note: string | null;
  readonly titleId: string;
}) {
  const written = note === null || note.trim() === '' ? null : note;

  return (
    <section aria-labelledby={titleId} className="spa-admin-notes">
      {/* Le titre reprend **au mot près** le libellé du champ de création, dix
          lignes plus haut dans ce même tiroir : c'est le même objet, et le
          nommer autrement selon qu'on l'écrit ou qu'on le lit aurait fait deux
          choses de la même note. */}
      <h3 className="spa-admin__section-title" id={titleId}>
        Note jointe au rendez-vous
      </h3>

      {written === null ? (
        <div className="spa-empty-state spa-empty-state--inline">
          <p className="spa-empty-state__title">Aucune note jointe à ce rendez-vous</p>
          <p className="spa-empty-state__description">
            Rien n’a été écrit à la réservation. La note interne du salon, elle, se tient sur la
            fiche client.
          </p>
        </div>
      ) : (
        <ul className="spa-admin-notes__list">
          <li className="spa-admin-notes__item">
            <div className="spa-admin-notes__meta">
              <span>Jointe à la réservation</span>
              <span>Visible du client — ce n’est pas la note interne du salon</span>
            </div>
            <p className="spa-admin-notes__body">{written}</p>
          </li>
        </ul>
      )}
    </section>
  );
}
