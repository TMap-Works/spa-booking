import { randomUUID } from 'node:crypto';

import { InvalidStateTransitionError, NotFoundError } from '../../../common/errors';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { getTenantId } from '../../../common/tenant';
import type { CacheConnection, CacheLockOutcome } from '../../../infrastructure/cache/cache.connection';
import type { AppointmentCancelledBy, AppointmentStatus } from '../appointment-status';
import { OCCUPYING_STATUSES, occupiesSlot } from '../appointment-status';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import type { AppointmentsRepository } from '../appointments.repository';
import { SlotLockService } from '../slot-lock.service';
import type {
  AppointmentDraft,
  AppointmentRecord,
  CancelDraft,
  ClientAppointmentsQuery,
  GuestContact,
  RescheduleDraft,
  RescheduleOutcome,
} from '../appointments.types';

/**
 * Doubles du module `appointments`, partagés par ses suites unitaires et par les
 * suites d'intégration et d'isolation.
 *
 * Le dépôt en mémoire reproduit **quatre propriétés précises** du vrai, et
 * chacune porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent. C'est ce que l'extension Prisma
 *    fait en vrai. Un double qui ignorerait le tenant ferait passer les tests
 *    d'isolation pour de mauvaises raisons, ce qui est pire que de ne pas les
 *    écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération ;
 * 3. la **contrainte d'exclusion** — un chevauchement sur le même praticien, dans
 *    le même établissement, parmi les statuts qui occupent le créneau, lève la
 *    même `SlotNoLongerAvailableError` que la traduction du refus de PostgreSQL.
 *    Bornes `[)` : deux rendez-vous adjacents restent légaux ;
 * 4. l'**unicité `(tenant_id, email)`** des fiches clientes, qui est ce qui rend
 *    `findOrCreateClient` idempotent ;
 * 5. l'**atomicité du report** — l'annulation précède l'insertion, donc libère
 *    l'intervalle d'origine ; et si l'insertion est refusée, l'ancien rendez-vous
 *    retrouve son statut. C'est ce que le `ROLLBACK` fait en vrai, et un double
 *    qui laisserait l'ancien annulé après un refus ferait passer pour vert le
 *    seul scénario que #39 doit rendre impossible ;
 * 6. la **libération du créneau par l'annulation** — une ligne annulée sort de
 *    `overlaps`, exactement comme elle sort du filtre partiel de la contrainte.
 *    C'est le troisième critère de #40, et un double qui compterait encore la
 *    ligne annulée ferait échouer une reréservation pourtant légitime.
 *
 * ## Ce que ce double ne prouve pas, et ne prétend pas prouver
 *
 * La contrainte elle-même. `appointments_no_overlap` vit en base, et c'est
 * `test/appointments-exclusion.integration-spec.ts` qui l'exerce contre un vrai
 * PostgreSQL — y compris sous concurrence, ce qu'aucun double en mémoire ne peut
 * simuler (booking-engine §6). Ce que ce double reproduit, c'est le **contrat du
 * repository** vu du service : quand un chevauchement existe, l'appelant reçoit
 * `SlotNoLongerAvailableError` et non une erreur brute.
 */

interface StoredAppointment {
  tenantId: string;
  id: string;
  clientId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  priceAmountMinor: number;
  priceCurrency: string;
  clientNote: string | null;
  /**
   * La note interne du praticien (#317).
   *
   * Portée par le stock et **jamais par `toRecord`** : c'est exactement la
   * conduite du vrai repository, dont le `select` de sortie ne la demande pas.
   * Un double qui la ferait ressortir rendrait vert le seul scénario que ce
   * ticket doit rendre impossible — la note interne servie au parcours public.
   */
  staffNote: string | null;
  rescheduledFromId: string | null;
  cancelledAt: Date | null;
  cancelledBy: AppointmentCancelledBy | null;
  cancellationReason: string | null;
}

/** L'intervalle **occupé** d'un praticien — ce que la contrainte compare. */
interface OccupiedRange {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

interface StoredClient {
  tenantId: string;
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

export class FakeAppointmentsRepository {
  public readonly appointments: StoredAppointment[] = [];
  public readonly clients: StoredClient[] = [];

