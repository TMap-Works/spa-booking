import type { AppointmentFeedEvent } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { announcementFor } from '@/app/(account)/[tenantSlug]/compte/components/account-live-announcements';
import { ApiClientError } from '@/lib/api-client';
import { APPOINTMENT_FEED_HEADERS, relayAppointmentFeed } from '@/lib/appointment-feed-relay';

/**
 * Le temps réel des rendez-vous, côté front — les deux morceaux qui se testent
 * sans navigateur : ce que la cliente se voit annoncer, et ce que la route de
 * relais répond selon l'état de la session.
 */

const openAppointmentFeed = vi.fn<(token: string, signal: AbortSignal) => Promise<Response>>();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  openAppointmentFeed: (token: string, signal: AbortSignal) => openAppointmentFeed(token, signal),
}));

afterEach(() => {
  openAppointmentFeed.mockReset();
});

const PARIS = 'Europe/Paris';
const CONTEXT = { timeZone: PARIS, currentPath: '/spa/compte/historique', listPath: '/spa/compte' };

function change(overrides: Partial<AppointmentFeedEvent>): AppointmentFeedEvent {
  return {
    change: 'created',
    appointmentId: '5b0f1b7e-9a3c-4c1e-8f59-0d6f1f2f3a4b',
    occurredAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('temps réel — ce que la cliente se voit annoncer', () => {
  it('annonce la confirmation du salon là où elle se trouve', () => {
    expect(announcementFor(change({ change: 'confirmed' }), CONTEXT)).toEqual({
      kind: 'salon-confirmed',
      when: '',
      path: CONTEXT.currentPath,
    });
  });

  it('annonce l’annulation du salon, à l’heure du salon', () => {
    const request = announcementFor(
      change({ change: 'cancelled', cancelledBy: 'staff', startsAt: '2026-09-29T12:10:00.000Z' }),
      CONTEXT,
    );

    // 12:10 UTC vaut 14:10 à Paris fin septembre.
    expect(request).toMatchObject({ kind: 'salon-cancelled', path: CONTEXT.currentPath });
    expect(request?.when).toContain('14:10');
  });

  it('se tait sur sa propre annulation — son écran l’a déjà dite', () => {
    expect(
      announcementFor(
        change({ change: 'cancelled', cancelledBy: 'client', startsAt: '2026-09-29T12:10:00.000Z' }),
        CONTEXT,
      ),
    ).toBeNull();
  });

  it('annonce le report sur la liste, comme le formulaire de report', () => {
    const request = announcementFor(
      change({ change: 'rescheduled', startsAt: '2026-09-29T12:10:00.000Z' }),
      CONTEXT,
    );

    expect(request).toMatchObject({ kind: 'appointment-rescheduled', path: CONTEXT.listPath });
  });

  it.each([['created'], ['completed'], ['no_show']] as const)('ne dit rien de « %s »', (kind) => {
    expect(
      announcementFor(change({ change: kind, startsAt: '2026-09-29T12:10:00.000Z' }), CONTEXT),
    ).toBeNull();
  });
});

describe('temps réel — la route de relais', () => {
  const signal = new AbortController().signal;

  it('répond 401 sans session, sans appeler l’API', async () => {
    const response = await relayAppointmentFeed(null, signal);

    expect(response.status).toBe(401);
    expect(openAppointmentFeed).not.toHaveBeenCalled();
  });

  it('relaie le flux de l’API, sans le tamponner', async () => {
    openAppointmentFeed.mockResolvedValue(new Response('event: ping\ndata: \n\n'));

    const response = await relayAppointmentFeed('jeton', signal);

    expect(openAppointmentFeed).toHaveBeenCalledWith('jeton', signal);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(APPOINTMENT_FEED_HEADERS['content-type']);
    expect(response.headers.get('cache-control')).toContain('no-transform');
    await expect(response.text()).resolves.toContain('event: ping');
  });

  it('répond 401 quand l’API refuse le jeton', async () => {
    openAppointmentFeed.mockRejectedValue(new ApiClientError('UNAUTHORIZED', 'refusé', 401));

    await expect(relayAppointmentFeed('jeton', signal)).resolves.toHaveProperty('status', 401);
  });

  it('répond 503 quand l’API est injoignable', async () => {
    openAppointmentFeed.mockRejectedValue(
      new ApiClientError('SERVICE_UNAVAILABLE', 'injoignable', 503),
    );

    await expect(relayAppointmentFeed('jeton', signal)).resolves.toHaveProperty('status', 503);
  });
});
