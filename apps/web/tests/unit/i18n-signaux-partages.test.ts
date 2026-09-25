import { DEFAULT_LOCALE, ERROR_CODES, LOCALES, errorMessage, type Locale } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_LOCALE_COOKIE, LOCALE_COOKIE, TENANT_SLUG_HEADER } from '@/i18n/cookies';

/**
 * Les deux lecteurs de langue rendent la **même** langue pour les mêmes signaux
 * — #1286.
 *
 * ## Ce que cette suite protège
 *
 * Deux modules lisent les signaux de langue de la requête, et ils ne peuvent pas
 * s'appeler l'un l'autre : `i18n/server.ts::requestLocale()`, qui rend la langue
 * de la page, et le refus que `lib/api-client.ts` lève quand il n'a pas pu
 * joindre l'API (#1234) — lequel ne peut pas passer par le premier, puisque le
 * premier l'appelle pour lire `Tenant.defaultLocale`. Un `getLocale()` posé dans
 * ce `catch` attendrait la configuration de requête qui l'attend elle-même.
 *
 * Les trois lectures étaient donc écrites deux fois. Ce sont désormais celles
 * de `i18n/signals.ts`, la feuille que les deux emploient — et c'est ce que
 * cette suite tient : le jour où un signal s'ajoute avant l'établissement, ou où
 * un cookie change de nom, un lecteur qui aurait été oublié fait rougir cette
 * table plutôt que de laisser un refus se lire dans une langue que la page
 * n'emploie pas.
 *
 * ## Comment la langue du refus s'observe
 *
 * `refusalLocale()` n'est pas exportée, et n'a pas à l'être : ce qui compte est
 * la **phrase** que le visiteur lit. La suite coupe donc `fetch` et lit la
 * langue du message levé, en la retrouvant dans la table bilingue du contrat
 * (`errorMessage`). C'est le chemin réel, de bout en bout — un refus formé par
 * le client d'API, pas une fonction interne exercée à la pince.
 *
 * ## Ce qu'elle ne dit pas
 *
 * L'ordre des cinq étapes, éprouvé par `i18n-resolve.test.ts` sur les fonctions
 * pures de `i18n/resolve.ts`. Ici, seule l'**égalité des deux lecteurs** est en
 * jeu ; les langues attendues n'y sont que pour que la table dise ce qu'elle
 * vérifie, plutôt que de se contenter d'un accord sur une valeur fausse.
 */

/** La requête que les deux lecteurs voient — reposée avant chaque cas. */
const requete: {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  /** Hors requête : `next/headers` lève, comme dans un script ou une tâche de fond. */
  horsRequete: boolean;
} = { cookies: {}, headers: {}, horsRequete: false };

vi.mock('next/headers', () => ({
  cookies: () => {
    if (requete.horsRequete) {
      throw new Error('`cookies` was called outside a request scope.');
    }

    return Promise.resolve({
      get: (nom: string) => {
        const value = requete.cookies[nom];

        return value === undefined ? undefined : { value };
      },
    });
  },
  headers: () => {
    if (requete.horsRequete) {
      throw new Error('`headers` was called outside a request scope.');
    }

    return Promise.resolve(new Headers(requete.headers));
  },
}));

// Après les doublures, comme le fait `admin-checkout-pdf-langue.test.ts` : la
// transformation de Vitest garde l'ordre des imports relativement aux
// instructions, et ces deux modules lisent `next/headers` dès leur chargement.
import { requestLocale } from '@/i18n/server';
import { requestLocaleSignals } from '@/i18n/signals';
import { fetchPublicTenant } from '@/lib/api-client';

const SLUG = 'maison-lotus';

/** Le salon visité, tel que l'API le rend — seule sa langue compte ici. */
const SALON = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  defaultLocale: 'fr',
};

/** Pose les signaux de la requête en cours. */
function poser(signaux: {
  readonly cookies?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}): void {
  requete.cookies = { ...signaux.cookies };
  requete.headers = { ...signaux.headers };
  requete.horsRequete = false;
}

afterEach(() => {
  vi.unstubAllGlobals();
  poser({});
});

/** La langue de la page — le lecteur de `i18n/server.ts`. */
function langueDeLaPage(): Promise<Locale> {
  return requestLocale();
}

/**
 * La langue du refus — le lecteur du client d'API, observé sur la phrase qu'il
 * lève quand l'API est injoignable.
 */