  /** Une fiche cliente déjà présente — la cliente qui revient. */
  public seedClient(input: {
    tenantId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
  }): StoredClient {
    const client: StoredClient = {
      tenantId: input.tenantId,
      id: randomUUID(),
      email: input.email,
      firstName: input.firstName ?? 'Cliente',
      lastName: input.lastName ?? 'Fidèle',
      phone: input.phone ?? null,
    };
    this.clients.push(client);
    return client;
  }

  /** Un rendez-vous déjà posé — de quoi produire un conflit de créneau. */
  public seedAppointment(input: {
    tenantId: string;
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    status?: AppointmentStatus;
    clientId?: string;
    serviceId?: string;
    /** La note interne du praticien — de quoi exercer sa reprise au report (#317). */
    staffNote?: string | null;
  }): StoredAppointment {
    const appointment: StoredAppointment = {
      tenantId: input.tenantId,
      id: randomUUID(),
      clientId: input.clientId ?? randomUUID(),
      staffId: input.staffId,
      serviceId: input.serviceId ?? randomUUID(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: input.status ?? 'PENDING',
      priceAmountMinor: 0,
      priceCurrency: 'EUR',
      clientNote: null,
      staffNote: input.staffNote ?? null,
      rescheduledFromId: null,
      // Semé sans trace d'annulation, y compris quand le statut est `CANCELLED` :
      // une suite qui veut la trace passe par `cancel`, qui est ce qui l'écrit.
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    };
    this.appointments.push(appointment);
    return appointment;
  }

  public async create(draft: AppointmentDraft): Promise<AppointmentRecord> {
    const tenantId = this.requireTenant();

    if (this.overlaps(tenantId, draft)) {
      throw new SlotNoLongerAvailableError(draft.staffId, draft.startsAt);
    }

    const stored: StoredAppointment = {
      tenantId,
      id: randomUUID(),
      clientId: draft.clientId,
      staffId: draft.staffId,
      serviceId: draft.serviceId,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      // Le défaut de la colonne, et non un choix de l'appelant : le rendez-vous
      // occupe l'agenda dès sa création.
      status: 'PENDING',
      priceAmountMinor: draft.price.amountMinor,
      priceCurrency: draft.price.currency,
      clientNote: draft.clientNote,
      // Une réservation ne peut pas porter de note interne : `AppointmentDraft`
      // n'en a pas de champ, et c'est délibéré — la note s'écrit au back-office.
      staffNote: null,
      rescheduledFromId: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    };
    this.appointments.push(stored);
    return toRecord(stored);
  }

  /**
   * Le report : annulation de l'ancien, création du nouveau, **ou rien**.
   *
   * Reproduit les trois propriétés du vrai qui comptent pour l'appelant :
   *
   * 1. l'annulation **précède** l'insertion, donc l'intervalle d'origine est
   *    libre au moment où le chevauchement est jugé — c'est ce qui rend légal un
   *    déplacement vers un créneau adjacent au sien ;
   * 2. un refus de créneau **remet l'ancien rendez-vous dans son état** : c'est
   *    le `ROLLBACK` de la transaction, et c'est le troisième critère de #39 ;
   * 3. le nouveau rendez-vous **reprend** le statut, la cliente, la prestation,
   *    le prix et les deux notes de l'ancien — rien de tout cela ne vient de la
   *    demande. La note interne (#317) est reprise dans le stock et **absente**
   *    du `AppointmentRecord` rendu, comme dans le vrai : c'est ce qui permet
   *    d'exercer les deux moitiés du ticket depuis le service.
   */
  public async reschedule(draft: RescheduleDraft): Promise<RescheduleOutcome> {
    const tenantId = this.requireTenant();

    const previous = this.appointments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === draft.previousId,
    );

    if (previous === undefined) {
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    if (!occupiesSlot(previous.status)) {
      throw new InvalidStateTransitionError(previous.status, 'CANCELLED');
    }

    const before = previous.status;
    previous.status = 'CANCELLED';
    // Comme le vrai : un report horodate l'annulation de la ligne d'origine,
    // sans lui donner ni auteur ni motif — ce n'est pas un abandon.
    previous.cancelledAt = new Date();

    if (this.overlaps(tenantId, draft)) {
      // Le `ROLLBACK` : sans ces lignes, un créneau refusé laisserait la cliente
      // sans rendez-vous du tout.
      previous.status = before;
      previous.cancelledAt = null;
      throw new SlotNoLongerAvailableError(draft.staffId, draft.startsAt);
    }

    const stored: StoredAppointment = {
      tenantId,
      id: randomUUID(),
      clientId: previous.clientId,
      staffId: draft.staffId,
      serviceId: previous.serviceId,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      status: before,
      priceAmountMinor: previous.priceAmountMinor,
      priceCurrency: previous.priceCurrency,
      clientNote: previous.clientNote,
      // La note suit le rendez-vous, pas le créneau (#317).
      staffNote: previous.staffNote,
      rescheduledFromId: previous.id,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    };
    this.appointments.push(stored);

    return {
      previous: toRecord({ ...previous, status: before, cancelledAt: null }),
      created: toRecord(stored),
    };
  }

  /**
   * L'annulation : trace écrite et créneau libéré, **ou rien** (#40).
   *
   * Reproduit les trois propriétés du vrai dont l'appelant dépend :
   *
   * 1. la trace est posée d'un seul geste — statut, horodatage, auteur, motif —
   *    et rien n'est écrit si le rendez-vous n'occupe plus son créneau ;
   * 2. le créneau redevient libre **immédiatement**, parce que `overlaps` ne
   *    compte que les statuts occupants — comme le filtre partiel de
   *    `appointments_no_overlap` en base ;
   * 3. un rendez-vous d'un autre établissement est **introuvable**, jamais
   *    interdit : `NotFoundError`, donc 404, jamais 403.
   */
  public async cancel(draft: CancelDraft): Promise<AppointmentRecord> {
    const tenantId = this.requireTenant();

    const found = this.appointments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === draft.appointmentId,
    );

    if (found === undefined) {
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    if (!occupiesSlot(found.status)) {
      throw new InvalidStateTransitionError(found.status, 'CANCELLED');
    }

    found.status = 'CANCELLED';
    found.cancelledAt = draft.cancelledAt;
    found.cancelledBy = draft.cancelledBy;
    found.cancellationReason = draft.reason;

    return toRecord(found);
  }

  public async findById(id: string): Promise<AppointmentRecord | null> {
    const tenantId = this.requireTenant();
    const found = this.appointments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return found === undefined ? null : toRecord(found);
  }

  /**
   * L'historique d'une cliente — la moitié demandée, bornée (#47).
   *
   * Reproduit les quatre propriétés du vrai dont l'appelant dépend :
   *
   * 1. le **scoping par tenant** — une cliente du salon voisin ne ramène rien,
   *    même identifiant, autre portée ;
   * 2. les deux moitiés **disjointes et complémentaires** — « pas terminé et
   *    occupant encore le créneau » d'un côté, le complément exact de l'autre.
   *    Un double qui filtrerait « passé » sur la seule borne de temps laisserait
   *    les annulations futures hors des deux, donc invisibles — exactement le
   *    défaut que ce prédicat existe pour empêcher ;
   * 3. l'**ordre** — croissant à venir, décroissant en historique, `id` pour
   *    départager. Un double qui rendrait l'ordre d'insertion ferait passer une
   *    assertion d'ordre pour de mauvaises raisons ;
   * 4. le **plafond**, appliqué après le tri et non avant.
   */
  public async listForClient(query: ClientAppointmentsQuery): Promise<AppointmentRecord[]> {
    const tenantId = this.requireTenant();
    const upcoming = query.scope === 'upcoming';

    return this.appointments
      .filter((candidate) => {
        if (candidate.tenantId !== tenantId || candidate.clientId !== query.clientId) {
          return false;
        }
        const stillDue =
          candidate.endsAt > query.now &&
          (OCCUPYING_STATUSES as readonly AppointmentStatus[]).includes(candidate.status);
        return upcoming ? stillDue : !stillDue;
      })
      .sort((left, right) => {
        const byInstant = left.startsAt.getTime() - right.startsAt.getTime();
        const byId = left.id.localeCompare(right.id);
        return upcoming ? byInstant || byId : -byInstant || -byId;
      })
      .slice(0, query.limit)
      .map(toRecord);
  }

  public async findOrCreateClient(contact: GuestContact): Promise<string> {
    const tenantId = this.requireTenant();

    const existing = this.clients.find(
      (candidate) => candidate.tenantId === tenantId && candidate.email === contact.email,
    );
    if (existing !== undefined) {
      // Comme le vrai : une fiche trouvée n'est **pas** mise à jour. Un appel
      // public ne réécrit pas le nom ni le numéro d'une cliente existante.
      return existing.id;
    }

    const created: StoredClient = {
      tenantId,
      id: randomUUID(),
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
    };
    this.clients.push(created);
    return created.id;
  }

  /**
   * Le prédicat de `appointments_no_overlap`, reproduit à l'identique : même
   * établissement, même praticien, statut occupant, et intervalles `[)` qui se
   * chevauchent. `startsAt < other.endsAt && endsAt > other.startsAt` — donc deux
   * rendez-vous qui se touchent ne se chevauchent pas.
   */
  private overlaps(tenantId: string, wanted: OccupiedRange): boolean {
    return this.appointments.some(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.staffId === wanted.staffId &&
        (OCCUPYING_STATUSES as readonly AppointmentStatus[]).includes(candidate.status) &&
        wanted.startsAt < candidate.endsAt &&
        wanted.endsAt > candidate.startsAt,
    );
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Défaut fermé, comme l'extension : sans tenant, pas de données. Ne jamais
      // retomber sur « toutes les lignes » — c'est le mode ouvert qui fuit.
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }
    return tenantId;
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asRepository(): AppointmentsRepository {
    return this as unknown as AppointmentsRepository;
  }
}

/**
 * Le cache Redis réduit à sa primitive de verrou (#38).
 *
 * Reproduit les trois propriétés du vrai dont dépend le chemin de réservation,
 * et rien d'autre :
 *
 * 1. `SET NX` — la seconde prise d'une clé déjà tenue rend `taken` ;
 * 2. la **libération conditionnée au jeton** — relâcher avec un jeton étranger
 *    ne fait rien, comme le script Lua ;
 * 3. la **panne**, qui rend `unavailable` et jamais `taken`. C'est ce que
 *    `failWith` bascule, et c'est le seul moyen d'exercer « une panne Redis ne
 *    casse pas la réservation » sans arrêter un conteneur.
 *
 * `held` et `releases` sont là pour ce qu'aucune assertion sur le résultat ne
 * montrerait : que le verrou a bien été **relâché**, y compris quand l'écriture
 * qu'il encadrait a échoué.
 */
export class FakeCacheLocks {
  /** Les verrous vivants, par clé, avec le jeton de leur détenteur. */
  public readonly held = new Map<string, string>();
  /** Les clés relâchées, dans l'ordre. */
  public readonly releases: string[] = [];
  /** Les TTL demandés, par clé — le « court » du premier critère. */
  public readonly ttls = new Map<string, number>();
  /** Bascule l'ensemble en panne : toute commande rejette. */
  public failWith: Error | null = null;

