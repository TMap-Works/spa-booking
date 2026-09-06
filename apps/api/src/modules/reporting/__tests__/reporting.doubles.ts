import { getTenantId } from '../../../common/tenant';
import type { ReportingRepository } from '../reporting.repository';
import type {
  AppointmentGrouping,
  AppointmentStatus,
  AppointmentVolumeRow,
  DailyRevenueRow,
  NoShowCounts,
  PaymentMethod,
  ReportWindow,
} from '../reporting.types';
import { APPOINTMENT_STATUSES } from '../reporting.types';

/**
 * Doubles du module `reporting`, partagés par ses suites unitaires et par les
 * suites d'intégration et d'isolation d'`apps/api/test`.
 *
 * Le dépôt en mémoire reproduit **quatre propriétés** du vrai, et chacune porte
 * un test :
 *
 * 1. le **scoping par tenant** — chaque ligne semée porte son `tenantId`, et
 *    toute lecture le filtre. C'est ce que fait à la main le
 *    `WHERE tenant_id = …` de chaque requête brute du vrai dépôt. Un double qui
 *    ignorerait le tenant ferait passer les tests d'isolation pour de mauvaises
 *    raisons, ce qui est pire que de ne pas les écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune lecture. C'est
 *    ce que `requireTenantId()` impose en vrai, et le mode ouvert par défaut est
 *    ce qui produit les fuites ;
 * 3. la **fenêtre semi-ouverte** — `from` inclus, `to` exclu, sur `captured_at`
 *    pour la recette et sur `starts_at` pour les rendez-vous. Une borne haute
 *    incluse compterait deux fois l'encaissement de minuit ;
 * 4. les **statuts qui font recette** — `PENDING` et `FAILED` sont écartés,
 *    `REFUNDED` et `PARTIALLY_REFUNDED` comptent pour leur brut, remboursement
 *    déduit.
 *
 * Ce qu'il ne reproduit **pas**, et n'a pas à reproduire : le découpage des
 * journées dans le fuseau du salon. C'est PostgreSQL qui l'assure, par
 * `AT TIME ZONE` ; un double qui referait ce calcul en JavaScript prouverait la
 * justesse de sa propre réimplémentation, pas celle de la requête. Les lignes
 * semées portent donc leur date civile telle quelle.
 */

/** Un encaissement semé, réduit à ce que le rapport de revenu en lit. */
export interface StoredPayment {
  tenantId: string;
  /** La date civile du jour de caisse, déjà découpée — voir l'en-tête. */
  date: string;
  capturedAt: Date;
  method: PaymentMethod;
  currency: string;
  status: string;
  amountMinor: number;
  refundedAmountMinor: number;
}

/** Un rendez-vous semé, réduit à ce que les deux autres rapports en lisent. */
export interface StoredAppointment {
  tenantId: string;
  /** La date civile du rendez-vous, déjà découpée — voir l'en-tête. */
  date: string;
  startsAt: Date;
  status: AppointmentStatus;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
}

/** Levée quand une lecture est tentée hors de toute portée de tenant. */
export class FakeMissingTenantContextError extends Error {
  public constructor(operation: string) {
    super(`aucune portée de tenant ouverte pour « ${operation} »`);
  }
}

/**
 * Dépôt de reporting en mémoire — même surface publique que le vrai.
 *
 * Il n'implémente pas `ReportingRepository` par `implements` : le vrai porte des
 * membres privés que le double n'a pas à copier. Le lien de type est établi par
 * {@link asReportingRepository}, et par lui seul — d'où la règle qui va avec :
 * une méthode publique ajoutée au vrai dépôt doit être ajoutée ici le même jour,
 * sans quoi la substitution rendra `undefined` là où le service attend une
 * fonction, et seulement à l'exécution.
 */
export class FakeReportingRepository {
  /** Le fuseau que rend `currentTimeZone`, par tenant. */
  private readonly timeZones = new Map<string, string>();

  private readonly payments: StoredPayment[] = [];

  private readonly appointments: StoredAppointment[] = [];

  /** Sème le fuseau d'un établissement — sans quoi tous les rapports rendent 404. */
  public seedTenant(tenantId: string, timeZone = 'Europe/Paris'): void {
    this.timeZones.set(tenantId, timeZone);
  }

  public seedPayment(payment: StoredPayment): void {
    this.payments.push(payment);
  }

  public seedAppointment(appointment: StoredAppointment): void {
    this.appointments.push(appointment);
  }

  public async currentTimeZone(): Promise<string | null> {
    const tenantId = this.requireScope('currentTimeZone');

    return Promise.resolve(this.timeZones.get(tenantId) ?? null);
  }

