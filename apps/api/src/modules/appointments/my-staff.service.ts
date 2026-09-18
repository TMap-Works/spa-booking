import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { StaffScheduleService } from '../availability/staff-schedule.service';
import { StaffTimeOffService } from '../availability/staff-time-off.service';
import { TenantClockService } from '../availability/tenant-clock.service';
import { agendaWindowOf, resolveAgendaRange } from './agenda-window';
import { StaffProfileNotFoundError } from './appointments.errors';
import { AppointmentsRepository } from './appointments.repository';
import type {
  AgendaAppointmentRecord,
  MyStaffAgendaView,
  MyStaffAppointmentView,
  MyStaffRangeInput,
  MyStaffScheduleView,
  ResolvedRange,
  StaffProfileRecord,
  StaffProfileView,
} from './appointments.types';
import { billedIntervalOf } from './billed-interval';

/**
 * L'espace du **praticien connecté** — « les staffs doivent avoir un aperçu de
 * leur emploi du temps » (#811, CDC §1.3).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## La seule propriété que ce service existe pour tenir
 *
 * > Le praticien dont on sert l'agenda est celui du **jeton**, et il n'y a aucun
 * > chemin par lequel en désigner un autre.
 *
 * Aucune méthode ici ne reçoit de `staffId` : `MyStaffRangeInput` n'en porte pas,
 * les schémas de requête `.strict()` du contrat refusent le champ en 400, et la
 * résolution passe par `findStaffByUserId`, dont le `where` est complété par
 * l'extension Prisma avec le `tenantId` du contexte. Un praticien du salon B qui
 * appellerait ces routes avec son propre jeton ne trouverait rien du salon A —
 * non pas parce qu'une comparaison l'aurait rattrapé, mais parce que la lecture
 * n'atteint jamais ses lignes (tenant-isolation §3).
 *
 * C'est aussi ce qui rend impossible le second scénario du ticket, « voir
 * l'agenda d'un collègue » : le `staffId` passé au repository est celui que
 * `(tenantId, userId)` a rendu, jamais celui qu'on aurait demandé.
 *
 * ## Ce que ce service **n'écrit pas**
 *
 * Rien. Les trois routes sont des lectures, et c'est ce qui permet de les servir
 * au rang `STAFF` sans ouvrir quoi que ce soit : un praticien lit sa semaine, il
 * ne la modifie pas — poser ses horaires ou ses congés reste du back-office
 * (`PUT /staff/{id}/schedule`, `POST /staff-time-off`), gardé au rang qui
 * convient.
 *
 * ## Les trois emprunts, et pourquoi aucun n'est un import de repository
 *
 * `StaffScheduleService` et `StaffTimeOffService` sont les **portes** que
 * `AvailabilityModule` exporte, et ce module les importe déjà (api-module §3).
 * Les jours de fermeture, eux, n'ont pas de porte : ils se lisent par
 * `AppointmentsRepository.listClosedWeekdays`, une lecture d'une seule colonne
 * documentée là-bas, sur le modèle de `currentTimeZone`.
 */
@Injectable()
export class MyStaffService {
  public constructor(
    private readonly repository: AppointmentsRepository,
    /**
     * Le convertisseur de fuseau — il ne lit rien, il calcule. Le fuseau lui est
     * donné par le repository de ce module, comme pour l'agenda du comptoir.
     */
    private readonly clock: TenantClockService,
    private readonly schedules: StaffScheduleService,
    private readonly timeOff: StaffTimeOffService,
  ) {}

  /**
   * La fiche praticien du compte connecté — premier critère de #811.
   *
   * @throws {StaffProfileNotFoundError} le compte n'a pas de fiche dans cet
   * établissement — le cas ordinaire d'un manager qui ne donne pas de soins.
   */
  public async profile(userId: string): Promise<StaffProfileView> {
    const staff = await this.repository.findStaffByUserId(userId);

    if (staff === null) {
      throw new StaffProfileNotFoundError();
    }

    return {
      id: staff.id,
      displayName: staff.displayName,
      // Omise plutôt que rendue à `null` : `staffMemberSchema` la déclare
      // `.optional()`, et un `null` explicite y échouerait — toute la fiche
      // cesserait de se lire pour une présentation non renseignée.
      ...(staff.bio === null ? {} : { bio: staff.bio }),
      isActive: staff.isActive,
    };
  }

