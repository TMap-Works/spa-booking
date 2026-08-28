import { Injectable } from '@nestjs/common';

import { InvalidStateTransitionError, NotFoundError } from '../../common/errors';
import { requireTenantId } from '../../common/tenant';
import { AvailabilityCacheService } from '../availability/availability-cache';
import { AvailabilityService } from '../availability/availability.service';
import type { ServiceView } from '../catalog/catalog.types';
import { ServicesService } from '../catalog/services.service';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { occupiesSlot } from './appointment-status';
import { SlotNoLongerAvailableError } from './appointments.errors';
import { AppointmentsRepository } from './appointments.repository';
import type {
  AppointmentDraft,
  AppointmentRecord,
  AppointmentView,
  BookAppointmentInput,
  CancelAppointmentInput,
  RescheduleAppointmentInput,
  RescheduleDraft,
  RescheduleOutcome,
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
 * ## Le report, ajouté par #39
 *
 * `reschedule` déplace un rendez-vous en l'**annulant** et en en créant un
 * nouveau qui le référence, dans une seule transaction. Ce n'est pas un détail
 * d'implémentation : c'est ce qui préserve l'historique de la cliente, et ce qui
 * évite que la contrainte d'exclusion refuse un déplacement pourtant légitime.
 * Le détail vit dans `AppointmentsRepository.reschedule`.
 *
 * ## L'annulation, ajoutée par #40
 *
 * `cancel` fait passer un rendez-vous à `CANCELLED` en consignant **qui, quand
 * et pourquoi**, et libère son créneau du même geste — la ligne quitte le filtre
 * partiel de la contrainte d'exclusion, sans qu'aucune purge n'ait à être
 * écrite. Les transitions interdites sont refusées par
 * `AppointmentLifecycleService`, un service dédié : ni ce service-ci, ni aucun
 * contrôleur, ne connaît la table des transitions.
 *
 * Une seule méthode sert les deux côtés du comptoir. Ce qui distingue la cliente
 * du salon n'est pas une règle, c'est une **porte** : le contrôleur public dit
 * `CLIENT`, celui de back-office dit `STAFF`.
 *
 * ## Le cache de disponibilité, ajouté par #35
 *
 * Les trois écritures de ce service — réserver, reporter, annuler — chassent le
 * cache de disponibilité du tenant, immédiatement après le `COMMIT`. C'est le
 * troisième critère de #35 : « invalidation explicite à toute écriture sur
 * appointments ». Sans elle, un créneau tout juste libéré par une annulation
 * resterait invisible jusqu'à soixante secondes — et un créneau libre masqué est
 * une vente perdue (booking-engine §3).
 *
 * Ce que ce service ne fait **pas**, et qui est la garantie du cinquième critère
 * du même ticket : lire ce cache. `requireOfferedSlot` interroge
 * `AvailabilityService`, le moteur nu ; `AvailabilityQueryService`, qui est le
 * seul à lire le cache, n'est pas exporté par `AvailabilityModule` et ne peut
 * donc pas être injecté ici. Un cache périmé peut faire *proposer* un créneau
 * pris ; il ne peut pas en faire *réserver* un.
 *
 * ## Ce que ce module ne pose toujours pas
 *
 * Ni verrou Redis de saisie (#38), ni création au comptoir par le staff (#50) :
 * hors de l'annulation de back-office ouverte par #40, les surfaces de ce module
 * sont celles, publiques, du tunnel de #45.
 */
@Injectable()
export class AppointmentsService {
  public constructor(
    private readonly repository: AppointmentsRepository,
    private readonly services: ServicesService,
    private readonly availability: AvailabilityService,
    private readonly events: AppointmentEvents,
    private readonly lifecycle: AppointmentLifecycleService,
    private readonly cache: AvailabilityCacheService,
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

    // Le créneau vient d'être pris : le cache qui le proposait encore doit
    // partir, sans attendre son TTL (#35).
    await this.cache.invalidateCurrentTenant();

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
   * Déplace un rendez-vous existant : l'ancien est annulé, un nouveau est créé
   * et le référence (#39, booking-engine §5).
   *
   * Reporter ne change ni la prestation, ni la cliente, ni le prix figé à la
   * réservation d'origine : la demande ne porte qu'un instant et, facultatif, un
   * praticien. Tout le reste est recopié par le repository depuis la ligne
   * d'origine, **dans la transaction**.
   *
   * ## Le créneau d'arrivée passe par les mêmes deux contrôles qu'une réservation
   *
   * Le moteur de disponibilité — « ce créneau était-il proposable ? » — puis la
   * contrainte d'exclusion, qui seule tranche l'unicité. Rien n'est relâché
   * parce qu'il s'agit d'un client déjà connu : un report est une écriture dans
   * l'agenda du salon, exactement comme une réservation.
   *
   * ## Une limite connue, et assumée : le nouveau créneau ne peut pas chevaucher l'ancien
   *
   * Le moteur voit le rendez-vous en cours de déplacement comme **occupant** son
   * créneau — il l'est, tant que la transaction n'a pas eu lieu. Avancer d'un
   * quart d'heure un soin d'une heure demande donc un créneau que le calendrier
   * ne propose pas, et reçoit un 409.
   *
   * Ce n'est pas une incohérence : c'est exactement ce que la cliente voit. Le
   * calendrier du tunnel affiche son propre rendez-vous comme pris, et ne lui
   * offre aucun créneau chevauchant — l'agenda réservable et l'agenda affiché
   * restent le même. Lever la limite demanderait au moteur d'exclure un
   * rendez-vous nommé de son calcul, c'est-à-dire de modifier
   * `availability.service.ts`, hors de l'empreinte de ce ticket ; une issue de
   * suivi le porte.
   *
   * @throws {NotFoundError} rendez-vous inconnu ou d'un autre établissement ;
   * prestation retirée du catalogue depuis la réservation.
   * @throws {InvalidStateTransitionError} rendez-vous terminé, annulé ou no-show.
   * @throws {SlotNoLongerAvailableError} le créneau d'arrivée n'est pas — ou
   * n'est plus — proposable.
   */
  public async reschedule(
    input: RescheduleAppointmentInput,
    now: Date = new Date(),
  ): Promise<AppointmentView> {
    const previous = await this.repository.findById(input.appointmentId);

    if (previous === null) {
      // 404 et non 403 : le rendez-vous d'un autre établissement doit être
      // indiscernable d'un identifiant qui n'existe pas (tenant-isolation §4).
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    // Avant le contrôle de disponibilité, et non après lui. Ce n'est pas la
    // garde — celle-là est l'écriture conditionnelle du repository, dans la
    // transaction —, c'est ce qui rend la **réponse** juste : sans elle, un
    // rendez-vous déjà annulé dont le créneau d'arrivée vient d'être pris sort
    // en 409 « choisissez un autre créneau », et la cliente réessaie
    // indéfiniment sans jamais apprendre que son rendez-vous n'existe plus.
    // Même conduite que le `isActive` de `book` : un pré-contrôle qui parle,
    // doublé d'une garantie qui tranche.
    if (!occupiesSlot(previous.status)) {
      throw new InvalidStateTransitionError(previous.status, 'CANCELLED');
    }

    // La prestation ne change pas : c'est celle du rendez-vous d'origine qui
    // donne la durée, les tampons et donc l'intervalle occupé d'arrivée. Si elle
    // a été retirée du catalogue entre-temps, `slotsFor` rend le même 404 que
    // pour une réservation — un soin qu'on ne vend plus ne se replanifie pas.
    const service = await this.services.byId(previous.serviceId);
    const staffId = input.staffId ?? previous.staffId;

    await this.requireOfferedSlot(
      { serviceId: previous.serviceId, staffId, startsAt: input.startsAt },
      now,
    );

    const outcome = await this.move(
      {
        previousId: previous.id,
        staffId,
        ...occupiedRange(input.startsAt, service),
      },
      input.startsAt,
    );

    // Un report change **deux** créneaux d'un coup : celui qu'il libère et celui
    // qu'il occupe. Le cache doit partir pour les deux (#35).
    await this.cache.invalidateCurrentTenant();

    // Après la validation de la transaction, jamais dedans : un `ROLLBACK`
    // laisserait l'ancien rendez-vous en place, et l'avis de déplacement aurait
    // annoncé une heure à laquelle personne n'est attendu.
    const view = billedView(outcome.created, service);
    const before = billedView(outcome.previous, service);

    this.events.appointmentRescheduled({
      tenantId: requireTenantId('Appointment', 'appointment.rescheduled'),
      appointmentId: view.id,
      previousAppointmentId: before.id,
      clientId: view.clientId,
      serviceId: view.serviceId,
      staffId: view.staffId,
      previousStaffId: before.staffId,
      startsAt: view.startsAt,
      endsAt: view.endsAt,
      previousStartsAt: before.startsAt,
      previousEndsAt: before.endsAt,
    });

    return view;
  }

  /**
   * Annule un rendez-vous, en consignant **qui**, **quand** et **pourquoi**
   * (#40, booking-engine §5).
   *
   * ## Une seule méthode pour les deux côtés du comptoir
   *
   * Le premier critère de #40 est « annulation possible par le client et par le
   * salon ». Ce sont deux **surfaces** — la route publique du tunnel et celle du
   * back-office, gardée —, ce n'est pas deux règles : le cycle de vie, la trace
   * écrite et la libération du créneau sont rigoureusement les mêmes. Ce qui
   * change tient dans un champ, `cancelledBy`, et c'est le contrôleur qui le
   * fixe. Deux méthodes auraient divergé sur le jour où l'une aurait gagné un
   * contrôle que l'autre n'aurait pas eu.
   *
   * `cancelledBy` n'est jamais lu du corps de la requête : il se déduit de la
   * porte par laquelle on est entré. Sans cela, une cliente pourrait inscrire au
   * registre du salon que le salon l'avait annulée — et fausser le seul chiffre
   * que cette colonne existe pour établir.
   *
   * ## Deux refus, deux natures
   *
   * `AppointmentLifecycleService` refuse le passage que le cycle de vie
   * n'autorise pas — un rendez-vous terminé, déjà annulé ou no-show sort en 422
   * `INVALID_STATE_TRANSITION`. C'est le quatrième critère de #40, et c'est un
   * **service dédié** qui le porte, jamais le contrôleur.
   *
   * Cette réponse est juste, elle n'est pas une garantie : entre elle et
   * l'écriture, une autre requête peut annuler le même rendez-vous. Ce qui
   * tranche est l'écriture conditionnelle du repository, qui rend un compte de
   * lignes — même partage que pour le report (booking-engine §1).
   *
   * ## Le créneau redevient réservable, et personne n'a à s'en occuper
   *
   * Troisième critère de #40. La ligne passe `CANCELLED`, elle quitte le filtre
   * partiel de `appointments_no_overlap`, le créneau est **réservable** au
   * `COMMIT` — sans purge à écrire. Et sans que la porte s'ouvre à une double
   * réservation : la contrainte continue de juger toute insertion sur cet
   * intervalle, exactement comme avant.
   *
   * Réservable ne veut pas dire *visible* : le calendrier lit un cache, que #35
   * a branché sur Redis depuis. L'invalidation ajoutée ci-dessous est ce qui
   * rend le créneau libéré visible tout de suite, plutôt qu'à l'expiration du
   * TTL. Elle ne touche pas la garantie, qui reste celle de la base ; elle
   * touche le chiffre d'affaires.
   *
   * @throws {NotFoundError} rendez-vous inconnu ou d'un autre établissement.
   * @throws {InvalidStateTransitionError} rendez-vous terminé, déjà annulé ou
   * no-show.
   * @throws {ConflictError} deux annulations concurrentes, dont une seule
   * inscrit son auteur et son motif.
   */
  public async cancel(
    input: CancelAppointmentInput,
    now: Date = new Date(),
  ): Promise<AppointmentView> {
    const previous = await this.repository.findById(input.appointmentId);

    if (previous === null) {
      // 404 et non 403 : le rendez-vous d'un autre établissement doit être
      // indiscernable d'un identifiant qui n'existe pas (tenant-isolation §4).
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    // Le service dédié, avant toute écriture. Il ne protège pas la base — c'est
    // l'`UPDATE` conditionnel qui le fait — il rend la **réponse** juste.
    this.lifecycle.requireTransition(previous.status, 'CANCELLED');

    // Le même refus, dit dans les termes de la contrainte d'exclusion. Il ne
    // peut pas se déclencher : le témoin d'`appointment-lifecycle.spec.ts`
    // prouve que « ce qui peut être annulé » et « ce qui occupe l'agenda » sont
    // la même liste. Il est écrit parce que TypeScript ne sait pas déduire cette
    // égalité d'un appel qui ne rend rien, et parce que l'événement de domaine
    // annonce un statut d'origine **occupant** — le jour où les deux listes
    // divergeraient, c'est ici que cela se verrait, et non dans un abonné qui
    // recevrait `COMPLETED`.
    if (!occupiesSlot(previous.status)) {
      throw new InvalidStateTransitionError(previous.status, 'CANCELLED');
    }

    // Avant l'écriture, et pour la même raison qu'au report : la prestation
    // donne les tampons dont la vue facturée se déduit. Une prestation retirée
    // du catalogue reste lisible — `byId` ne refuse que ce qui n'existe pas ou
    // qui est ailleurs — et il n'y aurait aucun sens à empêcher d'annuler un
    // rendez-vous parce que le soin n'est plus vendu.
    const service = await this.services.byId(previous.serviceId);

    const record = await this.repository.cancel({
      appointmentId: previous.id,
      cancelledAt: now,
      cancelledBy: input.cancelledBy,
      reason: input.reason,
    });

    // Le créneau est réservable depuis le `COMMIT` ; le cache, lui, l'ignore
    // encore. C'est le cas où l'invalidation rapporte le plus : un créneau libre
    // masqué soixante secondes est une vente perdue (#35, booking-engine §3).
    await this.cache.invalidateCurrentTenant();

    // Après l'écriture, jamais dedans : annoncer une annulation qu'un `ROLLBACK`
    // effacerait ensuite décommanderait une cliente toujours attendue.
    const view = billedView(record, service);

    this.events.appointmentCancelled({
      tenantId: requireTenantId('Appointment', 'appointment.cancelled'),
      appointmentId: view.id,
      clientId: view.clientId,
      serviceId: view.serviceId,
      staffId: view.staffId,
      startsAt: view.startsAt,
      endsAt: view.endsAt,
      // Le statut d'**avant**, relu sur la ligne d'origine : c'est lui qui dit à
      // l'aval s'il y avait un rappel J-1 à déprogrammer. Le statut d'après est
      // toujours `CANCELLED`, et n'apprend donc rien.
      previousStatus: previous.status,
      cancelledBy: input.cancelledBy,
      cancelledAt: now.toISOString(),
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
    return this.inBilledTerms(() => this.repository.create(draft), draft.staffId, billedStart);
  }

  /** Le report, avec le même retour à l'heure du soin que `insert`. */
  private async move(draft: RescheduleDraft, billedStart: Date): Promise<RescheduleOutcome> {
    return this.inBilledTerms(() => this.repository.reschedule(draft), draft.staffId, billedStart);
  }

  /**
   * Rejoue un refus de créneau avec l'heure du **soin**, celle que l'appelant a
   * soumise.
   *
   * Écrit une fois pour les deux écritures : dupliquer cette traduction, c'est
   * en oublier une le jour où une troisième surface écrira dans l'agenda, et
   * rendre à la cliente une heure qu'elle n'a jamais demandée.
   */
  private async inBilledTerms<T>(
    operation: () => Promise<T>,
    staffId: string,
    billedStart: Date,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof SlotNoLongerAvailableError) {
        throw new SlotNoLongerAvailableError(staffId, billedStart);
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
  private async requireOfferedSlot(input: OfferedSlotQuery, now: Date): Promise<void> {
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
 * Ce que le contrôle de disponibilité a besoin de savoir — et rien de plus.
 *
 * Réservation et report l'alimentent tous deux : la première depuis la demande
 * de la cliente, le second depuis le rendez-vous d'origine augmenté du praticien
 * choisi. Un paramètre typé `BookAppointmentInput` aurait obligé le report à
 * fabriquer des coordonnées de cliente dont ce contrôle n'a que faire.
 */
interface OfferedSlotQuery {
  readonly serviceId: string;
  readonly staffId: string;
  /** Instant du **soin**, tel que le calendrier l'a proposé. */
  readonly startsAt: Date;
}

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
 *
 * ## Les tampons sont ceux du catalogue **au moment de la lecture**
 *
 * L'intervalle occupé est en base, le facturé s'en déduit avec les tampons de la
 * prestation. Appliqué au rendez-vous que #39 vient de créer, l'écart est nul —
 * il vient d'être écrit avec ces tampons-là. Appliqué au rendez-vous
 * **remplacé**, il ne l'est plus si le salon a modifié ses temps de cabine
 * depuis : l'ancienne heure annoncée dans l'avis de déplacement dérive alors de
 * la différence. Corriger cela demanderait de figer les tampons sur la ligne, au
 * même titre que le prix — un changement de schéma qui sort du périmètre de ce
 * ticket, pour un écart de quelques minutes sur une heure déjà passée.
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
    rescheduledFromId: record.rescheduledFromId,
    cancelledAt: record.cancelledAt === null ? null : record.cancelledAt.toISOString(),
    cancelledBy: record.cancelledBy,
    // `cancellationReason` n'est **pas** recopié, et son absence est le propos :
    // la vue est la sortie unique du module, servie aussi bien à la cliente
    // qu'au comptoir, et un motif écrit par un praticien est une note interne.
    // Voir `AppointmentView` (#40).
  };
}

/** Les dates civiles UTC de la veille et du lendemain — voir `requireOfferedSlot`. */
function utcDaysAround(instant: Date): { from: string; to: string } {
  return {
    from: new Date(instant.getTime() - DAY_MS).toISOString().slice(0, 10),
    to: new Date(instant.getTime() + DAY_MS).toISOString().slice(0, 10),
  };
}
