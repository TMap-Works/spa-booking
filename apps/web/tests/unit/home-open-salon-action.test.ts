import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #927 — ouvrir un salon depuis l'accueil.
 *
 * L'action vérifie le salon **avant** de rediriger : l'erreur se dit sur le
 * champ, pas par une page 404 où il n'y a plus rien à corriger. Elle retient le
 * salon ouvert, et ouvre la porte choisie.
 *
 * ## Ce qu'elle rend d'un refus est un motif, plus une phrase (#1354)
 *
 * Les trois messages étaient écrits en dur, en français, puis lus dans le
 * catalogue par `getTranslations` (#1233). Ils n'y sont plus lus du tout :
 * `useActionState` garde ce résultat d'une soumission à l'autre, et le
 * sélecteur de langue rejoue la route sans démonter le formulaire — une phrase
 * résolue ici restait donc dans la langue de la soumission. L'action rend
 * `'empty' | 'unknown' | 'unavailable'`, et c'est `salon-finder.tsx` qui écrit
 * la phrase au rendu.
 *
 * Cette suite vérifie donc **quel motif** sort de quel cas, et qu'aucune phrase
 * n'en sort — la traduction se prouve à l'écran, dans
 * `erreur-de-champ-suit-la-langue.test.tsx`. Plus de doublure de
 * `next-intl/server` : l'action ne lit plus aucun message.
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

const INITIAL: SalonFinderState = { address: '', fieldRefusal: null, formRefusal: null };

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

    expect(state.fieldRefusal).toBe('empty');
    expect(state.formRefusal).toBeNull();
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });

  it('un lien qui ne désigne aucun salon, sans appeler l’API', async () => {
    const state = await openSalonAction(INITIAL, formulaire('https://www.exemple.fr/'));

    expect(state.fieldRefusal).toBe('unknown');
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });

  it('un salon inconnu : le refus est sur le champ, et la saisie est gardée', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unknown' });

    const state = await openSalonAction(INITIAL, formulaire('Salon Fantôme', 'compte'));

    // L'adresse est rendue telle quelle : c'est elle que le formulaire
    // interpole dans la phrase, le motif n'a pas à la porter deux fois.
    expect(state).toEqual({
      address: 'Salon Fantôme',
      fieldRefusal: 'unknown',
      formRefusal: null,
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('une API muette : l’encart le dit, et n’accuse pas l’adresse', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    const state = await openSalonAction(INITIAL, formulaire('maison-lotus'));

    expect(state.fieldRefusal).toBeNull();
    expect(state.formRefusal).toBe('unavailable');
    expect(state.address).toBe('maison-lotus');
    expect(setCookie).not.toHaveBeenCalled();
  });

  /**
   * Le garde-fou de #1354 : ce qui sort de l'action doit rester une **donnée**.
   *
   * Un motif est un identifiant court, sans espace ; une phrase de catalogue en
   * a toutes les qualités contraires. Le jour où quelqu'un remettrait un
   * `t(…)` ici, ce cas tombe — et c'est la seule façon de s'en apercevoir sans
   * monter l'écran.
   */
  it('ne rend jamais de phrase, sur aucun des trois refus', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    const states = [
      await openSalonAction(INITIAL, formulaire('')),
      await openSalonAction(INITIAL, formulaire('https://www.exemple.fr/')),
      await openSalonAction(INITIAL, formulaire('maison-lotus')),
    ];

    for (const state of states) {
      for (const refusal of [state.fieldRefusal, state.formRefusal]) {
        expect(refusal === null || ['empty', 'unknown', 'unavailable'].includes(refusal)).toBe(true);
      }
    }
  });
});
