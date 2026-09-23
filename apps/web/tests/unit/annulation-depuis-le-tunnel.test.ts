// @vitest-environment node
import { ERROR_CODES, type BookedAppointment } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';

/**
 * L'annulation et le report d'un rendez-vous par la cliente, depuis les deux
 * écrans qui les offrent (#1201).
 *
 * ## Ce que ces suites tiennent
 *
 * 1. **la session voyage** — l'espace client joint le jeton qu'il détenait déjà,
 *    et le tunnel passe par une adresse de l'espace client, faute de quoi le
 *    navigateur ne joindrait aucun cookie (`compte/session.ts` les borne à
 *    `/{slug}/compte`) ;
 * 2. **403 et 404 sont indiscernables** — le premier apprendrait que le
 *    rendez-vous existe, c'est-à-dire exactement ce que le 404 de l'API existe
 *    pour taire (tenant-isolation §4) ;
 * 3. **401 invite à se connecter** plutôt que d'échouer en silence.
 *
 * Environnement Node : la route manipule des `Request` et des `Response` du
 * standard, que jsdom ne fournit pas — même raison que
 * `session-refresh-routes.test.ts`.
 */

const cancelAppointment = vi.fn();
const rescheduleAppointment = vi.fn();
const refreshSession = vi.fn();

// Le module réel est repris et trois fonctions seulement sont remplacées :
// `ApiClientError` doit rester la vraie classe, sans quoi les `instanceof` des
// actions ne reconnaîtraient plus les refus de l'API.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  cancelAppointment: (...args: unknown[]) => cancelAppointment(...args),
  rescheduleAppointment: (...args: unknown[]) => rescheduleAppointment(...args),
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));

/** Les cookies que le navigateur envoie avec la requête. */
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: vi.fn(),
    }),
}));

import {
  cancelOwnAppointmentAction,
  rescheduleOwnAppointmentAction,
} from '@/app/(account)/[tenantSlug]/compte/actions';
import { cancellationPath } from '@/app/(account)/[tenantSlug]/compte/paths';
import { POST as annuler } from '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/route';

const SLUG = 'maison-lotus';
const RENDEZ_VOUS = '55555555-5555-4555-8555-555555555555';
const JETON = 'jeton-de-la-cliente';

const ANNULE: BookedAppointment = {
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

/** La requête que la route reçoit — son corps n'est pas lu, l'identifiant est dans le chemin. */
function requete(appointmentId = RENDEZ_VOUS): Parameters<typeof annuler>[1] {
  return { params: Promise.resolve({ tenantSlug: SLUG, appointmentId }) };
}

beforeEach(() => {
  jar.set('spa_account_access', JETON);
  cancelAppointment.mockResolvedValue(ANNULE);
  rescheduleAppointment.mockResolvedValue({ ...ANNULE, status: 'pending', cancelledAt: null });
});

afterEach(() => {
  jar.clear();
  vi.clearAllMocks();
});

describe('les actions de l’espace client', () => {
  it('joignent le jeton de la session à l’annulation', async () => {
    await expect(cancelOwnAppointmentAction(SLUG, RENDEZ_VOUS)).resolves.toMatchObject({
      ok: true,
    });

    expect(cancelAppointment).toHaveBeenCalledWith(SLUG, RENDEZ_VOUS, JETON, {});
  });

  it('joignent le jeton de la session au report', async () => {
    await expect(
      rescheduleOwnAppointmentAction(SLUG, RENDEZ_VOUS, { startsAt: '2026-09-02T06:00:00.000Z' }),
    ).resolves.toMatchObject({ ok: true });

    expect(rescheduleAppointment).toHaveBeenCalledWith(SLUG, RENDEZ_VOUS, JETON, {
      startsAt: '2026-09-02T06:00:00.000Z',
    });
  });

  it('rendent le même refus sur un 403 que sur un 404 — le rendez-vous d’une autre', async () => {
    cancelAppointment.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.FORBIDDEN, 'Rôle insuffisant.', 403),
    );
    const interdit = await cancelOwnAppointmentAction(SLUG, RENDEZ_VOUS);

    cancelAppointment.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.NOT_FOUND, 'Introuvable.', 404),
    );
    const introuvable = await cancelOwnAppointmentAction(SLUG, RENDEZ_VOUS);

    expect(interdit).toEqual(introuvable);
    expect(interdit).toMatchObject({ ok: false, code: ERROR_CODES.NOT_FOUND });
    // Rien qui parle de propriété : c'est par là que l'écran redirait ce que le
    // 404 de l'API existe pour taire.
    expect(JSON.stringify(interdit)).not.toMatch(/appartient|droits|interdit/i);
  });

  it('laissent passer le 401, que l’écran traduit en renouvellement de session', async () => {
    jar.clear();

    await expect(cancelOwnAppointmentAction(SLUG, RENDEZ_VOUS)).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.UNAUTHORIZED,
    });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });
});

describe('la route d’annulation de l’espace client', () => {
  it('est servie sous le chemin des cookies de session', () => {
    // C'est tout l'enjeu : une adresse hors de `/{slug}/compte` ne recevrait
    // aucun jeton, et l'API rendrait 401 (#1135).
    expect(cancellationPath(SLUG, RENDEZ_VOUS)).toBe(
      `/${SLUG}/compte/rendez-vous/${RENDEZ_VOUS}/annulation`,
    );
  });

  it('annule au nom de la cliente connectée et rend le rendez-vous', async () => {
    const response = await annuler(new Request('http://site.test', { method: 'POST' }), requete());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: ANNULE });
    expect(cancelAppointment).toHaveBeenCalledWith(SLUG, RENDEZ_VOUS, JETON);
  });

  it('invite à se connecter quand la session manque, sans appeler l’API', async () => {
    jar.clear();

    const response = await annuler(new Request('http://site.test', { method: 'POST' }), requete());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.UNAUTHORIZED,
    });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('ne dit pas « session expirée » quand c’est le renouvellement qui a échoué', async () => {
    // Cookie d'accès périmé, cookie de rafraîchissement en place, et l'API
    // d'identité momentanément indisponible : la session est parfaitement
    // valide. La dire expirée enverrait se reconnecter là où réessayer suffit —
    // c'est la distinction que porte déjà `isRefreshRefused` (#860).
    jar.delete('spa_account_access');
    jar.set('spa_account_refresh', 'jeton-de-rafraichissement');
    refreshSession.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Injoignable.', 503),
    );

    const response = await annuler(new Request('http://site.test', { method: 'POST' }), requete());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('refuse un identifiant mal formé avant d’atteindre l’API', async () => {
    const response = await annuler(
      new Request('http://site.test', { method: 'POST' }),
      requete('pas-un-uuid'),
    );

    expect(response.status).toBe(400);
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('rend 404 sur un 403 de l’API — le refus ne dit pas que le rendez-vous existe', async () => {
    cancelAppointment.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.FORBIDDEN, 'Rôle insuffisant.', 403),
    );

    const response = await annuler(new Request('http://site.test', { method: 'POST' }), requete());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.NOT_FOUND,
    });
  });
});
