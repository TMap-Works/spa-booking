import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, fetchAdminAvailability } from '@/lib/api-client';

/**
 * La lecture de disponibilité du back-office, et la frontière du tenant qu'elle
 * ne franchit pas — troisième critère d'acceptation de #642.
 *
 * ## Ce que ces tests prouvent, et ce qu'ils ne prouvent pas
 *
 * Ils prouvent ce dont le **client web** répond : que le comptoir interroge la
 * route gardée et non la publique, que le seul élément d'identification qui
 * parte sur le fil est le jeton porteur, et qu'aucun établissement ne circule
 * — ni dans le chemin, ni en query, ni en en-tête. C'est le point de bascule du
 * ticket : sur `GET /public/{slug}/availability`, l'établissement venait du
 * **slug d'URL**, une valeur que l'appelant écrit ; sur `GET /v1/availability`,
 * il vient du **jeton**, que l'API vérifie.
 *
 * Ils ne prouvent pas le scoping côté serveur : que la requête SQL soit bornée à
 * l'établissement du jeton relève d'`apps/api`, et s'y prouve par les suites
 * d'isolation du module `availability`. Ce qui se vérifie ici est que le front
 * ne défait pas ce scoping — exactement la division retenue par
 * `admin-client-api.test.ts` pour les fiches clientes (#54).
 */

const TOKEN = 'jeton-du-salon-lotus';
/** Le jeton du salon d'à côté — même API, même route, autre établissement. */
const JETON_DU_VOISIN = 'jeton-du-salon-voisin';

const SERVICE = '11111111-1111-4111-8111-111111111111';
const PRATICIENNE = '33333333-3333-4333-8333-333333333333';
const RENDEZ_VOUS = '44444444-4444-4444-8444-444444444444';
/** Une prestation du salon d'à côté : l'API la rend introuvable, pas interdite. */
const SERVICE_DU_VOISIN = '99999999-9999-4999-8999-999999999999';

const DISPONIBILITE = {
  serviceId: SERVICE,
  timezone: 'Indian/Antananarivo',
  days: [
    {
      date: '2026-09-15',
      slots: [
        {
          startsAt: '2026-09-15T06:00:00.000Z',
          endsAt: '2026-09-15T07:00:00.000Z',
          staffId: PRATICIENNE,
        },
      ],
    },
  ],
};

const fetchMock = vi.fn();

