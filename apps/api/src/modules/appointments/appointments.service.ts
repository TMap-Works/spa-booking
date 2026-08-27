import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { requireTenantId } from '../../common/tenant';
import { AvailabilityService } from '../availability/availability.service';
import type { ServiceView } from '../catalog/catalog.types';
import { ServicesService } from '../catalog/services.service';
import { SlotNoLongerAvailableError } from './appointments.errors';
import { AppointmentsRepository } from './appointments.repository';
import type {
  AppointmentDraft,
  AppointmentRecord,
  AppointmentView,
  BookAppointmentInput,
} from './appointments.types';
import { AppointmentEvents } from './events/appointment-events';

/**
 * Prise de rendez-vous — le point d'entrée du revenu (#37, CDC §2.3).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Les deux intervalles d'un rendez-vous, et lequel va en base
 *
 * La cliente choisit une **heure de soin** ; le praticien, lui, est occupé
 * pendant `tampon avant + soin + tampon après`. Ce sont deux intervalles
 * distincts, et les confondre est le défaut que ce service existe pour éviter :
 *
 * | Intervalle | Qui le voit | Où il vit |
 * |---|---|---|
 * | occupé | personne, hors agenda interne | `appointments.starts_at` / `ends_at`, donc `time_range`, donc la contrainte d'exclusion |
 * | facturé | la cliente, sa confirmation, son rappel | `AppointmentView`, dérivé à la lecture |
 *
 * C'est la même asymétrie qu'`availability.slots.ts` : la grille se pose sur
 * l'occupé, la sortie rend le facturé. Stocker le facturé laisserait deux soins
 * se toucher sans que la cabine ait été remise en état — le troisième critère de
 * #37 dit exactement l'inverse : « la durée enregistrée inclut les buffers du
 * service ».
 *
 * ## L'unicité n'est pas vérifiée ici, et ne peut pas l'être
 *
 * Aucun « ce créneau est-il libre ? » suivi d'un `INSERT` : deux requêtes
 * simultanées passeraient toutes les deux (ADR 0002, booking-engine §1). Le
 * refus vient de `appointments_no_overlap`, et `AppointmentsRepository` le
 * traduit en `SlotNoLongerAvailableError` — donc en 409. Le contrôle de
 * disponibilité que fait ce service est d'une autre nature : il vérifie que le
 * créneau demandé **était proposable**, pas qu'il est encore libre. Le second
 * n'appartient qu'à la base.
 *
 * ## Ce que ce ticket ne pose pas
 *
 * Ni report (#39), ni annulation (#40), ni verrou Redis de saisie (#38), ni
 * création au comptoir par le staff (#50) : la seule surface ouverte ici est la
 * réservation publique, celle du tunnel de #45.
 */
@Injectable()
export class AppointmentsService {
  public constructor(
    private readonly repository: AppointmentsRepository,
    private readonly services: ServicesService,
    private readonly availability: AvailabilityService,
    private readonly events: AppointmentEvents,
  ) {}

