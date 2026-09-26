import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, errorMessage } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fixerLangue,
  langueCourante,
  nextIntlMobile,
  nextIntlServerMobile,
} from '../support/langue-mobile';

/** Ce fichier, d'où part la racine d'`apps/web` lue par la garde de lint. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Les briques **transverses** du front dans les deux langues — #1234.
 *
 * ## Ce que la suite protège
 *
 * Six briques que tous les écrans traversent, et qui retombaient en français sur
 * un produit servi en anglais. Elles ne se ressemblent pas, et c'est justement
 * ce qui les rassemble ici : aucune n'appartient à un écran, et aucune n'aurait
 * donc été couverte par un ticket d'écran de l'épique #843.
 *
 * Deux d'entre elles **affichent** un libellé, et le lisent au catalogue :
 *
 * 1. le squelette des quinze écrans de chargement du back-office, dont la seule
 *    phrase est celle que le lecteur d'écran entend — `shell.admin.loading` ;
 * 2. les onglets du design system, dont la marque « contient votre choix » était
 *    une constante de module — `ui.tabs.marked`.
 *
 * Les quatre autres **produisent un refus**, et le disent par son code, à
 * travers `errorMessage(code, locale)` du contrat partagé :
 *
 * 3. `lib/api-client.ts`, pour les refus qu'il écrit lui-même — API injoignable,
 *    corps hors contrat, réponse hors contrat ;
 * 4. `admin/action-result.ts`, qui réémettait le message **brut** de l'API,
 *    c'est-à-dire du français, vers une quinzaine d'écrans du back-office ;
 * 5. `admin/actions.ts`, dont les refus de validation étaient des littéraux ;
 * 6. les deux replis d'écran — abonnement et inscription —, éprouvés dans leurs
 *    propres suites (`admin-billing-panel`, `signup-i18n`).
 *
 * ## Pourquoi une doublure de langue commutable
 *
 * L'amorce des suites fixe la langue à `fr` pour toutes
 * (`tests/support/next-intl.ts`). Ce ticket promet précisément le **changement**
 * de langue : la doublure lit les vrais catalogues du dépôt, langue par langue,
 * et `fixerLangue()` choisit laquelle avant chaque rendu — même doublure que
 * `shell-logout-i18n.test.tsx`, celle de `tests/support/langue-mobile.ts`
 * (#1287).
 *
 * `next/headers` est doublé pour la même raison : c'est là que `api-client` lit
 * la langue de la requête, et une suite sous jsdom n'a pas de requête. Le cookie
 * qu'il rend porte `langueCourante()`, et non une seconde variable : les deux
 * chemins de lecture de la langue ne peuvent donc pas diverger.
 */

const state = vi.hoisted(() => ({
  /** Ce que le navigateur annonce — le troisième signal de `i18n/resolve.ts`. */
  acceptLanguage: null as string | null,
  /** `true` pour rejouer l'absence de requête : `next/headers` lève alors. */
  horsRequete: false,
}));

vi.mock('next-intl', () => nextIntlMobile());

vi.mock('next-intl/server', () => nextIntlServerMobile());

vi.mock('next/headers', async () => {
  const { LOCALE_COOKIE } = await import('@/i18n/cookies');

  const refuserHorsRequete = (): void => {
    if (state.horsRequete) {
      // Le message de Next, au mot près : « cookies was called outside a request
      // scope ». Ce que le client d'API doit en faire est retomber sur la langue
      // par défaut, jamais laisser passer la panne.
      throw new Error('cookies was called outside a request scope');
    }
  };

  return {
    cookies: () => {
      refuserHorsRequete();

      return Promise.resolve({
        get: (name: string) =>
          name === LOCALE_COOKIE && state.acceptLanguage === null
            ? { name, value: langueCourante() }
            : undefined,
      });
    },
    headers: () => {
      refuserHorsRequete();

      return Promise.resolve({
        get: (name: string) =>
          name.toLowerCase() === 'accept-language' ? state.acceptLanguage : null,
      });
    },
  };
});

import { AdminScreenSkeleton } from '@/app/(admin)/[tenantSlug]/admin/components/admin-screen-skeleton';
import { expired, failure } from '@/app/(admin)/[tenantSlug]/admin/action-result';
import { Tabs, tabPanelProps } from '@/components/ui/tabs';
import { loadMessages, type MessageTree } from '@/i18n/messages';
import { ApiClientError, fetchPublicTenant } from '@/lib/api-client';

/** Les deux langues, dans l'ordre où la suite les éprouve. */
const LANGUES = ['fr', 'en'] as const;

beforeEach(() => {
  fixerLangue('fr');
  state.acceptLanguage = null;
  state.horsRequete = false;
});

afterEach(cleanup);

/**
 * Le message rangé à cette clé, ou l'échec de la clé manquante.
 *
 * Même outil que `shell-logout-i18n.test.tsx` : un catalogue est un arbre de
 * chaînes sans forme connue de `tsc`, et une clé déplacée doit nommer le chemin
 * fautif plutôt que de se lire `undefined`.
 */
