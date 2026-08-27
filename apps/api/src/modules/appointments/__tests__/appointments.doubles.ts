import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { AppointmentStatus } from '../appointment-status';
import { OCCUPYING_STATUSES } from '../appointment-status';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import type { AppointmentsRepository } from '../appointments.repository';
import type { AppointmentDraft, AppointmentRecord, GuestContact } from '../appointments.types';

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
 *    `findOrCreateClient` idempotent.
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
    };
    this.appointments.push(stored);
    return toRecord(stored);
  }

  public async findById(id: string): Promise<AppointmentRecord | null> {
    const tenantId = this.requireTenant();
    const found = this.appointments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return found === undefined ? null : toRecord(found);
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
  private overlaps(tenantId: string, draft: AppointmentDraft): boolean {
    return this.appointments.some(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.staffId === draft.staffId &&
        (OCCUPYING_STATUSES as readonly AppointmentStatus[]).includes(candidate.status) &&
        draft.startsAt < candidate.endsAt &&
        draft.endsAt > candidate.startsAt,
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
  };
}
