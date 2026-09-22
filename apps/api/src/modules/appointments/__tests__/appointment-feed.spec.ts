import { randomUUID } from 'node:crypto';

import type { MessageEvent } from '@nestjs/common';
import type { AppointmentFeedEvent } from '@spa/shared';

import { runWithTenant } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type {
  BroadcastHandler,
  CacheBroadcast,
} from '../../../infrastructure/cache/cache.broadcast';
import { feedStream } from '../appointment-feed.controller';
import {
  AppointmentFeed,
  feedChannel,
  feedSignalOf,
  reaches,
  type AppointmentFeedAudience,
  type AppointmentFeedSignal,
} from '../appointment-feed.service';
import { AppointmentEvents } from '../events/appointment-events';
import { FakeAppointmentsRepository } from './appointments.doubles';

/**
 * Le flux temps réel des rendez-vous — ce qu'un écran ouvert reçoit, et surtout
 * ce qu'il ne reçoit pas.
 *
 * Le vrai bus, un faux Redis : ce qui est éprouvé ici est le **branchement** —
 * du bus aux connexions, d'une instance à l'autre — et le périmètre de chaque
 * regard. Le transport Redis lui-même est `ioredis`.
 */

const SALON = randomUUID();
const VOISIN = randomUUID();
const CLIENTE = randomUUID();
const AUTRE_CLIENTE = randomUUID();
const CLAIRE = randomUUID();
const JULIE = randomUUID();

const logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as StructuredLogger;

/** Un Redis en mémoire, partagé par les instances d'un même test. */
class FakeRedis {
  public readonly published: Array<{ channel: string; message: string }> = [];

  private readonly subscribers = new Map<string, Set<BroadcastHandler>>();

  public broadcast(): CacheBroadcast {
    return {
      publish: (channel: string, message: string) => {
        this.published.push({ channel, message });
        for (const handler of this.subscribers.get(channel) ?? []) {
          handler(message);
        }
        return Promise.resolve(true);
      },
      subscribe: (channel: string, handler: BroadcastHandler) => {
        const set = this.subscribers.get(channel) ?? new Set();
        set.add(handler);
        this.subscribers.set(channel, set);
        return () => {
          set.delete(handler);
        };
      },
    } as unknown as CacheBroadcast;
  }

  public subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}

function instance(redis: FakeRedis, repository = new FakeAppointmentsRepository()) {
  const events = new AppointmentEvents(logger);
  const feed = new AppointmentFeed(events, redis.broadcast(), repository.asRepository(), logger);
  feed.onModuleInit();
  return { events, feed, repository };
}

function created(tenantId = SALON, clientId = CLIENTE, staffId = CLAIRE) {
  return {
    tenantId,
    appointmentId: randomUUID(),
    clientId,
    staffId,
    serviceId: randomUUID(),
    startsAt: '2026-09-23T12:30:00.000Z',
    endsAt: '2026-09-23T13:30:00.000Z',
  };
}

function watching(feed: AppointmentFeed, audience: AppointmentFeedAudience) {
  const received: AppointmentFeedEvent[] = [];
  const stop = feed.watch(audience, (event) => received.push(event));
  return { received, stop };
}

describe('flux de rendez-vous — ce que chaque regard reçoit', () => {
  it('la gérante voit arriver la réservation, sans aucune donnée de la cliente', () => {
    const { events, feed } = instance(new FakeRedis());
    const gerante = watching(feed, { kind: 'establishment', tenantId: SALON });
    const booking = created();

    events.appointmentCreated(booking);

    expect(gerante.received).toHaveLength(1);
    expect(gerante.received[0]).toEqual({
      change: 'created',
      appointmentId: booking.appointmentId,
      startsAt: booking.startsAt,
      occurredAt: expect.any(String),
    });
    // Ni cliente, ni praticien, ni tenant : un signal, pas une donnée.
    expect(JSON.stringify(gerante.received[0])).not.toContain(CLIENTE);
    expect(JSON.stringify(gerante.received[0])).not.toContain(SALON);
  });

  it('un autre salon ne reçoit rien', () => {
    const { events, feed } = instance(new FakeRedis());
    const voisin = watching(feed, { kind: 'establishment', tenantId: VOISIN });

    events.appointmentCreated(created());

    expect(voisin.received).toEqual([]);
  });

  it('la cliente ne reçoit que ses rendez-vous', () => {
    const { events, feed } = instance(new FakeRedis());
    const elle = watching(feed, { kind: 'client', tenantId: SALON, clientId: CLIENTE });

    events.appointmentCreated(created(SALON, AUTRE_CLIENTE));
    events.appointmentConfirmed({
      tenantId: SALON,
      appointmentId: randomUUID(),
      clientId: CLIENTE,
      staffId: CLAIRE,
    });

    expect(elle.received.map((event) => event.change)).toEqual(['confirmed']);
  });

  it('la praticienne ne reçoit que les siens — et celui qu’on lui retire', () => {
    const { events, feed } = instance(new FakeRedis());
    const julie = watching(feed, { kind: 'staff', tenantId: SALON, staffId: JULIE });

    events.appointmentCreated(created(SALON, CLIENTE, CLAIRE));
    events.appointmentRescheduled({
      tenantId: SALON,
      appointmentId: randomUUID(),
      previousAppointmentId: randomUUID(),
      clientId: CLIENTE,
      serviceId: randomUUID(),
      staffId: CLAIRE,
      previousStaffId: JULIE,
      startsAt: '2026-09-24T09:00:00.000Z',
      endsAt: '2026-09-24T10:00:00.000Z',
      previousStartsAt: '2026-09-23T09:00:00.000Z',
      previousEndsAt: '2026-09-23T10:00:00.000Z',
    });

    expect(julie.received.map((event) => event.change)).toEqual(['rescheduled']);
  });

  it('se débranche', () => {
    const { events, feed } = instance(new FakeRedis());
    const gerante = watching(feed, { kind: 'establishment', tenantId: SALON });

    gerante.stop();
    events.appointmentCreated(created());

    expect(gerante.received).toEqual([]);
  });
});

