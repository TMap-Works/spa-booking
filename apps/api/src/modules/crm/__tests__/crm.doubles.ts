import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { AppointmentStatus } from '../../appointments/appointment-status';
import { CustomerEmailTakenError } from '../crm.errors';
import type {
  CrmRepository,
  CustomerPatch,
  CustomerSearchCriteria,
  CustomerSearchResult,
  HonoredTotalByCurrency,
  VisitBounds,
  VisitCountByStatus,
} from '../crm.repository';
import type { Customer, CustomerSummary, CustomerVisit } from '../crm.types';

/**
 * Doubles du module `crm`, partagés par ses suites unitaires et par les suites
 * d'isolation d'`apps/api/test`.
 *
 * Le dépôt en mémoire reproduit **cinq propriétés précises** du vrai, et chacune
 * porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent. C'est ce que l'extension Prisma
 *    fait en vrai. Un double qui ignorerait le tenant ferait passer les tests
 *    d'isolation pour de mauvaises raisons, ce qui est pire que de ne pas les
 *    écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération. Le
 *    mode ouvert par défaut est ce qui produit les fuites ;
 * 3. le **filtre de rôle** — une ligne qui n'est pas `CLIENT` est invisible à
 *    toutes les méthodes, exactement comme le `where` du vrai. C'est ce qui rend
 *    un compte du personnel introuvable depuis les routes du CRM ;
 * 4. l'**unicité de l'adresse par tenant**, avec la même erreur de domaine que
 *    la traduction du code Prisma `P2002` ;
 * 5. la **valeur de retour d'un `updateMany` scopé** — `false` pour un
 *    identifiant inconnu, d'un autre établissement *ou* d'un compte du
 *    personnel, indistinctement. C'est cette valeur-là qui devient le 404.
 */

/** Une ligne `users`, telle que le double la stocke. */
export interface StoredCustomer {
  tenantId: string;
  id: string;
  role: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  internalNote: string | null;
  isActive: boolean;
  createdAt: Date;
}

/** Une ligne `appointments`, réduite à ce que l'historique en lit. */
export interface StoredVisit {
  tenantId: string;
  id: string;
  clientId: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  staffName: string;
  priceAmountMinor: number;
  priceCurrency: string;
}

const HONORED: AppointmentStatus = 'COMPLETED';

export class FakeCrmRepository {
  public readonly customers: StoredCustomer[] = [];
  public readonly visits: StoredVisit[] = [];

  /**
   * Déclare une fiche **sans passer par le service** — le pas 1 du protocole de
   * fuite : « créer une ressource avec le tenant A ».
   *
   * Le `tenantId` est explicite et non déduit du contexte : c'est ce qui permet
   * à une suite de semer chez A pour lire chez B.
   */
  public addCustomer(input: {
    tenantId: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
    internalNote?: string | null;
    isActive?: boolean;
    role?: string;
  }): StoredCustomer {
    const stored: StoredCustomer = {
      tenantId: input.tenantId,
      id: randomUUID(),
      role: input.role ?? 'CLIENT',
      email: input.email ?? `${randomUUID().slice(0, 8)}@example.test`,
      firstName: input.firstName ?? 'Alice',
      lastName: input.lastName ?? 'Durand',
      phone: input.phone ?? null,
      internalNote: input.internalNote ?? null,
      isActive: input.isActive ?? true,
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
    };
    this.customers.push(stored);
    return stored;
  }

  /** Déclare une visite — même rôle que `addCustomer` pour l'historique. */
  public addVisit(input: {
    tenantId: string;
    clientId: string;
    status?: AppointmentStatus;
    startsAt?: Date;
    serviceName?: string;
    staffName?: string;
    priceAmountMinor?: number;
    priceCurrency?: string;
  }): StoredVisit {
    const startsAt = input.startsAt ?? new Date('2026-08-01T09:00:00.000Z');
    const stored: StoredVisit = {
      tenantId: input.tenantId,
      id: randomUUID(),
      clientId: input.clientId,
      status: input.status ?? HONORED,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      serviceName: input.serviceName ?? 'Massage 60 min',
      staffName: input.staffName ?? 'Camille',
      priceAmountMinor: input.priceAmountMinor ?? 3500,
      priceCurrency: input.priceCurrency ?? 'EUR',
    };
    this.visits.push(stored);
    return stored;
  }

  public async search(criteria: CustomerSearchCriteria): Promise<CustomerSearchResult> {
    const tenantId = this.requireTenant();
    const term = criteria.term?.toLowerCase() ?? null;

    const matching = this.customers
      .filter((row) => row.tenantId === tenantId && row.role === 'CLIENT')
      .filter((row) => criteria.includeInactive || row.isActive)
      .filter((row) => term === null || matches(row, term))
      .sort(
        (left, right) =>
          left.lastName.localeCompare(right.lastName) ||
          left.firstName.localeCompare(right.firstName) ||
          left.id.localeCompare(right.id),
      );

    const start = (criteria.page - 1) * criteria.pageSize;

    return {
      items: matching.slice(start, start + criteria.pageSize).map((row) => toSummary(row)),
      totalItems: matching.length,
    };
  }

