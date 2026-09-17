import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #927 — ouvrir un salon depuis l'accueil.
 *
 * L'action vérifie le salon **avant** de rediriger : l'erreur se dit sur le
 * champ, pas par une page 404 où il n'y a plus rien à corriger. Elle retient le
 * salon ouvert, et ouvre la porte choisie.
 */

const readSalonIdentity = vi.fn();
const setCookie = vi.fn();

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: setCookie }),
}));

class RedirectSignal extends Error {
  public constructor(public readonly destination: string) {
    super(`redirect ${destination}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (destination: string) => {
    throw new RedirectSignal(destination);
  },
}));

import { openSalonAction, type SalonFinderState } from '@/app/actions';

const INITIAL: SalonFinderState = { address: '', fieldError: null, formError: null };

function formulaire(adresse: string, porte?: string): FormData {
  const data = new FormData();
  data.set('adresse', adresse);
  if (porte !== undefined) {
    data.set('porte', porte);
  }
  return data;
}

async function destinationDe(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) {
      return error.destination;
    }
    throw error;
  }
  throw new Error('l’action n’a pas redirigé');
}

afterEach(() => {
  readSalonIdentity.mockReset();
  setCookie.mockReset();
});

describe('un salon connu', () => {
  it.each([
    ['reservation', '/maison-lotus/reservation'],
    ['compte', '/maison-lotus/compte'],
    ['back-office', '/maison-lotus/admin/connexion'],
  ])('ouvre la porte « %s »', async (porte, chemin) => {
    readSalonIdentity.mockResolvedValue({ status: 'found', slug: 'maison-lotus', name: 'Maison Lotus' });

    await expect(destinationDe(openSalonAction(INITIAL, formulaire('Maison Lotus', porte)))).resolves.toBe(
      chemin,
    );
    expect(readSalonIdentity).toHaveBeenCalledWith('maison-lotus');
  });

  it('prend la réservation quand la porte manque ou est inventée', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'found', slug: 'maison-lotus', name: 'Maison Lotus' });

    await expect(destinationDe(openSalonAction(INITIAL, formulaire('maison-lotus')))).resolves.toBe(
      '/maison-lotus/reservation',
    );
    await expect(
      destinationDe(openSalonAction(INITIAL, formulaire('maison-lotus', '//exemple.test'))),
    ).resolves.toBe('/maison-lotus/reservation');
  });

  it('retient le salon ouvert, dans un cookie que le script de la page ne lit pas', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'found', slug: 'maison-lotus', name: 'Maison Lotus' });

    await destinationDe(openSalonAction(INITIAL, formulaire('maison-lotus', 'compte')));

    expect(setCookie).toHaveBeenCalledWith(
      'spa_dernier_salon',
      'maison-lotus',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });
});

describe('ce qui reste sur la page', () => {
  it('une adresse vide, sans appeler l’API', async () => {
    const state = await openSalonAction(INITIAL, formulaire('   '));

    expect(state.fieldError).toMatch(/saisissez le nom de votre salon/i);
    expect(state.formError).toBeNull();
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });

  it('un lien qui ne désigne aucun salon, sans appeler l’API', async () => {
    const state = await openSalonAction(INITIAL, formulaire('https://www.exemple.fr/'));

    expect(state.fieldError).toMatch(/aucun salon ne répond/i);
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });

  it('un salon inconnu : le message est sur le champ, et la saisie est gardée', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unknown' });

    const state = await openSalonAction(INITIAL, formulaire('Salon Fantôme', 'compte'));

    expect(state).toEqual({
      address: 'Salon Fantôme',
      fieldError: expect.stringMatching(/aucun salon ne répond à « Salon Fantôme »/i),
      formError: null,
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('une API muette : l’encart le dit, et n’accuse pas l’adresse', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    const state = await openSalonAction(INITIAL, formulaire('maison-lotus'));

    expect(state.fieldError).toBeNull();
    expect(state.formError).toMatch(/momentanément injoignable/i);
    expect(state.address).toBe('maison-lotus');
    expect(setCookie).not.toHaveBeenCalled();
  });
});
