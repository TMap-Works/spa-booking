import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  fetchCustomer,
  fetchCustomerHistory,
  updateCustomer,
} from '@/lib/api-client';

/**
 * Les appels du fichier client, et la frontière du tenant qu'ils ne franchissent
 * pas — cinquième critère d'acceptation de #54.
 *
 * « Aucune donnée client d'un autre tenant n'est atteignable » **se prouve**. La
 * preuve côté API est écrite (`crm-tenant.isolation-spec.ts`) ; ce qui restait à
 * montrer est que le front ne défait pas ce scoping. Trois choses, ici :
 *
 * 1. **aucune de ces requêtes ne nomme d'établissement.** Ni dans le chemin, ni
 *    en query, ni dans le corps : le seul en-tête qui désigne l'appelant est le
 *    porteur du jeton, et c'est l'API qui en tire l'établissement
 *    (tenant-isolation §2). Un `tenantId` que le front enverrait serait une
 *    entrée contrôlée par l'appelant ;
 * 2. **un identifiant du salon voisin est introuvable, pas refusé.** L'API rend
 *    404 ; le client le relaie tel quel, sans corps ni donnée, et sans le
 *    distinguer d'un identifiant qui n'existe nulle part ;
 * 3. **une réponse hors contrat échoue à la frontière**, plutôt que de laisser
 *    passer un objet que l'écran lirait de travers.
 */

const TOKEN = 'jeton-du-salon-lotus';
const FARA = '11111111-1111-4111-8111-111111111111';
/** Une fiche du salon d'à côté : la même personne y a son propre identifiant. */
const CHEZ_LE_VOISIN = '99999999-9999-4999-8999-999999999999';

const CUSTOMER = {
  id: FARA,
  firstName: 'Fara',
  lastName: 'Rakotoson',
  email: 'fara.rakotoson@example.mg',
  phone: '+261341234567',
  isActive: true,
  internalNote: 'Peau réactive — éviter les huiles parfumées.',
  createdAt: '2026-03-04T08:00:00.000Z',
};

const HISTORY = {
  summary: {
    totalVisits: 3,
    honoredVisits: 2,
    cancelledVisits: 0,
    noShowVisits: 1,
    upcomingVisits: 0,
    firstVisitAt: '2026-05-14T07:00:00.000Z',
    lastVisitAt: '2026-08-12T07:30:00.000Z',
    totalSpent: { amountMinor: 42000, currency: 'MGA' },
  },
  visits: [
    {
      appointmentId: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
      startsAt: '2026-08-12T07:30:00.000Z',
      endsAt: '2026-08-12T09:00:00.000Z',
      serviceName: 'Soin visage',
      staffName: 'Hasina',
      price: { amountMinor: 18000, currency: 'MGA' },
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

describe('la lecture d’une fiche', () => {
  it('appelle la route par le seul identifiant de fiche, jeton en porteur', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, CUSTOMER));

    await expect(fetchCustomer(TOKEN, FARA)).resolves.toMatchObject({ id: FARA });

    const { url, init } = lastCall();
    expect(url).toBe(`http://localhost:3001/api/v1/customers/${FARA}`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('n’envoie aucun établissement — ni en chemin, ni en query, ni en en-tête', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, CUSTOMER));

    await fetchCustomer(TOKEN, FARA);

    const { url, init } = lastCall();
    // Le chemin est exactement la route de l'API : aucune query, donc aucun
    // paramètre par lequel un établissement pourrait se glisser.
    expect(new URL(url).search).toBe('');
    // Et rien de ce qui part sur le fil ne nomme un établissement : c'est le
    // jeton, vérifié côté API, qui le porte.
    expect(JSON.stringify(init)).not.toMatch(/tenant|slug|etablissement/i);
  });

  it('rend la note interne, que la liste ne transporte pas', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, CUSTOMER));

    const customer = await fetchCustomer(TOKEN, FARA);

    expect(customer.internalNote).toBe('Peau réactive — éviter les huiles parfumées.');
  });

  it('relaie le 404 d’une fiche du salon voisin sans rien en dire de plus', async () => {
    // L'API répond 404 pour un identifiant inconnu, pour une fiche d'un autre
    // établissement et pour un compte du personnel — indistinctement. Le client
    // ne cherche pas à les séparer : le faire ferait de cette route une sonde du
    // fichier voisin (tenant-isolation §4).
    fetchMock.mockResolvedValueOnce(
      reply(404, { code: 'NOT_FOUND', message: 'Fiche cliente introuvable.', details: {} }),
    );

    const failure = await fetchCustomer(TOKEN, CHEZ_LE_VOISIN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
    expect((failure as ApiClientError).status).toBe(404);
    expect((failure as ApiClientError).code).toBe('NOT_FOUND');
  });

  it('refuse à la frontière une réponse qui ne respecte pas le contrat', async () => {
    // Une fiche sans `internalNote` n'est pas une fiche : mieux vaut échouer ici,
    // en nommant le champ, que trois écrans plus loin sur un `undefined`.
    const { internalNote: _omitted, ...incomplete } = CUSTOMER;
    fetchMock.mockResolvedValueOnce(reply(200, incomplete));

    const failure = await fetchCustomer(TOKEN, FARA).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
    expect((failure as ApiClientError).code).toBe('INTERNAL_ERROR');
  });
});