  public async findById(id: string): Promise<Customer | null> {
    const row = this.find(id);
    return row === undefined ? null : toCustomer(row);
  }

  public async create(input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    internalNote: string | null;
  }): Promise<Customer> {
    const tenantId = this.requireTenant();

    // L'unicité porte sur `(tenant_id, email)` **sans regarder le rôle** : c'est
    // ce que fait la contrainte en base, et une fiche créée sur l'adresse d'une
    // praticienne rendrait la connexion ambiguë.
    if (this.customers.some((row) => row.tenantId === tenantId && row.email === input.email)) {
      throw new CustomerEmailTakenError();
    }

    return toCustomer(this.addCustomer({ tenantId, ...input }));
  }

  public async update(id: string, patch: CustomerPatch): Promise<boolean> {
    const row = this.find(id);
    if (row === undefined) {
      return false;
    }
    Object.assign(row, patch);
    return true;
  }

  public async setActive(id: string, isActive: boolean): Promise<boolean> {
    const row = this.find(id);
    if (row === undefined) {
      return false;
    }
    row.isActive = isActive;
    return true;
  }

  public async recentVisits(customerId: string, take: number): Promise<CustomerVisit[]> {
    return this.visitsOf(customerId)
      .sort((left, right) => right.startsAt.getTime() - left.startsAt.getTime())
      .slice(0, take)
      .map((row) => ({
        appointmentId: row.id,
        status: row.status,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        serviceName: row.serviceName,
        staffName: row.staffName,
        priceAmountMinor: row.priceAmountMinor,
        priceCurrency: row.priceCurrency,
      }));
  }

  public async countVisitsByStatus(customerId: string): Promise<VisitCountByStatus[]> {
    const counts = new Map<string, number>();
    for (const row of this.visitsOf(customerId)) {
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }
    return [...counts].map(([status, count]) => ({ status, count }));
  }

  public async honoredVisitBounds(customerId: string): Promise<VisitBounds> {
    const honored = this.visitsOf(customerId)
      .filter((row) => row.status === HONORED)
      .map((row) => row.startsAt.getTime());

    if (honored.length === 0) {
      return { firstVisitAt: null, lastVisitAt: null };
    }
    return {
      firstVisitAt: new Date(Math.min(...honored)),
      lastVisitAt: new Date(Math.max(...honored)),
    };
  }

  public async sumHonoredByCurrency(customerId: string): Promise<HonoredTotalByCurrency[]> {
    const totals = new Map<string, number>();
    for (const row of this.visitsOf(customerId).filter((visit) => visit.status === HONORED)) {
      totals.set(row.priceCurrency, (totals.get(row.priceCurrency) ?? 0) + row.priceAmountMinor);
    }
    return [...totals].map(([currency, amountMinor]) => ({ currency, amountMinor }));
  }

  /** Une fiche du tenant courant, de rôle `CLIENT` — les deux filtres du vrai `where`. */
  private find(id: string): StoredCustomer | undefined {
    const tenantId = this.requireTenant();
    return this.customers.find(
      (row) => row.tenantId === tenantId && row.id === id && row.role === 'CLIENT',
    );
  }

  /**
   * Les rendez-vous d'une fiche, **dans le tenant courant**.
   *
   * Le filtre sur `tenantId` est celui que l'extension pose en vrai. Sans lui,
   * l'historique d'un identifiant du voisin rendrait ses visites, et le test de
   * fuite passerait au vert sur une projection qui traverse la frontière.
   */
  private visitsOf(customerId: string): StoredVisit[] {
    const tenantId = this.requireTenant();
    return this.visits.filter((row) => row.tenantId === tenantId && row.clientId === customerId);
  }

  /**
   * La portée courante, ou une erreur — **défaut fermé**.
   *
   * L'extension Prisma lève quand aucun tenant n'est résolu, elle ne retombe pas
   * sur « toutes les lignes ». Le double doit se comporter pareil, sans quoi une
   * garde qui n'ouvrirait pas la portée passerait inaperçue.
   */
  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      throw new Error(
        'FakeCrmRepository : aucune portée de tenant ouverte. Le vrai dépôt lèverait ' +
          'de même — l’extension de scoping refuse toute opération hors contexte.',
      );
    }
    return tenantId;
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asRepository(): CrmRepository {
    return this as unknown as CrmRepository;
  }
}

/** `true` si la fiche répond au terme, par **préfixe**, comme le vrai `where`. */
function matches(row: StoredCustomer, term: string): boolean {
  return (
    row.lastName.toLowerCase().startsWith(term) ||
    row.firstName.toLowerCase().startsWith(term) ||
    row.email.startsWith(term) ||
    (row.phone !== null && row.phone.startsWith(term))
  );
}

function toSummary(row: StoredCustomer): CustomerSummary {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    isActive: row.isActive,
  };
}

function toCustomer(row: StoredCustomer): Customer {
  return {
    ...toSummary(row),
    internalNote: row.internalNote,
    createdAt: row.createdAt,
  };
}