async function langueDuRefus(): Promise<Locale> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('API éteinte'))),
  );

  try {
    await fetchPublicTenant(SLUG);
  } catch (cause) {
    return langueDeLaPhrase(cause instanceof Error ? cause.message : String(cause));
  }

  throw new Error('Le client d’API n’a pas refusé alors que `fetch` a échoué.');
}

/** La langue dans laquelle cette phrase est écrite, selon la table du contrat. */
function langueDeLaPhrase(message: string): Locale {
  const langue = LOCALES.find(
    (candidate) => errorMessage(ERROR_CODES.SERVICE_UNAVAILABLE, candidate) === message,
  );

  if (langue === undefined) {
    throw new Error(`Aucune langue du contrat ne dit « ${message} ».`);
  }

  return langue;
}

describe('les deux lecteurs de langue, sur les mêmes signaux', () => {
  it.each([
    ['un choix explicite au sélecteur', { cookies: { [LOCALE_COOKIE]: 'fr' } }, 'fr'],
    [
      'un choix explicite recopié à la main, casse et espaces compris',
      { cookies: { [LOCALE_COOKIE]: ' FR ' } },
      'fr',
    ],
    [
      'la préférence du compte, en l’absence de choix explicite',
      { cookies: { [ACCOUNT_LOCALE_COOKIE]: 'fr' } },
      'fr',
    ],
    [
      'le choix explicite, qui l’emporte sur la préférence du compte',
      { cookies: { [LOCALE_COOKIE]: 'en', [ACCOUNT_LOCALE_COOKIE]: 'fr' } },
      'en',
    ],
    [
      'un `Accept-Language` régional',
      { headers: { 'accept-language': 'fr-CA,fr;q=0.9,en-US;q=0.8' } },
      'fr',
    ],
    ['un `Accept-Language` anglophone', { headers: { 'accept-language': 'en-US,en;q=0.9' } }, 'en'],
    [
      'un cookie trafiqué, que le navigateur rattrape',
      { cookies: { [LOCALE_COOKIE]: 'klingon' }, headers: { 'accept-language': 'fr' } },
      'fr',
    ],
    [
      'un `Accept-Language` qui ne dit rien d’exploitable',
      { headers: { 'accept-language': '*;q=0.5' } },
      'en',
    ],
    ['une requête entièrement muette', {}, 'en'],
  ] as const)('rendent la même langue sur %s', async (_, signaux, attendue) => {
    poser(signaux);

    const page = await langueDeLaPage();
    const refus = await langueDuRefus();

    expect(page).toBe(attendue);
    expect(refus).toBe(page);
  });
});

describe('l’établissement, la seule étape que le refus ne consulte pas', () => {
  it('décide de la langue de la page, jamais de celle du refus', async () => {
    poser({ headers: { [TENANT_SLUG_HEADER]: SLUG } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SALON) })),
    );

    const page = await langueDeLaPage();
    const refus = await langueDuRefus();

    // Le salon parle français et la page le suit ; le refus, lui, ne peut pas le
    // lire sans rappeler l'API qui vient d'échouer — d'où l'écart, assumé et
    // borné à ce seul signal (en-tête de `refusalLocale`).
    expect(page).toBe('fr');
    expect(refus).toBe(DEFAULT_LOCALE);
  });
});

describe('la feuille, hors du chemin de l’API', () => {
  it('lit les signaux sans jamais appeler l’API', async () => {
    poser({ headers: { [TENANT_SLUG_HEADER]: SLUG, 'accept-language': 'fr' } });
    const appel = vi.fn(() => Promise.reject(new Error('la feuille ne doit rien appeler')));
    vi.stubGlobal('fetch', appel);

    await expect(requestLocaleSignals()).resolves.toEqual({
      explicit: null,
      account: null,
      acceptLanguage: 'fr',
    });
    // C'est la propriété qui écarte l'interblocage : le client d'API peut
    // l'employer sans reboucler sur la résolution qui l'appelle.
    expect(appel).not.toHaveBeenCalled();
  });

  it('laisse le refus retomber sur la langue par défaut hors requête', async () => {
    requete.horsRequete = true;

    // Un script ou une tâche de fond n'a aucun signal à lire : une phrase en
    // anglais vaut mieux qu'une panne de plus par-dessus celle qu'on rapporte.
    await expect(langueDuRefus()).resolves.toBe(DEFAULT_LOCALE);

    // La page, elle, n'existe pas hors requête : rien n'y rattrape l'absence de
    // contexte, et c'est le seul point où les deux lecteurs diffèrent d'intention.
    await expect(langueDeLaPage()).rejects.toThrow();
  });
});