/** Une réponse d'API réduite à ce que le client en lit. */
function reply(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** L'URL et l'`init` du dernier appel — ce que le client a réellement émis. */
function lastCall(): { readonly url: string; readonly init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);

  return { url: String(call?.[0]), init: (call?.[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('la lecture de disponibilité du comptoir', () => {
  it('interroge la route gardée, jamais la route publique du tunnel', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, DISPONIBILITE));

    await expect(
      fetchAdminAvailability(TOKEN, { serviceId: SERVICE, from: '2026-09-15', to: '2026-09-15' }),
    ).resolves.toMatchObject({ serviceId: SERVICE });

    const { url, init } = lastCall();
    // C'est tout l'objet du ticket : la publique porte un quota par adresse, et
    // le serveur Next n'en a qu'une pour tous les comptoirs et tout le tunnel.
    expect(new URL(url).pathname).toBe('/api/v1/availability');
    expect(url).not.toMatch(/\/public\//);
    expect(init.method).toBe('GET');
  });

  it('porte le jeton de session, et c’est lui seul qui désigne l’établissement', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, DISPONIBILITE));

    await fetchAdminAvailability(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    });

    const { url, init } = lastCall();
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);

    // Aucun établissement ne circule : le chemin ne porte pas de slug, et la
    // query ne porte que les bornes de l'interrogation. Un `tenantId` écrit par
    // le front serait une entrée contrôlée par l'appelant (tenant-isolation §2).
    expect([...new URL(url).searchParams.keys()].sort()).toEqual(['from', 'serviceId', 'to']);
    expect(JSON.stringify(init)).not.toMatch(/tenant|slug|etablissement/i);
  });

  it('n’envoie les facultatifs que lorsqu’ils sont renseignés', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, DISPONIBILITE));

    await fetchAdminAvailability(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
      staffId: PRATICIENNE,
      excludeAppointmentId: RENDEZ_VOUS,
    });

    const params = new URL(lastCall().url).searchParams;
    expect(params.get('staffId')).toBe(PRATICIENNE);
    // Le rendez-vous qu'on déplace ne doit pas s'occuper lui-même (#442).
    expect(params.get('excludeAppointmentId')).toBe(RENDEZ_VOUS);
  });

  it('ne lit pas les créneaux du voisin : seul le jeton change, et la réponse avec', async () => {
    // Deux appels strictement identiques à l'octet près — même chemin, même
    // query —, séparés par le seul en-tête `Authorization`. L'API borne la
    // lecture sur l'établissement du jeton : le voisin reçoit les siens, jamais
    // ceux du premier salon.
    const CRENEAUX_DU_VOISIN = {
      ...DISPONIBILITE,
      days: [{ date: '2026-09-15', slots: [] }],
    };

    fetchMock.mockResolvedValueOnce(reply(200, DISPONIBILITE));
    const chezNous = await fetchAdminAvailability(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    });
    const appelDuSalon = lastCall();

    fetchMock.mockResolvedValueOnce(reply(200, CRENEAUX_DU_VOISIN));
    const chezLeVoisin = await fetchAdminAvailability(JETON_DU_VOISIN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    });
    const appelDuVoisin = lastCall();

    expect(appelDuVoisin.url).toBe(appelDuSalon.url);
    expect((appelDuVoisin.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${JETON_DU_VOISIN}`,
    );
    expect(chezNous.days[0]?.slots).toHaveLength(1);
    expect(chezLeVoisin.days[0]?.slots).toHaveLength(0);
  });

  it('relaie le 404 d’une prestation du salon voisin sans rien en dire de plus', async () => {
    // L'API rend 404 pour une prestation inconnue, retirée du catalogue, ou
    // appartenant à un autre établissement — les trois indistinctement, faute de
    // quoi cette route devient une sonde du catalogue voisin
    // (tenant-isolation §4, en-tête d'`AvailabilityController`).
    fetchMock.mockResolvedValueOnce(
      reply(404, { code: 'NOT_FOUND', message: 'Prestation introuvable.', details: {} }),
    );

    const refus = await fetchAdminAvailability(TOKEN, {
      serviceId: SERVICE_DU_VOISIN,
      from: '2026-09-15',
      to: '2026-09-15',
    }).catch((error: unknown) => error);

    expect(refus).toBeInstanceOf(ApiClientError);
    expect((refus as ApiClientError).status).toBe(404);
    expect((refus as ApiClientError).code).toBe('NOT_FOUND');
  });

  it('refuse l’appel sans session — le 401 remonte tel quel', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(401, { code: 'UNAUTHORIZED', message: 'Session expirée.', details: {} }),
    );

    const refus = await fetchAdminAvailability('jeton-perime', {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    }).catch((error: unknown) => error);

    expect((refus as ApiClientError).status).toBe(401);
    expect((refus as ApiClientError).code).toBe('UNAUTHORIZED');
  });

  it('refuse à la frontière une réponse qui ne respecte pas le contrat', async () => {
    // Une vue de disponibilité sans fuseau n'est pas exploitable : le découpage
    // en journées est fait par le serveur, et l'affichage a besoin du fuseau
    // pour poser les heures. Mieux vaut échouer ici, en nommant le champ.
    const { timezone: _omis, ...horsContrat } = DISPONIBILITE;
    fetchMock.mockResolvedValueOnce(reply(200, horsContrat));

    const refus = await fetchAdminAvailability(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    }).catch((error: unknown) => error);

    expect(refus).toBeInstanceOf(ApiClientError);
    expect((refus as ApiClientError).code).toBe('INTERNAL_ERROR');
  });
});
