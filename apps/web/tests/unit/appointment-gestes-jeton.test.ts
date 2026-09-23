import type { BookedAppointment } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bookGuestAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from '@/lib/api-client';

/**
 * Les trois gestes de la cliente sur le tunnel public — ce qui part sur le fil
 * (#1201, élargi à la réservation par #1207).
 *
 * Le défaut que ces tickets corrigent n'était pas une règle manquante mais un
 * **en-tête** manquant : les trois routes exigent le jeton de la cliente — #1135
 * pour l'annulation et le report, #1136 pour la prise de rendez-vous — et le
 * front les appelait par le transport du tunnel, qui n'en émet aucun. Ce qui se
 * prouve ici est donc exactement cela — un `Authorization: Bearer` sur le fil,
 * et le chemin que l'API sert.
 *
 * Il n'en reste aucune : c'est le troisième critère d'acceptation de #1207,
 * *« aucune requête de réservation, d'annulation ni de report ne part sans
 * `Authorization` »*, et il se vérifie route par route ci-dessous.
 *
 * Ce qui ne s'y prouve pas : que l'API refuse le rendez-vous d'une autre
 * cliente. C'est son travail, et les suites d'isolation d'`apps/api` s'en
 * chargent. Le front ne peut répondre que de ce qu'il envoie.
 */

const SLUG = 'maison-lotus';
const RENDEZ_VOUS = '55555555-5555-4555-8555-555555555555';
const JETON = 'jeton-de-la-cliente';

const RENDEZ_VOUS_ANNULE: BookedAppointment = {
  id: RENDEZ_VOUS,
  reference: 'RDV-8F3K-27',
  status: 'cancelled',
  serviceId: '11111111-1111-4111-8111-111111111111',
  staffId: '33333333-3333-4333-8333-333333333333',
  clientId: '66666666-6666-4666-8666-666666666666',
  startsAt: '2026-09-01T06:00:00.000Z',
  endsAt: '2026-09-01T07:00:00.000Z',
  price: { amountMinor: 45_000, currency: 'MGA' },
  clientNote: null,
  rescheduledFromId: null,
  cancelledAt: '2026-08-31T10:00:00.000Z',
  cancelledBy: 'client',
};

const fetchMock = vi.fn();

/** Une réponse d'API réduite à ce que le client en lit. */
function reply(status: number, body: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { getSetCookie: () => [] },
  };
}

/** L'URL et l'`init` du dernier appel — ce que le client a réellement émis. */
function lastCall(): { readonly url: string; readonly init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);

  return { url: String(call?.[0]), init: (call?.[1] ?? {}) as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('l’annulation par la cliente', () => {
  it('porte le jeton de sa session, sans quoi la route rend 401 (#1135)', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, RENDEZ_VOUS_ANNULE));

    await expect(cancelAppointment(SLUG, RENDEZ_VOUS, JETON)).resolves.toMatchObject({
      status: 'cancelled',
    });

    const { url, init } = lastCall();
    expect(new URL(url).pathname).toBe(
      `/api/v1/public/${SLUG}/appointments/${RENDEZ_VOUS}/cancel`,
    );
    expect(init.method).toBe('POST');
    expect(headersOf(init)['authorization']).toBe(`Bearer ${JETON}`);
  });

  it('ne désigne la cliente par aucun champ du corps — le jeton seul la nomme', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, RENDEZ_VOUS_ANNULE));

    await cancelAppointment(SLUG, RENDEZ_VOUS, JETON, { reason: 'Empêchement' });

    expect(JSON.parse(String(lastCall().init.body))).toEqual({ reason: 'Empêchement' });
  });
});

describe('le report par la cliente', () => {
  it('porte le jeton de sa session, sur la route de report', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(201, { ...RENDEZ_VOUS_ANNULE, status: 'pending', cancelledAt: null, cancelledBy: null }),
    );

    await rescheduleAppointment(SLUG, RENDEZ_VOUS, JETON, {
      startsAt: '2026-09-02T06:00:00.000Z',
    });

    const { url, init } = lastCall();
    expect(new URL(url).pathname).toBe(
      `/api/v1/public/${SLUG}/appointments/${RENDEZ_VOUS}/reschedule`,
    );
    expect(headersOf(init)['authorization']).toBe(`Bearer ${JETON}`);
  });
});

describe('la prise de rendez-vous par la cliente', () => {
  it('porte le jeton de sa session, sans quoi la route rend 401 (#1136)', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(201, { ...RENDEZ_VOUS_ANNULE, status: 'pending', cancelledAt: null, cancelledBy: null }),
    );

    await bookGuestAppointment(SLUG, JETON, {
      serviceId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2026-09-01T06:00:00.000Z',
      client: {
        firstName: 'Camille',
        lastName: 'Rakoto',
        email: 'camille@example.test',
      },
      dataConsent: true,
    });

    const { url, init } = lastCall();
    expect(new URL(url).pathname).toBe(`/api/v1/public/${SLUG}/appointments`);
    expect(init.method).toBe('POST');
    expect(headersOf(init)['authorization']).toBe(`Bearer ${JETON}`);
  });
});
