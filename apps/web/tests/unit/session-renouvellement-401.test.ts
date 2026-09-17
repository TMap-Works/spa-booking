import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';
import { isRenewalReturn, RENEWAL_PARAM, renewalReturnTo } from '@/lib/session-refresh';

/**
 * Le 401 reçu **alors que le cookie d'accès est là** — #861.
 *
 * Le constat du ticket tient en deux lignes : le back-office renvoyait à la
 * connexion, et l'espace client partait vers `session/fin`, qui **révoque la
 * session en base**. Trois causes produisent pourtant ce 401 sans que la session
 * soit morte — secret de l'API changé au déploiement, horloge dérivée, rendu plus
 * long que la marge de trente secondes du cookie —, et toutes trois se réparent
 * par un renouvellement.
 *
 * Ce qui est tenu ici : le renouvellement passe **d'abord**, et **une seule
 * fois**. Le second refus mène à la connexion — c'est-à-dire au comportement
 * d'avant ce ticket, qui reste la bonne réponse quand la session est vraiment
 * morte.
 *
 * Les deux surfaces sont éprouvées dans un même fichier parce qu'elles tiennent
 * la même règle par deux chemins différents : une fonction pure côté back-office,
 * une garde qui lit les cookies côté espace client.
 */

const SLUG = 'maison-lotus';
const PLANNING = `/${SLUG}/admin/calendrier?vue=semaine`;
const COMPTE = `/${SLUG}/compte`;

describe('le marqueur de renouvellement', () => {
  it('pose le marqueur sur un chemin nu', () => {
    expect(renewalReturnTo(`/${SLUG}/compte`)).toBe(`/${SLUG}/compte?${RENEWAL_PARAM}=renouvelee`);
  });

  it('garde les paramètres de l’écran, qui sont sa position de travail', () => {
    // La vue et la date du planning sont dans l'URL (#458) : les perdre
    // déposerait l'opérateur sur la journée courante après un renouvellement.
    expect(renewalReturnTo(PLANNING)).toBe(
      `/${SLUG}/admin/calendrier?vue=semaine&${RENEWAL_PARAM}=renouvelee`,
    );
  });

  it('ne pose jamais deux fois le marqueur', () => {
    const once = renewalReturnTo(PLANNING);

    expect(renewalReturnTo(once)).toBe(once);
  });

  it('rend tel quel un chemin que la route de renouvellement refusera', () => {
    // `sitePath` refuse les destinations hors site ; c'est la route qui tranche,
    // pas ce calcul de chaîne.
    expect(renewalReturnTo('https://exemple.test/vol')).toBe('https://exemple.test/vol');
  });

  it('ne reconnaît que la valeur déclarée', () => {
    expect(isRenewalReturn('renouvelee')).toBe(true);
    expect(isRenewalReturn(['renouvelee', 'renouvelee'])).toBe(true);
    expect(isRenewalReturn(undefined)).toBe(false);
    expect(isRenewalReturn('1')).toBe(false);
    expect(isRenewalReturn('')).toBe(false);
  });
});

describe('le back-office — adminUnauthorizedPath', () => {
  it('part renouveler quand l’écran n’en revient pas encore', async () => {
    const { adminUnauthorizedPath } = await import('@/app/(admin)/[tenantSlug]/admin/guard');

    expect(adminUnauthorizedPath(SLUG, { returnTo: PLANNING, attempted: false })).toBe(
      `/${SLUG}/admin/session/refresh?next=${encodeURIComponent(
        `/${SLUG}/admin/calendrier?vue=semaine&${RENEWAL_PARAM}=renouvelee`,
      )}`,
    );
  });

  it('mène à la connexion quand le renouvellement a déjà eu lieu', async () => {
    const { adminUnauthorizedPath } = await import('@/app/(admin)/[tenantSlug]/admin/guard');

    // Et il le dit : un écran de connexion muet se lit « on m'a déconnecté »
    // sans qu'on sache pourquoi (#860).
    expect(adminUnauthorizedPath(SLUG, { returnTo: PLANNING, attempted: true })).toBe(
      `/${SLUG}/admin/connexion?motif=session-expiree`,
    );
  });

  it('garde la connexion sèche pour un écran qui ne dit rien de son renouvellement', async () => {
    const { adminUnauthorizedPath } = await import('@/app/(admin)/[tenantSlug]/admin/guard');

    // Sans `returnTo`, il n'y a nulle part où revenir : le comportement d'avant
    // #861 est la seule issue sûre, et elle ne boucle pas.
    expect(adminUnauthorizedPath(SLUG)).toBe(`/${SLUG}/admin/connexion`);
  });
});