  /** Pose un verrou tenu par quelqu'un d'autre — la contention. */
  public seedHeld(key: string): void {
    this.held.set(key, 'jeton-d-un-autre');
  }

  public acquireLock(key: string, ttlSeconds: number): Promise<CacheLockOutcome> {
    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }

    if (this.held.has(key)) {
      return Promise.resolve({ state: 'taken' });
    }

    const token = randomUUID();
    this.held.set(key, token);
    this.ttls.set(key, ttlSeconds);

    return Promise.resolve({ state: 'acquired', token });
  }

  public releaseLock(key: string, token: string): Promise<void> {
    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }

    // Conditionné au jeton, comme le script Lua : un appelant dont le verrou a
    // expiré ne supprime pas celui de son successeur.
    if (this.held.get(key) === token) {
      this.held.delete(key);
      this.releases.push(key);
    }

    return Promise.resolve();
  }

  /** Vue typée pour l'injection — le service n'utilise que ces deux méthodes. */
  public asConnection(): CacheConnection {
    return this as unknown as CacheConnection;
  }

  /** Le **vrai** service de verrou, branché sur ce double. */
  public asService(): SlotLockService {
    return new SlotLockService(this.asConnection(), silentLogger());
  }
}

function silentLogger(): StructuredLogger {
  return {
    error: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;
}

function toRecord(stored: StoredAppointment): AppointmentRecord {
  return {
    id: stored.id,
    clientId: stored.clientId,
    staffId: stored.staffId,
    serviceId: stored.serviceId,
    startsAt: stored.startsAt,
    endsAt: stored.endsAt,
    status: stored.status,
    price: { amountMinor: stored.priceAmountMinor, currency: stored.priceCurrency },
    clientNote: stored.clientNote,
    rescheduledFromId: stored.rescheduledFromId,
    cancelledAt: stored.cancelledAt,
    cancelledBy: stored.cancelledBy,
    cancellationReason: stored.cancellationReason,
  };
}