  /**
   * Pose un rendez-vous `PENDING` dans l'établissement courant.
   *
   * `now` est un paramètre plutôt qu'un `new Date()` enfoui, pour la même raison
   * que dans `AvailabilityService.slotsFor` : le filtrage du passé et du préavis
   * se teste en décalant l'horloge de l'appelant, jamais celle de la machine.
   *
   * @throws {NotFoundError} prestation inconnue, hors de l'établissement, ou
   * retirée du catalogue.
   * @throws {SlotNoLongerAvailableError} le créneau n'est pas — ou n'est plus —
   * proposable, ou la contrainte d'exclusion vient de le refuser.
   */
  public async book(input: BookAppointmentInput, now: Date = new Date()): Promise<AppointmentView> {
    const service = await this.services.byId(input.serviceId);

    if (!service.isActive) {
      // Une prestation retirée du catalogue n'est pas réservable, et le dire
      // autrement qu'en 404 la distinguerait d'une prestation qui n'existe pas.
      throw new NotFoundError('Prestation introuvable.');
    }

    await this.requireOfferedSlot(input, now);

    const clientId = await this.repository.findOrCreateClient(input.client);

    const record = await this.insert({
      clientId,
      staffId: input.staffId,
      serviceId: input.serviceId,
      ...occupiedRange(input.startsAt, service),
      // Le prix est **figé** ici, à la valeur du catalogue au moment de la
      // réservation : le tarif peut changer avant la venue, le montant dû par
      // cette cliente-là, non.
      price: service.price,
      clientNote: input.clientNote,
    }, input.startsAt);

    // Après l'écriture, jamais dedans : annoncer un rendez-vous qu'un `ROLLBACK`
    // effacerait ensuite enverrait une confirmation pour un rendez-vous qui
    // n'existe pas.
    const view = billedView(record, service);
    this.events.appointmentCreated({
      // Le tenant courant est celui que l'extension Prisma vient d'écrire dans la
      // ligne. Il est relu ici parce qu'un abonné asynchrone n'hérite pas de la
      // portée de la requête — voir `appointment-created.event.ts`.
      tenantId: requireTenantId('Appointment', 'appointment.created'),
      appointmentId: view.id,
      clientId: view.clientId,
      staffId: view.staffId,
      serviceId: view.serviceId,
      startsAt: view.startsAt,
      endsAt: view.endsAt,
    });

    return view;
  }

  /**
   * L'écriture, avec le refus de créneau **reformulé dans les termes de
   * l'appelant**.
   *
   * Le repository ne connaît que l'intervalle occupé : le `SlotNoLongerAvailableError`
   * qu'il lève porte donc `09:50` là où la cliente a demandé `10:00`. Le contrat
   * de cette erreur dit l'inverse — « `staffId` et `startsAt` sont *ce que
   * l'appelant vient d'envoyer* » (`appointments.errors.ts`) —, et un `details`
   * qui rend une heure jamais soumise ferait pire que ne rien rendre : le front
   * ne retrouverait pas le créneau à retirer de sa liste, et l'écart de dix
   * minutes se lirait comme un bug de fuseau.
   *
   * Corrigé ici plutôt que dans le repository, qui n'a aucune raison d'apprendre
   * ce qu'est un tampon : c'est le service qui a converti l'un en l'autre, donc à
   * lui de reconvertir.
   */
  private async insert(draft: AppointmentDraft, billedStart: Date): Promise<AppointmentRecord> {
    try {
      return await this.repository.create(draft);
    } catch (error: unknown) {
      if (error instanceof SlotNoLongerAvailableError) {
        throw new SlotNoLongerAvailableError(draft.staffId, billedStart);
      }
      throw error;
    }
  }