  /**
   * Les rendez-vous du praticien connecté, sur la fenêtre demandée — deuxième
   * critère.
   *
   * ## La lecture est celle de l'agenda du comptoir, filtrée sur ce praticien
   *
   * `listAgenda` et non une requête de plus : les deux surfaces posent la même
   * question à la base — « les rendez-vous de cette fenêtre » —, et deux lectures
   * auraient fini par diverger d'un `include` ou d'un tri. Ce qui les distingue
   * est en aval, dans la **projection** : le comptoir voit le nom complet, le
   * prix figé, le motif d'annulation et la preuve de consentement ; le praticien
   * voit ce qu'il fait à cette heure-là et pour qui. La frontière n'est donc pas
   * une requête différente, c'est un `view` différent — et il est écrit une fois.
   *
   * Aucun filtre de statut : un planning montre aussi ce qui a été annulé, sans
   * quoi le praticien croirait devoir tenir un créneau libéré.
   *
   * @throws {StaffProfileNotFoundError} aucune fiche rattachée à ce compte.
   * @throws {AppointmentRangeTooWideError} fenêtre inversée ou au-delà de 31 jours.
   */
  public async agenda(
    input: MyStaffRangeInput,
    now: Date = new Date(),
  ): Promise<MyStaffAgendaView> {
    const { staff, range } = await this.resolve(input, now);
    const window = agendaWindowOf(range, this.clock);

    const records = await this.repository.listAgenda({
      from: window.from,
      to: window.to,
      // Le praticien du **jeton**, jamais celui d'un paramètre : c'est ici, et
      // dans cette ligne seule, que se joue tout le ticket.
      staffId: staff.id,
      clientId: null,
      serviceId: null,
      statuses: null,
    });

    return {
      staffId: staff.id,
      timezone: range.timeZone,
      from: range.from,
      to: range.to,
      // Trié sur l'instant **facturé**, celui que la réponse porte — la base,
      // elle, ordonne sur l'occupé. Les deux ne coïncident que si toutes les
      // prestations ont le même tampon avant. Même raison, et même remède, que
      // dans `AppointmentsService.listAgenda`.
      appointments: records
        .map((record) => this.appointmentView(record, range.timeZone))
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    };
  }

  /**
   * Les horaires récurrents, les absences et les jours de fermeture — troisième
   * critère.
   *
   * Les trois lectures partent **ensemble** : elles ne dépendent pas les unes des
   * autres, et les enchaîner aurait fait trois allers-retours là où l'écran en
   * attend un.
   *
   * ## Pourquoi les horaires ne sont pas bornés par la fenêtre
   *
   * Parce qu'ils sont **récurrents** : « le mardi de 9 h à 18 h » n'appartient à
   * aucune date, et les découper sur la fenêtre aurait rendu une semaine
   * déployée jour par jour — trente et une lignes pour dire ce qu'une seule dit.
   * C'est l'écran qui projette la semaine sur ses dates, avec `timezone` et
   * `closedWeekdays` pour le faire juste. Les absences, elles, portent des
   * instants et sont bien bornées.
   *
   * @throws {StaffProfileNotFoundError} aucune fiche rattachée à ce compte.
   * @throws {AppointmentRangeTooWideError} fenêtre inversée ou au-delà de 31 jours.
   */
  public async schedule(
    input: MyStaffRangeInput,
    now: Date = new Date(),
  ): Promise<MyStaffScheduleView> {
    const { staff, range } = await this.resolve(input, now);
    const window = agendaWindowOf(range, this.clock);

    const [schedule, timeOff, closedWeekdays] = await Promise.all([
      this.schedules.forStaff(staff.id),
      this.timeOff.list({ from: window.from, to: window.to }, staff.id),
      this.repository.listClosedWeekdays(),
    ]);

    return {
      staffId: staff.id,
      timezone: range.timeZone,
      from: range.from,
      to: range.to,
      entries: schedule.entries,
      timeOff,
      closedWeekdays,
    };
  }