describe('flux de rendez-vous — d’une instance à l’autre', () => {
  it('la réservation prise sur une instance atteint l’écran ouvert sur l’autre', () => {
    const redis = new FakeRedis();
    const a = instance(redis);
    const b = instance(redis);
    const surA = watching(a.feed, { kind: 'establishment', tenantId: SALON });
    const surB = watching(b.feed, { kind: 'establishment', tenantId: SALON });

    a.events.appointmentCreated(created());

    // Une fois chacune : l'instance d'origine ne se resert pas son propre écho.
    expect(surA.received).toHaveLength(1);
    expect(surB.received).toHaveLength(1);
  });

  it('publie sur le canal de l’établissement, et nulle part ailleurs', () => {
    const redis = new FakeRedis();
    const { events } = instance(redis);

    events.appointmentCreated(created());

    expect(redis.published.map((entry) => entry.channel)).toEqual([feedChannel(SALON)]);
  });

  it('ne s’abonne qu’aux salons dont un écran est ouvert, et s’en retire', () => {
    const redis = new FakeRedis();
    const { feed } = instance(redis);

    const gerante = watching(feed, { kind: 'establishment', tenantId: SALON });

    expect(redis.subscriberCount(feedChannel(SALON))).toBe(1);
    expect(redis.subscriberCount(feedChannel(VOISIN))).toBe(0);

    gerante.stop();

    expect(redis.subscriberCount(feedChannel(SALON))).toBe(0);
  });

  it('écarte un message qui ne respecte pas le contrat', () => {
    const redis = new FakeRedis();
    const { feed } = instance(redis);
    const gerante = watching(feed, { kind: 'establishment', tenantId: SALON });

    void redis.broadcast().publish(feedChannel(SALON), 'pas du JSON');
    void redis.broadcast().publish(
      feedChannel(SALON),
      JSON.stringify({
        origin: 'autre-instance',
        signal: {
          tenantId: SALON,
          clientId: CLIENTE,
          staffIds: [CLAIRE],
          event: { change: 'deleted', appointmentId: 'x', occurredAt: 'hier' },
        },
      }),
    );

    expect(gerante.received).toEqual([]);
  });

  it('écarte un message d’un autre salon glissé sur le canal', () => {
    const redis = new FakeRedis();
    const { feed } = instance(redis);
    const gerante = watching(feed, { kind: 'establishment', tenantId: SALON });
    const foreign: AppointmentFeedSignal = feedSignalOf({
      ...created(VOISIN),
      name: 'appointment.created',
      occurredAt: '2026-09-21T10:00:00.000Z',
    });

    void redis
      .broadcast()
      .publish(feedChannel(SALON), JSON.stringify({ origin: 'autre-instance', signal: foreign }));

    expect(gerante.received).toEqual([]);
  });
});

