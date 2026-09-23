// @vitest-environment node
import { ERROR_CODES, type BookedAppointment, type PublicTenant } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';

/**
 * La prise de rendez-vous depuis le tunnel, une fois la route de l'API gardée
 * (#1207).
 *
 * ## Ce que cette suite tient
 *
 * 1. **la session voyage** — le tunnel poste sur une adresse de l'espace
 *    client, faute de quoi le navigateur ne joindrait aucun cookie
 *    (`compte/session.ts` les borne à `/{slug}/compte`) et
 *    `POST /public/{slug}/appointments` rendrait 401 depuis #1136 ;
 * 2. **le jeton est lu côté serveur**, jamais reçu du corps : c'est lui, et non
 *    l'adresse e-mail postée, qui désigne la cliente ;
 * 3. **le code de refus survit** au passage par la route — c'est sur lui, et sur
 *    lui seul, que le récapitulatif distingue le créneau perdu d'une panne
 *    (`summary-step.tsx`) ;
 * 4. **une session absente n'atteint pas l'API**, et se dit « connectez-vous »
 *    plutôt que d'échouer en silence.
 *
 * Environnement Node : la route manipule des `Request` et des `Response` du
 * standard, que jsdom ne fournit pas — même raison que
 * `annulation-depuis-le-tunnel.test.ts`.
 */

const bookGuestAppointment = vi.fn();
const refreshSession = vi.fn();
const loadSalonTenant = vi.fn();

// Le module réel est repris et deux fonctions seulement sont remplacées :
// `ApiClientError` doit rester la vraie classe, sans quoi les `instanceof` de la
// route ne reconnaîtraient plus les refus de l'API.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  bookGuestAppointment: (...args: unknown[]) => bookGuestAppointment(...args),
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));

// Le chargement du salon part vers l'API : la route ne s'en sert que pour le
// pays par défaut du téléphone (#1028), et c'est la seule chose qu'on lui donne.
vi.mock('@/app/(booking)/[tenantSlug]/salon-data', () => ({
  loadSalonTenant: (...args: unknown[]) => loadSalonTenant(...args),
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

import { bookingRequestPath } from '@/app/(account)/[tenantSlug]/compte/paths';
import { POST as reserver } from '@/app/(account)/[tenantSlug]/compte/reservation/route';

const SLUG = 'maison-lotus';
const JETON = 'jeton-de-la-cliente';

const SALON: PublicTenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
};

/** Ce que le tunnel poste — la sortie de `summary-step.tsx`, au champ près. */
const DEMANDE = {
  serviceId: '22222222-2222-4222-8222-222222222222',
  startsAt: '2026-09-01T06:00:00.000Z',
  client: {
    firstName: 'Camille',
    lastName: 'Rakoto',
    email: 'camille@example.test',
    phone: '+261341234567',
  },
  dataConsent: true,
};

const PRIS: BookedAppointment = {
  id: '55555555-5555-4555-8555-555555555555',
  reference: 'RDV-8F3K-27',
  status: 'pending',
  serviceId: DEMANDE.serviceId,
  staffId: '44444444-4444-4444-8444-444444444444',
  clientId: '66666666-6666-4666-8666-666666666666',
  startsAt: '2026-09-01T06:00:00.000Z',
  endsAt: '2026-09-01T07:00:00.000Z',
  price: { amountMinor: 3500, currency: 'EUR' },
  clientNote: null,
  rescheduledFromId: null,
  cancelledAt: null,
  cancelledBy: null,
};

function requete(body: unknown = DEMANDE): Request {
  return new Request('http://site.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const contexte: Parameters<typeof reserver>[1] = { params: Promise.resolve({ tenantSlug: SLUG }) };

beforeEach(() => {
  jar.set('spa_account_access', JETON);
  loadSalonTenant.mockResolvedValue(SALON);
  bookGuestAppointment.mockResolvedValue(PRIS);
});

afterEach(() => {
  jar.clear();
  vi.clearAllMocks();
});

describe('l’adresse de la réservation', () => {
  it('est servie sous le chemin des cookies de session', () => {
    // C'est tout l'enjeu du ticket : une adresse hors de `/{slug}/compte` ne
    // recevrait aucun jeton, et l'API rendrait 401 (#1136).
    expect(bookingRequestPath(SLUG)).toBe(`/${SLUG}/compte/reservation`);
  });
});

describe('la route de réservation de l’espace client', () => {
  it('réserve au nom de la cliente connectée, jeton joint', async () => {
    const response = await reserver(requete(), contexte);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true, data: PRIS });

    const [slug, jeton, corps] = bookGuestAppointment.mock.calls[0] ?? [];
    expect(slug).toBe(SLUG);
    // Le jeton vient des cookies, jamais du corps : c'est lui qui nomme la
    // cliente depuis #1136.
    expect(jeton).toBe(JETON);
    expect(corps).toMatchObject({ serviceId: DEMANDE.serviceId, dataConsent: true });
  });

  it('invite à se connecter quand la session manque, sans appeler l’API', async () => {
    jar.clear();

    const response = await reserver(requete(), contexte);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      // Le code compte autant que le statut : c'est lui que le récapitulatif
      // traduit en retour à l'écran de connexion.
      code: ERROR_CODES.UNAUTHORIZED,
    });
    expect(bookGuestAppointment).not.toHaveBeenCalled();
  });

  it('ne dit pas « connectez-vous » quand c’est le renouvellement qui a échoué', async () => {
    // Cookie d'accès périmé, cookie de rafraîchissement en place, et l'API
    // d'identité momentanément indisponible : la session est valide, et le
    // tunnel parcouru ne doit pas être perdu là où réessayer suffit (#860).
    jar.delete('spa_account_access');
    jar.set('spa_account_refresh', 'jeton-de-rafraichissement');
    refreshSession.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Injoignable.', 503),
    );

    const response = await reserver(requete(), contexte);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
    expect(bookGuestAppointment).not.toHaveBeenCalled();
  });

  it('refuse une demande incomplète avant d’atteindre l’API', async () => {
    const { dataConsent: _consentement, ...sansAccord } = DEMANDE;

    const response = await reserver(requete(sansAccord), contexte);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
    expect(bookGuestAppointment).not.toHaveBeenCalled();
  });

  it('rend le code du refus de l’API tel quel — le créneau perdu reste un créneau perdu', async () => {
    bookGuestAppointment.mockRejectedValueOnce(
      new ApiClientError(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE, 'Slot lock held.', 409),
    );

    const response = await reserver(requete(), contexte);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: ERROR_CODES.SLOT_NO_LONGER_AVAILABLE,
    });
  });
});
