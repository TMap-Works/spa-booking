import type { Locale } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #927 — ouvrir un salon depuis l'accueil.
 *
 * L'action vérifie le salon **avant** de rediriger : l'erreur se dit sur le
 * champ, pas par une page 404 où il n'y a plus rien à corriger. Elle retient le
 * salon ouvert, et ouvre la porte choisie.
 *
 * ## Les trois refus se disent dans la langue de la requête (#1233)
 *
 * Ils étaient écrits en dur, en français, dans `app/actions.ts`. La suite les
 * éprouve donc dans les **deux** langues — et les lit dans les catalogues plutôt
 * que de les recopier : un test qui réécrirait la phrase resterait vert le jour
 * où l'action cesserait de lire le catalogue.
 *
 * Une action serveur n'est pas un composant : elle lit ses messages par
 * `getTranslations`. La doublure ci-dessous est donc celle de `next-intl/server`
 * — l'amorce des suites (`tests/support/next-intl.ts`) en pose une qui fige la
 * langue à `fr`, et il en faut une qui bouge. Son pendant pour les crochets
 * existe déjà dans `tests/support/langue-mobile.ts` ; la mutualiser avec lui
 * demandait de modifier ce fichier partagé, hors de l'empreinte de ce ticket —
 * c'est l'objet d'une issue de suivi.
 */

const readSalonIdentity = vi.fn();
const setCookie = vi.fn();

/** La langue de la requête simulée, que `fixerLangue()` déplace. */
let langue: Locale = 'fr';

function fixerLangue(prochaine: Locale): void {
  langue = prochaine;
}

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: setCookie }),
}));

vi.mock('next-intl/server', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');

  /**
   * `createTranslator` est typé sur le catalogue complet ; l'appeler avec un
   * namespace dont le nom n'est connu qu'à l'exécution demande de relâcher la
   * contrainte, une fois, ici — comme dans l'amorce et dans `langue-mobile.ts`.
   */
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const cache = new Map<string, unknown>();

  return {
    getLocale: () => Promise.resolve(langue),
    getTranslations: (options?: string | { readonly namespace?: string }) => {
      const namespace = typeof options === 'string' ? options : options?.namespace;
      const key = `${langue}:${namespace ?? ''}`;
      const cached = cache.get(key);

      if (cached !== undefined) {
        return Promise.resolve(cached);
      }

      const messages = loadMessages(langue);
      const made = translator(
        namespace === undefined
          ? { locale: langue, messages }
          : { locale: langue, messages, namespace },
      );

      cache.set(key, made);

      return Promise.resolve(made);
    },
  };
});

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
import en from '@/messages/en/booking.json';
import fr from '@/messages/fr/booking.json';

const INITIAL: SalonFinderState = { address: '', fieldError: null, formError: null };

/** Les trois refus, tels que les catalogues les écrivent. */
const REFUS = { fr: fr.home.finder.errors, en: en.home.finder.errors } as const;

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
  fixerLangue('fr');
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

    expect(state.fieldError).toBe(REFUS.fr.empty);
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
      fieldError: REFUS.fr.unknown.replace('{address}', 'Salon Fantôme'),
      formError: null,
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('une API muette : l’encart le dit, et n’accuse pas l’adresse', async () => {
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    const state = await openSalonAction(INITIAL, formulaire('maison-lotus'));

    expect(state.fieldError).toBeNull();
    expect(state.formError).toBe(REFUS.fr.unavailable);
    expect(state.address).toBe('maison-lotus');
    expect(setCookie).not.toHaveBeenCalled();
  });
});

describe('la langue de la requête (#1233)', () => {
  it('dit l’adresse manquante en anglais', async () => {
    fixerLangue('en');

    const state = await openSalonAction(INITIAL, formulaire(''));

    expect(state.fieldError).toBe(REFUS.en.empty);
    expect(state.fieldError).not.toBe(REFUS.fr.empty);
  });

  it('nomme le salon introuvable en anglais, sans perdre la saisie', async () => {
    fixerLangue('en');
    readSalonIdentity.mockResolvedValue({ status: 'unknown' });

    const state = await openSalonAction(INITIAL, formulaire('Salon Fantôme'));

    expect(state).toEqual({
      address: 'Salon Fantôme',
      fieldError: REFUS.en.unknown.replace('{address}', 'Salon Fantôme'),
      formError: null,
    });
  });

  it('dit le service injoignable en anglais', async () => {
    fixerLangue('en');
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    const state = await openSalonAction(INITIAL, formulaire('maison-lotus'));

    expect(state.formError).toBe(REFUS.en.unavailable);
  });

  it('n’écrit plus aucune phrase en dur : les trois refus diffèrent d’une langue à l’autre', () => {
    // Un message identique dans les deux catalogues passerait les trois tests
    // ci-dessus sans rien prouver.
    expect(REFUS.en.empty).not.toBe(REFUS.fr.empty);
    expect(REFUS.en.unknown).not.toBe(REFUS.fr.unknown);
    expect(REFUS.en.unavailable).not.toBe(REFUS.fr.unavailable);
  });
});