  /**
   * La fiche du jeton et la fenêtre résolue, en **une** paire de lectures.
   *
   * Les deux partent ensemble parce qu'aucune ne dépend de l'autre, et l'ordre
   * des refus est fixé **après** : fiche absente d'abord, fenêtre ensuite. C'est
   * l'ordre que l'appelant attend — inutile de lui reprocher sa plage quand le
   * problème est qu'il n'a pas d'agenda du tout —, et le faire dépendre de
   * l'ordre d'arrivée de deux promesses aurait rendu la réponse non
   * déterministe.
   */
  private async resolve(
    input: MyStaffRangeInput,
    now: Date,
  ): Promise<{ staff: StaffProfileRecord; range: ResolvedRange }> {
    const [staff, timeZone] = await Promise.all([
      this.repository.findStaffByUserId(input.userId),
      this.repository.currentTimeZone(),
    ]);

    if (staff === null) {
      throw new StaffProfileNotFoundError();
    }

    if (timeZone === null) {
      // `tenants.timezone` est `NOT NULL` : l'absence ne peut venir que d'un
      // établissement qui n'existe pas. Même repli que l'agenda du comptoir.
      throw new NotFoundError('Établissement introuvable.');
    }

    // La règle de fenêtre est celle de l'agenda du comptoir, et elle n'est plus
    // recopiée ici : `resolveAgendaRange` est le seul endroit qui complète les
    // bornes, retombe sur la journée du salon et refuse au-delà de la borne du
    // contrat (#932). `MyStaffRangeInput` le satisfait structurellement — le
    // `userId` qu'il porte en plus ne l'intéresse pas.
    //
    // `calendarDateOf` et non la date du serveur : c'est le seul endroit qui
    // sache quel jour il est à Papeete quand il est déjà demain à Paris.
    return {
      staff,
      range: resolveAgendaRange(input, {
        timeZone,
        today: this.clock.calendarDateOf(now, timeZone),
      }),
    };
  }

  /**
   * Un rendez-vous, projeté pour le praticien qui le tient.
   *
   * Volontairement plus étroit que la ligne d'agenda : ni prix, ni `staff`
   * imbriqué — il sait qui il est —, ni motif d'annulation, ni preuve de
   * consentement. Ce sont des données de registre, et elles ont leur route.
   */
  private appointmentView(
    record: AgendaAppointmentRecord,
    timeZone: string,
  ): MyStaffAppointmentView {
    const billed = billedIntervalOf(record, record.service);

    return {
      id: record.id,
      reference: record.reference,
      status: record.status,
      startsAt: billed.startsAt.toISOString(),
      endsAt: billed.endsAt.toISOString(),
      // Recalculé **pour cet instant-là**, jamais mémorisé : c'est la seule
      // façon qu'un rendez-vous du 25 octobre et un du 27 portent chacun le bon
      // décalage dans la même réponse (booking-engine §4).
      utcOffsetMinutes: this.clock.offsetMinutesAt(billed.startsAt, timeZone),
      service: {
        id: record.service.id,
        name: record.service.name,
        durationMinutes: record.service.durationMinutes,
      },
      client: {
        firstName: record.client.firstName,
        lastInitial: initialOf(record.client.lastName),
      },
      ...(record.clientNote === null ? {} : { clientNote: record.clientNote }),
      // Servie ici pour la raison qui la sert au comptoir : c'est un champ de
      // back-office, cette route est gardée au rang `STAFF`, et le praticien en
      // est le premier lecteur — souvent l'auteur.
      ...(record.staffNote === null ? {} : { staffNote: record.staffNote }),
    };
  }
}

/**
 * L'initiale d'un nom de famille — un caractère, en capitale, sans point.
 *
 * ## Pourquoi `Array.from` deux fois plutôt que `charAt(0).toUpperCase()`
 *
 * Deux pièges, et chacun casse le contrat s'il n'est pas traité :
 *
 * 1. `charAt(0)` rend une **demi-paire de substitution** sur un nom qui commence
 *    hors du plan multilingue de base — l'initiale devient un caractère de
 *    remplacement à l'affichage. `Array.from` itère par point de code ;
 * 2. `'ß'.toUpperCase()` rend `'SS'`, deux caractères là où le contrat en
 *    déclare au plus un. La seconde itération ne garde que le premier.
 *
 * La chaîne vide est rendue pour un nom vide. Elle ne devrait pas se produire —
 * `users.last_name` est `NOT NULL` et `nameSchema` exige un caractère — mais
 * lever ici aurait fait échouer un planning entier pour une ligne historique mal
 * formée, ce que `myStaffAppointmentClientSchema` accepte délibérément.
 */
function initialOf(lastName: string): string {
  const first = Array.from(lastName.trim())[0];

  if (first === undefined) {
    return '';
  }

  return Array.from(first.toUpperCase())[0] ?? first;
}