  public async dailyRevenue(
    window: ReportWindow,
    _timeZone: string,
  ): Promise<readonly DailyRevenueRow[]> {
    const tenantId = this.requireScope('dailyRevenue');

    const buckets = new Map<string, DailyRevenueRow>();

    for (const payment of this.payments) {
      if (payment.tenantId !== tenantId) {
        continue;
      }
      if (!REVENUE_STATUSES.has(payment.status)) {
        continue;
      }
      if (!within(payment.capturedAt, window)) {
        continue;
      }

      const key = `${payment.date} ${payment.method} ${payment.currency}`;
      const current = buckets.get(key);

      buckets.set(key, {
        date: payment.date,
        method: payment.method,
        currency: payment.currency,
        transactions: (current?.transactions ?? 0) + 1,
        grossAmountMinor: (current?.grossAmountMinor ?? 0) + payment.amountMinor,
        refundedAmountMinor: (current?.refundedAmountMinor ?? 0) + payment.refundedAmountMinor,
        netAmountMinor:
          (current?.netAmountMinor ?? 0) + payment.amountMinor - payment.refundedAmountMinor,
      });
    }

    return Promise.resolve([...buckets.entries()].sort(byKey).map(([, row]) => row));
  }

  public async appointmentVolume(
    window: ReportWindow,
    _timeZone: string,
    groupBy: AppointmentGrouping,
  ): Promise<readonly AppointmentVolumeRow[]> {
    const tenantId = this.requireScope('appointmentVolume');

    const groups = new Map<string, { label: string | null; byStatus: Record<string, number> }>();

    for (const appointment of this.appointments) {
      if (appointment.tenantId !== tenantId || !within(appointment.startsAt, window)) {
        continue;
      }

      const [key, label] = bucketOf(appointment, groupBy);
      let group = groups.get(key);
      if (group === undefined) {
        group = { label, byStatus: emptyStatusCounts() };
        groups.set(key, group);
      }

      group.byStatus[appointment.status] = (group.byStatus[appointment.status] ?? 0) + 1;
    }

    return Promise.resolve(
      [...groups.entries()]
        .sort(byKey)
        .map(([key, group]) => ({
          key,
          label: group.label,
          total: Object.values(group.byStatus).reduce((sum, count) => sum + count, 0),
          byStatus: group.byStatus as Record<AppointmentStatus, number>,
        })),
    );
  }

  public async noShowCounts(window: ReportWindow): Promise<NoShowCounts> {
    const tenantId = this.requireScope('noShowCounts');

    const rows = this.appointments.filter(
      (appointment) => appointment.tenantId === tenantId && within(appointment.startsAt, window),
    );
    const count = (status: AppointmentStatus): number =>
      rows.filter((row) => row.status === status).length;

    return Promise.resolve({
      noShows: count('NO_SHOW'),
      honored: count('COMPLETED'),
      cancelled: count('CANCELLED'),
      pending: count('PENDING') + count('CONFIRMED'),
      total: rows.length,
    });
  }

  /**
   * Le tenant courant — ou l'échec.
   *
   * Le pendant exact de `requireTenantId()` du vrai dépôt : hors portée, on
   * échoue plutôt que de lire toutes les données de tous les salons.
   */
  private requireScope(operation: string): string {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new FakeMissingTenantContextError(operation);
    }

    return tenantId;
  }
}

/** Le double, vu comme le vrai dépôt — pour la substitution dans un module Nest. */
export function asReportingRepository(fake: FakeReportingRepository): ReportingRepository {
  return fake as unknown as ReportingRepository;
}

/** Les statuts d'encaissement qui font recette — le miroir du `IN (…)` du vrai. */
const REVENUE_STATUSES = new Set(['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/** `from` inclus, `to` exclu — la convention de fenêtre du module. */
function within(instant: Date, window: ReportWindow): boolean {
  return instant.getTime() >= window.from.getTime() && instant.getTime() < window.to.getTime();
}

/** La clé et le libellé d'un rendez-vous sur l'axe demandé. */
function bucketOf(
  appointment: StoredAppointment,
  groupBy: AppointmentGrouping,
): [string, string | null] {
  if (groupBy === 'staff') {
    return [appointment.staffId, appointment.staffName];
  }
  if (groupBy === 'service') {
    return [appointment.serviceId, appointment.serviceName];
  }

  return [appointment.date, null];
}

function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(APPOINTMENT_STATUSES.map((status) => [status, 0]));
}

function byKey([left]: [string, unknown], [right]: [string, unknown]): number {
  return left.localeCompare(right);
}