/**
 * L'espace client, avec ses cookies : la garde lit le jeton, appelle, et décide
 * sur l'échec. Le magasin de cookies et `redirect()` sont donc doublés.
 */
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: vi.fn(),
    }),
}));

// `redirect()` lève dans Next : le double lève aussi, sans quoi la garde
// poursuivrait après une navigation qu'elle croit terminée.
vi.mock('next/navigation', () => ({
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

/** La destination d'un `redirect()` levé par la garde. */
async function destinationOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/^NEXT_REDIRECT:/);
    return message.slice('NEXT_REDIRECT:'.length);
  }

  throw new Error('la garde n’a pas redirigé');
}

const REFUSED = new ApiClientError('UNAUTHORIZED', 'Jeton invalide.', 401);

describe('l’espace client — readAccountData sur un 401', () => {
  const read = (): Promise<never> => Promise.reject(REFUSED);

  it('part renouveler au lieu de révoquer la session', async () => {
    jar.clear();
    jar.set('spa_account_access', 'jeton-d-acces');
    jar.set('spa_account_refresh', 'jeton-de-rafraichissement');
    const { readAccountData } = await import('@/app/(account)/[tenantSlug]/compte/session');

    const destination = await destinationOf(() => readAccountData(SLUG, COMPTE, read, false));

    // Et surtout : pas `session/fin`, qui aurait révoqué en base une session
    // encore parfaitement valide.
    expect(destination).toBe(
      `/${SLUG}/compte/session/refresh?next=${encodeURIComponent(
        `${COMPTE}?${RENEWAL_PARAM}=renouvelee`,
      )}`,
    );
    expect(destination).not.toContain('session/fin');
  });

  it('ferme la session quand le renouvellement a déjà eu lieu', async () => {
    jar.clear();
    jar.set('spa_account_access', 'jeton-d-acces-neuf');
    jar.set('spa_account_refresh', 'jeton-de-rafraichissement-neuf');
    const { readAccountData } = await import('@/app/(account)/[tenantSlug]/compte/session');

    const destination = await destinationOf(() => readAccountData(SLUG, COMPTE, read, true));

    expect(destination).toBe(`/${SLUG}/compte/session/fin?motif=session-expiree`);
  });

  it('ferme la session quand il n’y a plus rien à renouveler', async () => {
    jar.clear();
    jar.set('spa_account_access', 'jeton-d-acces');
    const { readAccountData } = await import('@/app/(account)/[tenantSlug]/compte/session');

    const destination = await destinationOf(() => readAccountData(SLUG, COMPTE, read, false));

    // `session/fin` et non la route de renouvellement : lui seul efface le
    // cookie d'accès resté seul.
    expect(destination).toBe(`/${SLUG}/compte/session/fin?motif=session-expiree`);
  });

  it('laisse passer ce qui n’est pas un 401', async () => {
    jar.clear();
    jar.set('spa_account_access', 'jeton-d-acces');
    jar.set('spa_account_refresh', 'jeton-de-rafraichissement');
    const { readAccountData } = await import('@/app/(account)/[tenantSlug]/compte/session');
    const panne = new ApiClientError('INTERNAL_ERROR', 'Erreur.', 500);

    await expect(
      readAccountData(SLUG, COMPTE, () => Promise.reject(panne), false),
    ).rejects.toBe(panne);
  });
});