function message(tree: MessageTree, chemin: string): string {
  let courant: MessageTree | string = tree;

  for (const segment of chemin.split('.')) {
    if (typeof courant === 'string') {
      throw new Error(`« ${chemin} » traverse un message, pas un groupe`);
    }

    const suivant: MessageTree | string | undefined = courant[segment];

    if (suivant === undefined) {
      throw new Error(`« ${chemin} » manque au catalogue`);
    }

    courant = suivant;
  }

  if (typeof courant !== 'string') {
    throw new Error(`« ${chemin} » désigne un groupe, pas un message`);
  }

  return courant;
}

describe('le squelette des écrans du back-office annonce le chargement dans la langue lue', () => {
  /** Les deux annonces attendues, telles que le catalogue les porte. */
  const ATTENDU = {
    fr: 'Chargement de l’écran…',
    en: 'Loading the screen…',
  } as const;

  it.each(LANGUES)('dit la phrase de « %s » au lecteur d’écran', (locale) => {
    fixerLangue(locale);
    const { container } = render(<AdminScreenSkeleton />);

    const annonce = container.querySelector('.spa-visually-hidden');

    expect(annonce?.textContent).toBe(ATTENDU[locale]);
    // L'annonce ne vaut que si la zone se déclare occupée : c'est le couple que
    // les technologies d'assistance lisent.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it.each(LANGUES)('la lit au namespace de la coquille — %s', (locale) => {
    expect(message(loadMessages(locale), 'shell.admin.loading')).toBe(ATTENDU[locale]);
  });
});

/** Une rangée d'onglets dont le dernier porte la marque, sans libellé précisé. */
function Categories({ markedLabel }: { readonly markedLabel?: string }) {
  const [value, setValue] = useState('massages');
  // `exactOptionalPropertyTypes` : passer `undefined` n'est pas la même chose
  // que ne pas passer la propriété, et c'est bien l'absence qu'on éprouve.
  const wording = markedLabel === undefined ? {} : { markedLabel };

  return (
    <>
      <Tabs
        label="Catégories"
        idPrefix="cat"
        value={value}
        onChange={setValue}
        {...wording}
        items={[
          { id: 'massages', label: 'Massages' },
          { id: 'corps', label: 'Corps', marked: true },
        ]}
      />
      <div {...tabPanelProps('cat', value)}>{value}</div>
    </>
  );
}

describe('la marque d’un onglet se dit dans la langue lue', () => {
  const ATTENDU = {
    fr: 'contient votre choix',
    en: 'contains your choice',
  } as const;

  it.each(LANGUES)('nomme la marque en « %s » quand l’appelant ne précise rien', (locale) => {
    fixerLangue(locale);
    render(<Categories />);

    expect(screen.getByRole('tab', { name: `Corps · ${ATTENDU[locale]}` })).toBeDefined();
  });

  it.each(LANGUES)('la lit au namespace du design system — %s', (locale) => {
    expect(message(loadMessages(locale), 'ui.tabs.marked')).toBe(ATTENDU[locale]);
  });

  it('laisse l’appelant nommer ce qui est retenu quand « choix » ne suffit pas', () => {
    fixerLangue('en');
    render(<Categories markedLabel="contains the service you picked" />);

    // La propriété reste la porte de sortie : c'est l'écran qui sait de quoi il
    // parle, et c'est à lui de la traduire dans son propre namespace.
    expect(
      screen.getByRole('tab', { name: 'Corps · contains the service you picked' }),
    ).toBeDefined();
  });
});

describe('le client d’API dit ses propres refus dans la langue de la requête', () => {
  /**
   * Une API injoignable — le seul refus que ce module écrit sans que l'API ait
   * répondu quoi que ce soit, et celui que la visiteuse rencontre le plus.
   */
  async function refusReseau(): Promise<ApiClientError> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    try {
      await fetchPublicTenant('maison-lotus');
    } catch (error) {
      return error as ApiClientError;
    }

    throw new Error('l’appel aurait dû être refusé');
  }

  it.each(LANGUES)('rend la phrase de SERVICE_UNAVAILABLE en « %s »', async (locale) => {
    fixerLangue(locale);

    const refus = await refusReseau();

    expect(refus).toBeInstanceOf(ApiClientError);
    expect(refus.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.SERVICE_UNAVAILABLE, locale));
    // La cause technique reste dans `details`, jamais dans la phrase (#601).
    expect(refus.details['cause']).toBe('ECONNREFUSED');
  });

  it('suit `Accept-Language` quand aucun cookie de langue n’a été posé', async () => {
    // Le troisième signal de l'ordre de résolution (`i18n/resolve.ts`) : une
    // variante régionale compte pour sa langue, `fr-CA` demande du français.
    state.acceptLanguage = 'fr-CA,fr;q=0.9,en;q=0.8';

    const refus = await refusReseau();

    expect(refus.message).toBe(errorMessage(ERROR_CODES.SERVICE_UNAVAILABLE, 'fr'));
  });

  it('retombe sur la langue par défaut hors de toute requête', async () => {
    // Un script, une tâche de fond, une suite de tests : il n'y a aucun signal
    // à lire, et `next/headers` lève. Une phrase en anglais vaut mieux qu'une
    // seconde panne par-dessus celle qu'on rapporte.
    fixerLangue('fr');
    state.horsRequete = true;

    const refus = await refusReseau();

    expect(refus.message).toBe(errorMessage(ERROR_CODES.SERVICE_UNAVAILABLE, 'en'));
  });

  it.each(LANGUES)('donne la phrase générique à un corps d’erreur hors contrat — %s', async (locale) => {
    fixerLangue(locale);
    // Un 502 d'un intermédiaire : ni `code`, ni `message`, rien que le HTML
    // d'une passerelle. Le client fabrique alors un `HTTP_502` que la table des
    // codes ne connaît pas — et c'est `INTERNAL_ERROR` qui parle.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502</html>', { status: 502 }),
    );

    await expect(fetchPublicTenant('maison-lotus')).rejects.toMatchObject({
      code: 'HTTP_502',
      message: errorMessage(ERROR_CODES.INTERNAL_ERROR, locale),
    });
  });
});