describe('flux de rendez-vous — le périmètre vient du jeton', () => {
  it.each([['ADMIN'], ['MANAGER']] as const)('%s suit tout l’établissement', async (role) => {
    const { feed } = instance(new FakeRedis());

    await expect(
      runWithTenant(SALON, () => feed.audienceOf({ userId: randomUUID(), tenantId: SALON, role })),
    ).resolves.toEqual({ kind: 'establishment', tenantId: SALON });
  });

  it('un praticien suit sa fiche', async () => {
    const repository = new FakeAppointmentsRepository();
    const userId = randomUUID();
    repository.seedStaffProfile({
      tenantId: SALON,
      staffId: CLAIRE,
      userId,
      displayName: 'Claire',
    });
    const { feed } = instance(new FakeRedis(), repository);

    await expect(
      runWithTenant(SALON, () => feed.audienceOf({ userId, tenantId: SALON, role: 'STAFF' })),
    ).resolves.toEqual({ kind: 'staff', tenantId: SALON, staffId: CLAIRE });
  });

  it('un praticien sans fiche ne suit rien d’autre que son propre compte', async () => {
    const { feed } = instance(new FakeRedis());
    const userId = randomUUID();

    await expect(
      runWithTenant(SALON, () => feed.audienceOf({ userId, tenantId: SALON, role: 'STAFF' })),
    ).resolves.toEqual({ kind: 'client', tenantId: SALON, clientId: userId });
  });

  it('une cliente suit ses rendez-vous', async () => {
    const { feed } = instance(new FakeRedis());

    await expect(
      runWithTenant(SALON, () =>
        feed.audienceOf({ userId: CLIENTE, tenantId: SALON, role: 'CLIENT' }),
      ),
    ).resolves.toEqual({ kind: 'client', tenantId: SALON, clientId: CLIENTE });
  });
});

describe('flux de rendez-vous — la traduction des événements', () => {
  it('dit qui a annulé, dans le vocabulaire du contrat', () => {
    const signal = feedSignalOf({
      name: 'appointment.cancelled',
      tenantId: SALON,
      appointmentId: randomUUID(),
      clientId: CLIENTE,
      serviceId: randomUUID(),
      staffId: CLAIRE,
      startsAt: '2026-09-23T12:30:00.000Z',
      endsAt: '2026-09-23T13:30:00.000Z',
      previousStatus: 'CONFIRMED',
      cancelledBy: 'CLIENT',
      cancelledAt: '2026-09-21T10:00:00.000Z',
      occurredAt: '2026-09-21T10:00:00.000Z',
    });

    expect(signal.event).toMatchObject({ change: 'cancelled', cancelledBy: 'client' });
  });

  it.each([
    ['COMPLETED', 'completed'],
    ['NO_SHOW', 'no_show'],
  ] as const)('%s devient `%s`', (status, change) => {
    const signal = feedSignalOf({
      name: 'appointment.status_changed',
      tenantId: SALON,
      appointmentId: randomUUID(),
      clientId: CLIENTE,
      staffId: CLAIRE,
      status,
      occurredAt: '2026-09-21T10:00:00.000Z',
    });

    expect(signal.event.change).toBe(change);
  });

  it('le tenant est jugé avant tout le reste', () => {
    const signal = feedSignalOf({
      ...created(VOISIN),
      name: 'appointment.created',
      occurredAt: '2026-09-21T10:00:00.000Z',
    });

    expect(reaches({ kind: 'client', tenantId: SALON, clientId: CLIENTE }, signal)).toBe(false);
    expect(reaches({ kind: 'staff', tenantId: SALON, staffId: CLAIRE }, signal)).toBe(false);
    expect(reaches({ kind: 'establishment', tenantId: SALON }, signal)).toBe(false);
  });
});

describe('flux de rendez-vous — la connexion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function connection(lifetimeMs = 60_000) {
    let listener: ((event: AppointmentFeedEvent) => void) | null = null;
    const stop = jest.fn();
    const feed = {
      watch: (_audience: AppointmentFeedAudience, next: (event: AppointmentFeedEvent) => void) => {
        listener = next;
        return stop;
      },
    };
    const messages: MessageEvent[] = [];
    let completed = false;

    const subscription = feedStream(
      feed,
      { kind: 'establishment', tenantId: SALON },
      { heartbeatMs: 1_000, lifetimeMs },
    ).subscribe({
      next: (message) => messages.push(message),
      complete: () => {
        completed = true;
      },
    });

    return {
      messages,
      stop,
      subscription,
      emit: (event: AppointmentFeedEvent) => listener?.(event),
      isCompleted: () => completed,
    };
  }

  it('s’ouvre sur un premier message qui fixe le délai de reconnexion', () => {
    const { messages } = connection();

    expect(messages[0]).toMatchObject({ type: 'ping', retry: expect.any(Number) });
  });

  it('relaie chaque changement sous l’événement `appointment`', () => {
    const { messages, emit } = connection();
    const event: AppointmentFeedEvent = {
      change: 'confirmed',
      appointmentId: randomUUID(),
      occurredAt: '2026-09-21T10:00:00.000Z',
    };

    emit(event);

    expect(messages.at(-1)).toEqual({ type: 'appointment', data: event });
  });

  it('bat pour qu’aucun intermédiaire ne la croie morte', () => {
    const { messages } = connection();

    jest.advanceTimersByTime(3_000);

    expect(messages.filter((message) => message.type === 'ping')).toHaveLength(4);
  });

  it('se referme d’elle-même, et se débranche du flux', () => {
    const { isCompleted, stop } = connection(5_000);

    jest.advanceTimersByTime(5_000);

    expect(isCompleted()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('se débranche quand le navigateur s’en va', () => {
    const { subscription, stop } = connection();

    subscription.unsubscribe();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