describe('la lecture de l’historique', () => {
  it('appelle la sous-route de la fiche, sans borne quand on s’en remet au serveur', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, HISTORY));

    const history = await fetchCustomerHistory(TOKEN, FARA);

    expect(lastCall().url).toBe(`http://localhost:3001/api/v1/customers/${FARA}/history`);
    expect(history.summary.noShowVisits).toBe(1);
    expect(history.visits).toHaveLength(1);
  });

  it('porte la borne demandée quand l’écran en impose une', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, HISTORY));

    await fetchCustomerHistory(TOKEN, FARA, { limit: 10 });

    expect(lastCall().url).toBe(`http://localhost:3001/api/v1/customers/${FARA}/history?limit=10`);
  });

  it('relaie le 404 sur l’historique d’une fiche voisine', async () => {
    // Sans la relecture préalable côté API, l'historique d'un identifiant
    // inconnu rendrait un agrégat vide en 200 — indiscernable de celui d'une
    // cliente jamais venue.
    fetchMock.mockResolvedValueOnce(
      reply(404, { code: 'NOT_FOUND', message: 'Fiche cliente introuvable.', details: {} }),
    );

    const failure = await fetchCustomerHistory(TOKEN, CHEZ_LE_VOISIN).catch(
      (error: unknown) => error,
    );

    expect((failure as ApiClientError).status).toBe(404);
  });
});

describe('la mise à jour d’une fiche', () => {
  it('envoie un PATCH du seul champ modifié', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ...CUSTOMER, internalNote: 'Nouvelle note.' }));

    await updateCustomer(TOKEN, FARA, { internalNote: 'Nouvelle note.' });

    const { url, init } = lastCall();
    expect(url).toBe(`http://localhost:3001/api/v1/customers/${FARA}`);
    expect(init.method).toBe('PATCH');
    // Un champ **absent** vaut « ne touche pas » : l'écran des notes n'envoie
    // donc pas les coordonnées, et ne risque pas de les effacer en les oubliant.
    expect(JSON.parse(String(init.body))).toEqual({ internalNote: 'Nouvelle note.' });
  });

  it('transporte `null` tel quel — c’est ainsi qu’une note s’efface', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ...CUSTOMER, internalNote: null }));

    await updateCustomer(TOKEN, FARA, { internalNote: null });

    expect(JSON.parse(String(lastCall().init.body))).toEqual({ internalNote: null });
  });

  it('n’écrit rien chez le voisin : le 404 arrive avant toute donnée', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(404, { code: 'NOT_FOUND', message: 'Fiche cliente introuvable.', details: {} }),
    );

    const failure = await updateCustomer(TOKEN, CHEZ_LE_VOISIN, {
      internalNote: 'tentative',
    }).catch((error: unknown) => error);

    expect((failure as ApiClientError).status).toBe(404);
  });
});