describe('les refus du back-office ne réémettent plus le message de l’API', () => {
  /**
   * Le cœur du second critère d'acceptation. `failure()` recopiait
   * `error.message`, c'est-à-dire la phrase d'une `DomainError` de l'API —
   * écrite une fois, en français, pour le journal et le diagnostic. Une
   * quinzaine d'écrans du back-office l'affichent tels quels.
   */
  it.each(LANGUES)('dit un refus nommé par sa phrase de « %s »', async (locale) => {
    fixerLangue(locale);

    const refus = await failure(
      new ApiClientError(
        ERROR_CODES.OVERLAPPING_SCHEDULE_RANGES,
        'Deux plages du même jour se chevauchent.',
        409,
        { day: 'MONDAY' },
      ),
    );

    expect(refus.code).toBe(ERROR_CODES.OVERLAPPING_SCHEDULE_RANGES);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.OVERLAPPING_SCHEDULE_RANGES, locale));
    // `details` traverse intact (#1210) : c'est lui qui sépare deux refus d'un
    // même code, et la phrase n'a jamais su le faire.
    expect(refus.details).toEqual({ day: 'MONDAY' });
  });

  it.each(LANGUES)('donne la phrase générique à un code inconnu — %s', async (locale) => {
    fixerLangue(locale);

    const refus = await failure(new ApiClientError('HTTP_418', 'Je suis une théière.', 418));

    expect(refus.message).toBe(errorMessage(ERROR_CODES.INTERNAL_ERROR, locale));
    expect(refus.message).not.toContain('théière');
  });

  it.each(LANGUES)('traite ce qui n’est pas un refus d’API comme INTERNAL_ERROR — %s', async (locale) => {
    fixerLangue(locale);

    const refus = await failure(new Error('une action serveur qui lève'));

    expect(refus.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.INTERNAL_ERROR, locale));
  });

  it.each(LANGUES)('dit la session perdue dans la langue lue — %s', async (locale) => {
    fixerLangue(locale);

    const refus = await expired();

    expect(refus.code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.UNAUTHORIZED, locale));
  });
});

describe('la règle de lint anti-texte-en-dur couvre les briques d’affichage', () => {
  /**
   * Sans cette garde, retirer la ligne d'un marqueur ne ferait échouer aucun
   * test : `eslint` passerait sans rien regarder, et le premier « Chargement de
   * l'écran… » réécrit en dur reviendrait sans un mot.
   */
  it('vise le squelette du back-office et tout le design system', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));

    expect(globs).toContain(
      'app/\\(admin\\)/\\[tenantSlug\\]/admin/components/admin-screen-skeleton.tsx',
    );
    // `components/ui/tabs.tsx` jusqu'à #1300, où le marqueur du design system a
    // cessé d'énumérer ses briques : il est vide, et couvre donc le sous-arbre
    // entier — les quinze briques qui ne portaient encore aucun texte comprises,
    // et celles qui naîtront après.
    expect(globs).toContain('components/ui/**/*.{ts,tsx}');
  });

  /**
   * Les deux derniers répertoires que l'audit de couverture de #1300 avait
   * trouvés hors de portée de la règle. Ils n'écrivent aucune phrase aujourd'hui,
   * et c'est justement pourquoi ils ont besoin d'une garde : rien d'autre ne
   * dirait qu'on vient de les découvrir.
   */
  it('vise le temps réel et le brancheur d’annonces du back-office', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));

    expect(globs).toContain('components/live/**/*.{ts,tsx}');
    expect(globs).toContain(
      'app/\\(admin\\)/\\[tenantSlug\\]/admin/components/admin-live-announcements.tsx',
    );
  });
});