  /**
   * Refuse un créneau que le moteur de disponibilité ne proposait pas.
   *
   * ## Pourquoi ce contrôle, alors que la contrainte suffit à l'unicité
   *
   * Parce qu'ils ne protègent pas la même chose. `appointments_no_overlap`
   * empêche **deux** rendez-vous de se chevaucher ; elle ne dit rien d'un
   * rendez-vous seul posé à trois heures du matin, un jour de fermeture, chez un
   * praticien qui ne pratique pas ce soin, ou pendant ses congés. Sur une route
   * **publique et non authentifiée**, l'absence de ce contrôle ferait de la
   * réservation une écriture libre dans l'agenda du salon.
   *
   * Le contrôle rejoue le moteur (#34) plutôt que de réécrire ses six règles :
   * praticiens candidats, fenêtres de travail, fermetures, congés, rendez-vous
   * occupants, préavis minimum. Une règle qui changerait là-bas et pas ici
   * laisserait réserver ce que le calendrier ne propose plus.
   *
   * ## Pourquoi un 409 et non un 422
   *
   * Parce que c'est ce dont le front a besoin, et parce que la cause écrasante
   * est temporelle : entre l'affichage des créneaux et la validation, quelqu'un a
   * réservé. Un second code d'erreur pour « ce créneau n'a jamais été proposé »
   * obligerait le tunnel (#46) à traiter deux chemins pour une seule conduite —
   * réafficher les créneaux et en proposer un autre.
   *
   * Il a un effet secondaire utile sur une surface publique : un `staffId`
   * inconnu, désactivé, d'un autre établissement ou qui ne pratique pas ce soin
   * rend le **même** 409 qu'un créneau pris. Aucune de ces quatre situations ne
   * se distingue, et l'endpoint ne peut donc pas servir de sonde d'existence
   * (tenant-isolation §4).
   *
   * ## La fenêtre de trois jours
   *
   * Le moteur raisonne en **dates civiles du salon**, et ce service ne connaît
   * pas le fuseau du salon — le lire demanderait un accès aux réglages du tenant
   * que `availability` n'expose pas. Les trois journées UTC autour de l'instant
   * demandé contiennent nécessairement sa journée locale, quel que soit le
   * fuseau : aucun décalage réel ne dépasse ±14 h. C'est une borne, pas une
   * approximation — le créneau est ensuite reconnu à l'instant exact.
   */
  private async requireOfferedSlot(input: BookAppointmentInput, now: Date): Promise<void> {
    const window = utcDaysAround(input.startsAt);
    const wanted = input.startsAt.toISOString();

    const view = await this.availability.slotsFor(
      { serviceId: input.serviceId, staffId: input.staffId, from: window.from, to: window.to },
      now,
    );

    const offered = view.days.some((day) =>
      day.slots.some((slot) => slot.staffId === input.staffId && slot.startsAt === wanted),
    );

    if (!offered) {
      throw new SlotNoLongerAvailableError(input.staffId, input.startsAt);
    }
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * L'intervalle **occupé** d'un soin qui commence à `billedStart` — celui que la
 * base stocke et que la contrainte d'exclusion compare.
 *
 * Les tampons encadrent le soin : la préparation de la cabine commence avant que
 * la cliente n'arrive, la remise en état finit après qu'elle est partie. Les
 * ajouter tous deux **après** le soin ferait chevaucher le rendez-vous précédent,
 * qui est précisément ce que le tampon avant existe pour empêcher.
 */
function occupiedRange(billedStart: Date, service: ServiceView): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(billedStart.getTime() - service.bufferBeforeMinutes * MINUTE_MS);
  const endsAt = new Date(
    billedStart.getTime() + (service.durationMinutes + service.bufferAfterMinutes) * MINUTE_MS,
  );
  return { startsAt, endsAt };
}

/**
 * Le rendez-vous tel que la cliente le lit — l'intervalle **facturé**, retrouvé
 * depuis la ligne écrite.
 *
 * Dérivé de `record` et non de la demande d'origine : ce qui est rendu décrit
 * alors ce qui est réellement en base, et non ce qui avait été demandé. Les deux
 * coïncident aujourd'hui ; le jour où une règle ajusterait l'intervalle à
 * l'écriture, cette réponse suivrait au lieu de mentir.
 */
function billedView(record: AppointmentRecord, service: ServiceView): AppointmentView {
  const billedStart = record.startsAt.getTime() + service.bufferBeforeMinutes * MINUTE_MS;

  return {
    id: record.id,
    status: record.status,
    serviceId: record.serviceId,
    staffId: record.staffId,
    clientId: record.clientId,
    startsAt: new Date(billedStart).toISOString(),
    endsAt: new Date(billedStart + service.durationMinutes * MINUTE_MS).toISOString(),
    price: record.price,
    clientNote: record.clientNote,
  };
}

/** Les dates civiles UTC de la veille et du lendemain — voir `requireOfferedSlot`. */
function utcDaysAround(instant: Date): { from: string; to: string } {
  return {
    from: new Date(instant.getTime() - DAY_MS).toISOString().slice(0, 10),
    to: new Date(instant.getTime() + DAY_MS).toISOString().slice(0, 10),
  };
}
