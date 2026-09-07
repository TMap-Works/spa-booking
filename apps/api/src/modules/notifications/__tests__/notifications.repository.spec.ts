import { Prisma } from '@prisma/client';

import type { ScopedPrismaClient } from '../../../infrastructure/database/prisma-clients';
import { NotificationsRepository } from '../notifications.repository';
import {
  appointmentDedupeKey,
  LIVE_NOTIFICATION_STATUSES,
  type NotificationMessage,
} from '../notifications.types';

/**
 * La **prise de droit** elle-même — `claim()`, et les deux relectures par
 * lesquelles elle traduit un refus de la base.
 *
 * `notification-dispatch.service.spec.ts` ne peut pas couvrir ce chemin : il
 * remplace le dépôt par un double, dont le `claim()` regarde la ligne vivante
 * *avant* de tenter l'insertion. Le code qui porte réellement l'idempotence —
 * l'insertion sous `try`, la reconnaissance du `P2002`, `resolveRefusal()` et
 * `reclaim()` — n'y est donc jamais exécuté.
 *
 * Le client Prisma est ici doublé par un moteur minuscule qui **refuse les
 * doublons comme PostgreSQL les refuse** : l'unique total sur la clé de
 * livraison, et l'unique partiel `notifications_live_once`. Un double qui
 * accepterait tout ferait passer ces suites quelle que soit la conduite du
 * dépôt.
 *
 * Ce qui reste hors de portée d'une suite unitaire : que l'index existe
 * vraiment en base. C'est `notifications.migration.spec.ts` qui relit le SQL, et
 * la CI qui l'applique.
 */

const APPOINTMENT_ID = 'appointment-1';
const RECIPIENT_ID = 'user-1';
const LIVE: ReadonlySet<string> = new Set(LIVE_NOTIFICATION_STATUSES);

interface Row {
  id: string;
  appointmentId: string | null;
  recipientUserId: string | null;
  type: string;
  channel: string;
  status: string;
  dedupeKey: string;
  providerMessageId: string | null;
  attemptCount: number;
  failureReason: string | null;
  sentAt: Date | null;
}

/** L'erreur telle que Prisma la lève sur une violation d'unicité. */
function uniqueViolation(index: string): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
    code: 'P2002',
    clientVersion: '6.12.0',
    meta: { target: index },
  });
}

type WhereValue = string | null | { in?: readonly string[] };

function matches(row: Row, where: Record<string, WhereValue>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[field];
    if (expected !== null && typeof expected === 'object') {
      return (expected.in ?? []).includes(actual as string);
    }
    return actual === expected;
  });
}

interface FakeEngineOptions {
  /**
   * Fait échouer toute insertion, quel que soit l'état de la table.
   *
   * Sert à rejouer un entrelacement qu'une table en mémoire ne peut pas
   * produire seule : le refus est prononcé sur l'état de la base *au moment de
   * l'insertion*, et l'état a pu changer avant les relectures qui le traduisent.
   */
  readonly createAlwaysConflicts?: boolean;
}

