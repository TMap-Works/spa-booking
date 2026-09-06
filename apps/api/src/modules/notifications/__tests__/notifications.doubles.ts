import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type {
  NotificationReceipt,
  NotificationSender,
  NotificationSendRequest,
} from '../notification-sender';
import type { NotificationsRepository } from '../notifications.repository';
import {
  LIVE_NOTIFICATION_STATUSES,
  type NotificationClaim,
  type NotificationMessage,
  type NotificationRecord,
  type NotificationStatus,
} from '../notifications.types';

/**
 * Doubles du module `notifications`.
 *
 * ## Ce qui est doublé, et ce qui ne l'est pas
 *
 * Le **dépôt** et l'**expéditeur**, parce que l'un parle à Prisma et l'autre à
 * AWS. Le service, lui, est exercé pour de vrai : c'est son ordre d'écriture qui
 * est l'objet du ticket, et le doubler reviendrait à tester le double.
 *
 * ## Pourquoi le dépôt doublé rejoue les deux uniques
 *
 * Un double qui se contenterait de rendre « déjà traité » quand on le lui
 * demande ne prouverait rien : il ferait passer le test quelle que soit la
 * conduite du service. Celui-ci tient une table en mémoire et y **refuse** les
 * doublons selon les deux mêmes règles que PostgreSQL :
 *
 * - `(tenant_id, dedupe_key)` — total, tous statuts confondus ;
 * - `notifications_live_once` — partiel, `PENDING` et `SENT` seulement.
 *
 * Le tenant n'y figure pas : l'extension de scoping le pose en amont, et une
 * suite unitaire tourne dans un seul établissement. Ce que le double reproduit,
 * ce sont les **règles d'unicité**, pas le scoping — qui a ses propres suites.
 *
 * Ce que ce double ne prouve pas, et qui n'est prouvable que contre un vrai
 * moteur : que l'index existe réellement en base. C'est
 * `notifications.migration.spec.ts` qui relit le SQL, et la CI qui l'applique.
 */

/** Journal muet qui retient ce qu'on lui a dit. */
export interface RecordingLogger {
  readonly logger: StructuredLogger;
  readonly entries: { level: string; message: string; meta: unknown }[];
}

export function recordingLogger(): RecordingLogger {
  const entries: { level: string; message: string; meta: unknown }[] = [];

  const record =
    (level: string) =>
    (message: unknown, meta?: unknown): void => {
      entries.push({ level, message: String(message), meta });
    };

  const logger = {
    log: record('log'),
    debug: record('debug'),
    verbose: record('verbose'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as StructuredLogger;

  return { logger, entries };
}

/** Une ligne de `notifications`, telle que le double la tient. */
interface FakeRow {
  id: string;
  appointmentId: string | null;
  recipientUserId: string | null;
  type: NotificationRecord['type'];
  channel: NotificationRecord['channel'];
  status: NotificationStatus;
  dedupeKey: string;
  providerMessageId: string | null;
  attemptCount: number;
  failureReason: string | null;
  sentAt: Date | null;
}

const LIVE: ReadonlySet<string> = new Set(LIVE_NOTIFICATION_STATUSES);

export interface FakeNotificationsRepository {
  readonly repository: NotificationsRepository;
  /** L'état de la table, pour asserter dessus. */
  readonly rows: FakeRow[];
}

function toRecord(row: FakeRow): NotificationRecord {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    recipientUserId: row.recipientUserId,
    type: row.type,
    channel: row.channel,
    status: row.status,
    dedupeKey: row.dedupeKey,
    providerMessageId: row.providerMessageId,
    attemptCount: row.attemptCount,
  };
}

export function fakeNotificationsRepository(): FakeNotificationsRepository {
  const rows: FakeRow[] = [];
  let sequence = 0;

  /** La ligne vivante qui occupe la place, au sens de `notifications_live_once`. */
  const liveFor = (message: NotificationMessage): FakeRow | undefined =>
    rows.find(
      (row) =>
        row.appointmentId === message.appointmentId &&
        row.type === message.type &&
        row.channel === message.channel &&
        LIVE.has(row.status),
    );

  const claim = (message: NotificationMessage): Promise<NotificationClaim> => {
    const live = liveFor(message);
    if (live !== undefined) {
      return Promise.resolve({ outcome: 'already-live', notificationId: live.id });
    }

    // L'unique **total** sur la clé de livraison. La place est libre — aucune
    // ligne vivante — mais la clé peut être prise par une tentative échouée :
    // c'est alors une reprise, `FAILED → PENDING`, et non une insertion.
    const previous = rows.find((row) => row.dedupeKey === message.dedupeKey);
    if (previous !== undefined) {
      if (previous.status !== 'FAILED') {
        return Promise.resolve({ outcome: 'already-live', notificationId: previous.id });
      }
      previous.status = 'PENDING';
      previous.attemptCount += 1;
      previous.failureReason = null;
      return Promise.resolve({ outcome: 'claimed', notification: toRecord(previous) });
    }

    sequence += 1;
    const row: FakeRow = {
      id: `notification-${sequence}`,
      appointmentId: message.appointmentId,
      recipientUserId: message.recipientUserId,
      type: message.type,
      channel: message.channel,
      status: 'PENDING',
      dedupeKey: message.dedupeKey,
      providerMessageId: null,
      attemptCount: 1,
      failureReason: null,
      sentAt: null,
    };
    rows.push(row);

    return Promise.resolve({ outcome: 'claimed', notification: toRecord(row) });
  };

  const markSent = (notificationId: string, providerMessageId: string): Promise<boolean> => {
    const row = rows.find((candidate) => candidate.id === notificationId);
    if (row === undefined || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    row.status = 'SENT';
    row.providerMessageId = providerMessageId;
    row.sentAt = new Date();
    return Promise.resolve(true);
  };

  const markFailed = (notificationId: string, reason: string): Promise<boolean> => {
    const row = rows.find((candidate) => candidate.id === notificationId);
    if (row === undefined || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    row.status = 'FAILED';
    row.failureReason = reason.slice(0, 500);
    return Promise.resolve(true);
  };

  const repository = { claim, markSent, markFailed } as unknown as NotificationsRepository;

  return { repository, rows };
}

/** Expéditeur qui compte ses appels — la mesure du rejeu. */
export interface CountingSender {
  readonly sender: NotificationSender;
  readonly calls: NotificationSendRequest[];
}

/**
 * Ce que rend un appel : une chaîne devient l'accusé du fournisseur, une `Error`
 * est levée telle quelle, et `{ reject }` lève **n'importe quelle valeur** — un
 * pilote AWS ne lève pas toujours une `Error`, et c'est précisément le cas que
 * `describe()` a à traiter sans recopier de charge utile en base.
 */
export type SendBehaviour = string | Error | { readonly reject: unknown };

/** @param behaviour ce que rend chaque appel, dans l'ordre. */
export function countingSender(behaviour: readonly SendBehaviour[] = []): CountingSender {
  const calls: NotificationSendRequest[] = [];

  const sender: NotificationSender = {
    send(request: NotificationSendRequest): Promise<NotificationReceipt> {
      const outcome = behaviour[calls.length] ?? `ses-message-${calls.length + 1}`;
      calls.push(request);

      if (typeof outcome === 'string') {
        return Promise.resolve({ providerMessageId: outcome });
      }
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      return Promise.reject(outcome.reject);
    },
  };

  return { sender, calls };
}