function fakeEngine(seed: readonly Partial<Row>[] = [], options: FakeEngineOptions = {}) {
  let sequence = 0;

  const rows: Row[] = seed.map((partial) => {
    sequence += 1;
    return {
      id: `seeded-${sequence}`,
      appointmentId: APPOINTMENT_ID,
      recipientUserId: RECIPIENT_ID,
      type: 'REMINDER_24H',
      channel: 'SMS',
      status: 'PENDING',
      dedupeKey: 'seed-key',
      providerMessageId: null,
      attemptCount: 1,
      failureReason: null,
      sentAt: null,
      ...partial,
    };
  });

  /** Les deux uniques de la table, dans l'ordre où PostgreSQL les évaluerait. */
  const refuse = (candidate: Row, ignoredId?: string): void => {
    const others = rows.filter((row) => row.id !== ignoredId);

    if (others.some((row) => row.dedupeKey === candidate.dedupeKey)) {
      throw uniqueViolation('notifications_tenant_id_dedupe_key_key');
    }
    if (
      LIVE.has(candidate.status) &&
      others.some(
        (row) =>
          LIVE.has(row.status) &&
          row.appointmentId === candidate.appointmentId &&
          row.type === candidate.type &&
          row.channel === candidate.channel,
      )
    ) {
      throw uniqueViolation('notifications_live_once');
    }
  };

  /** Le `select` est honoré : ce qui n'est pas demandé ne sort pas. */
  const project = (row: Row, select?: Record<string, true>): Partial<Row> => {
    if (select === undefined) {
      return { ...row };
    }
    return Object.fromEntries(
      Object.keys(select).map((field) => [field, (row as unknown as Record<string, unknown>)[field]]),
    ) as Partial<Row>;
  };

  const notification = {
    create(args: { data: Record<string, unknown>; select?: Record<string, true> }): Promise<
      Partial<Row>
    > {
      if (options.createAlwaysConflicts === true) {
        return Promise.reject(uniqueViolation('notifications_live_once'));
      }

      sequence += 1;
      const row = {
        id: `notification-${sequence}`,
        providerMessageId: null,
        failureReason: null,
        sentAt: null,
        ...args.data,
      } as unknown as Row;

      try {
        refuse(row);
      } catch (error) {
        return Promise.reject(error);
      }

      rows.push(row);
      return Promise.resolve(project(row, args.select));
    },

    findFirst(args: {
      where: Record<string, WhereValue>;
      select?: Record<string, true>;
    }): Promise<Partial<Row> | null> {
      const found = rows.find((row) => matches(row, args.where));
      return Promise.resolve(found === undefined ? null : project(found, args.select));
    },

    updateMany(args: {
      where: Record<string, WhereValue>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> {
      const targets = rows.filter((row) => matches(row, args.where));
      if (targets.length === 0) {
        return Promise.resolve({ count: 0 });
      }

      for (const target of targets) {
        const next: Row = { ...target };
        for (const [field, value] of Object.entries(args.data)) {
          if (field === 'attemptCount' && typeof value === 'object' && value !== null) {
            next.attemptCount += (value as { increment: number }).increment;
            continue;
          }
          (next as unknown as Record<string, unknown>)[field] = value;
        }

        try {
          refuse(next, target.id);
        } catch (error) {
          return Promise.reject(error);
        }

        Object.assign(target, next);
      }

      return Promise.resolve({ count: targets.length });
    },
  };

  return {
    rows,
    repository: new NotificationsRepository({ notification } as unknown as ScopedPrismaClient),
  };
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  const type = overrides.type ?? 'REMINDER_24H';
  const channel = overrides.channel ?? 'SMS';
  const appointmentId = overrides.appointmentId ?? APPOINTMENT_ID;

  return {
    dedupeKey: appointmentDedupeKey(appointmentId, type, channel),
    appointmentId,
    recipientUserId: RECIPIENT_ID,
    type,
    channel,
    scheduledFor: null,
    ...overrides,
  };
}

describe('NotificationsRepository.claim — l’insertion est le verrou', () => {
  it('inscrit la ligne en `PENDING`, à sa première tentative', async () => {
    const { repository, rows } = fakeEngine();

    const claim = await repository.claim(message());

    expect(claim.outcome).toBe('claimed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', attemptCount: 1 });
  });

  it('relève une erreur qui n’est pas une violation d’unicité', async () => {
    // Le filtre du `catch` doit être strict : avaler une panne de base ferait
    // passer un incident pour un rejeu, et le message serait acquitté.
    const panne = new Error('connexion perdue');
    const repository = new NotificationsRepository({
      notification: { create: () => Promise.reject(panne) },
    } as unknown as ScopedPrismaClient);

    await expect(repository.claim(message())).rejects.toThrow(panne);
  });
});

describe('NotificationsRepository.claim — la traduction d’un refus', () => {
  it('rend `already-live` quand une ligne vivante occupe la place', async () => {
    const { repository } = fakeEngine([{ status: 'SENT', dedupeKey: 'autre-cle' }]);

    await expect(repository.claim(message())).resolves.toEqual({
      outcome: 'already-live',
      notificationId: 'seeded-1',
    });
  });

  it('ranime la ligne échouée qui porte la clé de livraison', async () => {
    const sqsMessage = message();
    const { repository, rows } = fakeEngine([
      { status: 'FAILED', dedupeKey: sqsMessage.dedupeKey, attemptCount: 2, failureReason: 'SES' },
    ]);

    const claim = await repository.claim(sqsMessage);

    expect(claim).toEqual({
      outcome: 'claimed',
      notification: expect.objectContaining({ id: 'seeded-1', status: 'PENDING', attemptCount: 3 }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', attemptCount: 3, failureReason: null });
  });

  it('ranime la ligne échouée que `notifications_live_once` désignait, même sous une autre clé', async () => {
    // Le refus vient de l'index d'idempotence, dont la clé n'est pas la clé de
    // livraison : deux producteurs qui ne se coordonnent pas composent deux
    // `dedupe_key` différentes pour un même rappel. La ligne qui bloquait est
    // tombée en `FAILED` entre le refus et la relecture.
    //
    // Chercher la reprise par la seule clé de livraison ne trouverait rien : le
    // message serait tenu pour un doublon et acquitté auprès de SQS sans que
    // rien ne soit parti.
    const { repository, rows } = fakeEngine(
      [{ status: 'FAILED', dedupeKey: 'sweep:2026-09-06T10:00Z:sms' }],
      { createAlwaysConflicts: true },
    );

    const claim = await repository.claim(message());

    expect(claim.outcome).toBe('claimed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', attemptCount: 2 });
  });

  it('rend `already-live` sans identifiant quand la ligne a été ranimée entre-temps', async () => {
    // Ni vivante au premier regard, ni échouée au second : une reprise
    // concurrente est passée. Il n'y a rien à envoyer.
    const { repository } = fakeEngine([], { createAlwaysConflicts: true });

    await expect(repository.claim(message())).resolves.toEqual({
      outcome: 'already-live',
      notificationId: null,
    });
  });

  it('n’envoie pas deux fois quand deux reprises se disputent la même ligne', async () => {
    // Le test-et-pose : la seconde `UPDATE ... WHERE status = 'FAILED'` ne
    // compte aucune ligne, et son appelant n'envoie rien.
    const sqsMessage = message();
    const { repository } = fakeEngine([
      { status: 'FAILED', dedupeKey: sqsMessage.dedupeKey },
    ]);

    const [first, second] = await Promise.all([
      repository.claim(sqsMessage),
      repository.claim(sqsMessage),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(['already-live', 'claimed']);
  });

  it('préfère la ligne vivante à la ligne échouée qui porte notre clé', async () => {
    // Une tentative précédente a échoué sous notre clé de livraison, mais un
    // autre producteur a depuis pris la place. Il n'y a rien à envoyer, et
    // surtout rien à ranimer : ce serait un second message.
    const sqsMessage = message();
    const { repository, rows } = fakeEngine([
      { status: 'FAILED', dedupeKey: sqsMessage.dedupeKey },
      { status: 'PENDING', dedupeKey: 'sweep:2026-09-06T10:00Z:sms' },
    ]);

    await expect(repository.claim(sqsMessage)).resolves.toEqual({
      outcome: 'already-live',
      notificationId: 'seeded-2',
    });
    expect(rows[0]).toMatchObject({ status: 'FAILED' });
  });

  it('s’arrête si un envoi neuf prend la place pendant la reprise', async () => {
    // La course que seule la base peut arrêter : la ligne vivante apparaît
    // entre la relecture et l'écriture, et c'est `notifications_live_once` qui
    // refuse la transition `FAILED → PENDING`. Aucune table en mémoire ne
    // produit cet entrelacement — il est donc scripté.
    const sqsMessage = message();
    const failed = {
      id: 'seeded-1',
      appointmentId: APPOINTMENT_ID,
      recipientUserId: RECIPIENT_ID,
      type: 'REMINDER_24H',
      channel: 'SMS',
      status: 'FAILED',
      dedupeKey: sqsMessage.dedupeKey,
      providerMessageId: null,
      attemptCount: 1,
    };
    let read = 0;

    const repository = new NotificationsRepository({
      notification: {
        create: () => Promise.reject(uniqueViolation('notifications_tenant_id_dedupe_key_key')),
        // Premier regard : aucune ligne vivante. Second : la ligne échouée.
        findFirst: () => {
          read += 1;
          return Promise.resolve(read === 1 ? null : failed);
        },
        updateMany: () => Promise.reject(uniqueViolation('notifications_live_once')),
      },
    } as unknown as ScopedPrismaClient);

    await expect(repository.claim(sqsMessage)).resolves.toEqual({
      outcome: 'already-live',
      notificationId: null,
    });
  });
});

describe('NotificationsRepository — la clôture d’un envoi', () => {
  it('passe `PENDING → SENT` avec l’accusé, et une seule fois', async () => {
    const { repository, rows } = fakeEngine([{ status: 'PENDING' }]);

    await expect(repository.markSent('seeded-1', 'ses-abc')).resolves.toBe(true);
    expect(rows[0]).toMatchObject({ status: 'SENT', providerMessageId: 'ses-abc' });

    // Le test-et-pose : la ligne n'est plus `PENDING`, elle n'est pas réécrite.
    await expect(repository.markSent('seeded-1', 'ses-def')).resolves.toBe(false);
    expect(rows[0]?.providerMessageId).toBe('ses-abc');
  });

  it('passe `PENDING → FAILED` et tronque le motif à la largeur de la colonne', async () => {
    const { repository, rows } = fakeEngine([{ status: 'PENDING' }]);

    await expect(repository.markFailed('seeded-1', 'x'.repeat(900))).resolves.toBe(true);
    expect(rows[0]).toMatchObject({ status: 'FAILED', providerMessageId: null });
    expect(rows[0]?.failureReason).toHaveLength(500);
  });
});

describe('NotificationsRepository.loadAppointmentContext — l’heure annoncée', () => {
  /**
   * Un dépôt branché sur une ligne d'agenda et son établissement.
   *
   * Le double rend la ligne **telle qu'elle est en base** : l'intervalle
   * occupé, tampons compris. C'est tout l'intérêt de la suite — c'est au dépôt
   * d'en dériver le soin.
   */
  function contextRepository(service: {
    durationMinutes: number;
    bufferBeforeMinutes: number;
  }): NotificationsRepository {
    return new NotificationsRepository({
      appointment: {
        findFirst: () =>
          Promise.resolve({
            // 14:15 à Paris — l'occupé, quinze minutes avant le soin.
            startsAt: new Date('2026-09-08T12:15:00Z'),
            priceAmountMinor: 6_500,
            priceCurrency: 'EUR',
            client: { firstName: 'Amina', lastName: 'Rakoto' },
            service: { name: 'Massage suédois', ...service },
            staff: { displayName: 'Claire D.' },
          }),
      },
      tenant: {
        findFirst: () =>
          Promise.resolve({
            name: 'Maison Lotus',
            slug: 'maison-lotus',
            timezone: 'Europe/Paris',
            addressLine1: null,
            addressLine2: null,
            postalCode: null,
            city: null,
            contactPhone: null,
          }),
      },
    } as unknown as ScopedPrismaClient);
  }

  it('rend l’intervalle facturé, jamais l’occupé', async () => {
    // La ligne occupe 14:15 → 15:40 (15 min de préparation, 60 de soin, 10 de
    // ménage). La cliente a réservé 14:30 → 15:30, et c'est cela qu'une
    // confirmation doit annoncer : lui écrire l'heure occupée avancerait son
    // rendez-vous du temps de préparation de la cabine.
    const repository = contextRepository({ durationMinutes: 60, bufferBeforeMinutes: 15 });

    const context = await repository.loadAppointmentContext('appointment-1');

    expect(context?.startsAt.toISOString()).toBe('2026-09-08T12:30:00.000Z');
    expect(context?.endsAt.toISOString()).toBe('2026-09-08T13:30:00.000Z');
  });

  it('rend la ligne telle quelle quand la prestation n’a aucun tampon', async () => {
    const repository = contextRepository({ durationMinutes: 45, bufferBeforeMinutes: 0 });

    const context = await repository.loadAppointmentContext('appointment-1');

    expect(context?.startsAt.toISOString()).toBe('2026-09-08T12:15:00.000Z');
    expect(context?.endsAt.toISOString()).toBe('2026-09-08T13:00:00.000Z');
  });

  it('ne fait sortir de la base ni adresse ni numéro de la cliente', async () => {
    // Le contexte compose un message, il ne l'adresse pas : la coordonnée se
    // relit sur le compte au moment de l'envoi (notifications §7).
    const repository = contextRepository({ durationMinutes: 60, bufferBeforeMinutes: 0 });

    const context = await repository.loadAppointmentContext('appointment-1');

    expect(JSON.stringify(context)).not.toContain('@');
  });
});
