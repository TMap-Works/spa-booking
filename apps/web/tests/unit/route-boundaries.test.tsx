import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountLoading from '@/app/(account)/[tenantSlug]/compte/(liste)/loading';
import AccountError from '@/app/(account)/[tenantSlug]/compte/error';
import AccountShellError from '@/app/(account)/[tenantSlug]/error';
import AdminLoading from '@/app/(admin)/[tenantSlug]/admin/clients/loading';
import AdminError from '@/app/(admin)/[tenantSlug]/admin/error';
import VitrineError from '@/app/(booking)/[tenantSlug]/(vitrine)/error';
import VitrineLayout from '@/app/(booking)/[tenantSlug]/(vitrine)/layout';
import VitrineLoading from '@/app/(booking)/[tenantSlug]/(vitrine)/loading';
import BookingError from '@/app/(booking)/[tenantSlug]/reservation/error';
import BookingLoading from '@/app/(booking)/[tenantSlug]/reservation/loading';
import { ApiClientError } from '@/lib/api-client';

import { tenant } from './fixtures';

/*
 * Les frontières de chargement et d'erreur des quatre espaces (#830).
 *
 * Le constat de l'issue tenait en une commande : `find apps/web/app -name
 * loading.tsx` ne rendait rien. Les imports ci-dessus sont la première garde —
 * un fichier retiré fait échouer la suite avant tout test.
 *
 * Ce que la suite protège ensuite :
 *
 * - **un squelette dit qu'il charge** — `aria-busy`, une phrase masquée, la
 *   barre de progression —, et ne montre aucune donnée inventée ;
 * - **une panne laisse une reprise**, qui redemande la route au serveur avant de
 *   rejouer le rendu, et **une issue** là où l'espace n'a pas de chrome pour la
 *   porter ;
 * - **la vitrine répond toujours 404** pour un salon inconnu : son layout le
 *   décide avant que le squelette parte ;
 * - **aucun squelette n'enveloppe une page qui lève `notFound()`** : il partirait
 *   avec l'en-tête de réponse, et la page répondrait 200 au lieu du 404 que les
 *   fiches du back-office et le report d'un rendez-vous revendiquent. C'est ce
 *   que la revue de #830 a relevé sur la première version, qui posait une
 *   frontière sur tout `admin/` et tout `compte/` ;
 * - **chaque écran du back-office sans fiche a son squelette**, puisqu'il n'y a
 *   plus de frontière commune pour les couvrir.
 */

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

/** Les fichiers `name` sous `dir`, en chemins relatifs à `app/`, séparés par `/`. */
function findFiles(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(full, name));
    } else if (entry.name === name) {
      found.push(path.relative(appDir, full).split(path.sep).join('/'));
    }
  }
  return found;
}

/** Le source privé de ses commentaires : ils citent `notFound()` pour l'expliquer. */
function codeOf(relative: string): string {
  return readFileSync(path.join(appDir, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Les pages dont le 404 est décidé **au-dessus** du squelette, par leur layout :
 * leur propre `notFound()` ne sert plus qu'au rendu, l'en-tête est déjà parti en
 * 404 quand il le faut. Chacune est vérifiée plus bas — son layout lève bien.
 */
const DECIDED_BY_LAYOUT: Readonly<Record<string, string>> = {
  '(booking)/[tenantSlug]/(vitrine)/page.tsx': '(booking)/[tenantSlug]/(vitrine)/layout.tsx',
  '(booking)/[tenantSlug]/reservation/page.tsx': '(booking)/[tenantSlug]/reservation/layout.tsx',
};

/** Les dossiers de `app/` qui enveloppent `page` — le sien compris. */
function enclosingDirs(page: string): string[] {
  const parts = page.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

describe('frontières de chargement — le 404 part avant le squelette', () => {
  const loadings = new Set(findFiles(appDir, 'loading.tsx').map((file) => path.posix.dirname(file)));
  const pagesWithNotFound = findFiles(appDir, 'page.tsx').filter((page) =>
    /\bnotFound\(\)/.test(codeOf(page)),
  );

  it('trouve les pages qui lèvent notFound(), fiches comprises', () => {
    // Le garde-fou n'a de valeur que s'il voit les pages qu'il protège.
    expect(pagesWithNotFound).toEqual(
      expect.arrayContaining([
        '(admin)/[tenantSlug]/admin/catalogue/[serviceId]/page.tsx',
        '(admin)/[tenantSlug]/admin/catalogue/rubriques/[categoryId]/page.tsx',
        '(admin)/[tenantSlug]/admin/personnel/[staffId]/page.tsx',
        '(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/report/page.tsx',
      ]),
    );
  });

  it('ne pose aucun loading.tsx au-dessus d’une page qui lève notFound()', () => {
    for (const page of pagesWithNotFound) {
      if (page in DECIDED_BY_LAYOUT) {
        continue;
      }

      const wrapping = enclosingDirs(page).filter((dir) => loadings.has(dir));
      expect(wrapping, `${page} est enveloppée par ${wrapping.join(', ')}/loading.tsx`).toEqual([]);
    }
  });

  it.each(Object.entries(DECIDED_BY_LAYOUT))(
    '%s : son layout décide le 404 avant le squelette',
    (_, layout) => {
      expect(/\bnotFound\(\)/.test(codeOf(layout))).toBe(true);
    },
  );

  it.each([
    'calendrier',
    'clients',
    'encaissement',
    'reporting',
    'reglages',
    'catalogue/(liste)',
    'catalogue/nouveau',
    // Sous `(liste)/` depuis #769 : l'écran d'une rubrique lève `notFound()`, et
    // un squelette posé sur `catalogue/rubriques` l'envelopperait — l'en-tête de
    // réponse partirait en 200 avant que la page ne décide du 404.
    'catalogue/rubriques/(liste)',
    'catalogue/apercu',
    'personnel/(liste)',
  ])('le back-office a un squelette pour %s', (screenDir) => {
    const dir = `(admin)/[tenantSlug]/admin/${screenDir}`;
    expect(existsSync(path.join(appDir, dir, 'page.tsx'))).toBe(true);
    expect(loadings.has(dir)).toBe(true);
  });
});

const refresh = vi.fn();
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const fetchPublicTenant = vi.fn();
const fetchPublicServices = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  useParams: () => ({ tenantSlug: 'maison-lotus' }),
  usePathname: () => '/maison-lotus',
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
}));

// Le gabarit du salon (#1045) lit le cookie de présence : hors requête, aucune
// cliente n'est connectée.
vi.mock('@/lib/account-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-presence')>()),
  readAccountPresence: async () => null,
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  notFound.mockClear();
  fetchPublicTenant.mockReset();
  fetchPublicServices.mockReset();
});

const LOADINGS: readonly (readonly [string, ComponentType, string])[] = [
  ['le back-office', AdminLoading, 'Chargement de l’écran…'],
  ['l’espace client', AccountLoading, 'Chargement de votre espace…'],
  ['la vitrine', VitrineLoading, 'Chargement de la page du salon…'],
  ['le tunnel', BookingLoading, 'Chargement de votre réservation…'],
];

describe.each(LOADINGS)('squelette — %s', (_, Loading, message) => {
  it('se déclare occupé et le dit aux lecteurs d’écran', () => {
    const { container } = render(<Loading />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(message).classList.contains('spa-visually-hidden')).toBe(true);
  });

  it('porte la barre de progression, qui prend le relais de celle du clic', () => {
    const { container } = render(<Loading />);

    expect(container.querySelector('.spa-progress')).not.toBeNull();
  });

  it('ne montre que des squelettes : ni lien, ni bouton, ni texte visible', () => {
    const { container } = render(<Loading />);

    expect(container.querySelector('a, button, input')).toBeNull();
    expect(container.querySelectorAll('.spa-skeleton').length).toBeGreaterThan(0);
    // Seule la phrase masquée porte du texte.
    const visibleText = [...container.querySelectorAll('*')]
      .filter((node) => node.children.length === 0 && !node.classList.contains('spa-visually-hidden'))
      .map((node) => node.textContent ?? '')
      .join('');
    expect(visibleText).toBe('');
  });

  it('ne pose aucun titre de niveau 1 — l’écran qui arrive a le sien', () => {
    render(<Loading />);

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});

type ErrorBoundary = ComponentType<{ error: Error; reset: () => void }>;

const ERRORS: readonly (readonly [string, ErrorBoundary, string])[] = [
  ['le back-office', AdminError, 'Cet écran n’a pas pu s’afficher'],
  ['l’espace client', AccountError, 'Cette page de votre compte n’a pas pu s’afficher'],
  ['le gabarit de l’espace client', AccountShellError, 'Votre espace n’a pas pu s’afficher'],
  ['la vitrine', VitrineError, 'La page du salon n’a pas pu être chargée'],
  ['le tunnel', BookingError, 'La page de réservation n’a pas pu être chargée'],
];

describe.each(ERRORS)('reprise — %s', (_, ErrorView, title) => {
  it('annonce la panne sans en répéter le message technique', () => {
    render(<ErrorView error={new Error('TypeError: x is undefined')} reset={vi.fn()} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(title)).not.toBeNull();
    expect(alert.textContent).not.toContain('undefined');
  });

  it('redemande la route au serveur, puis rejoue le rendu', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ErrorView error={new Error('panne')} reset={reset} />);

    await user.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    // L'ordre compte : `reset` seul rejouerait la réponse en échec que le
    // routeur a gardée en cache.
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0] ?? 0);
  });
});

describe('reprise — les issues', () => {
  it('nomme l’écran indisponible du back-office, dont le titre a disparu avec lui', () => {
    render(<AdminError error={new Error('panne')} reset={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Écran indisponible' })).not.toBeNull();
  });

  it('laisse la sortie vers l’espace client à l’en-tête que le layout pose au-dessus d’elle', async () => {
    // Depuis #1045, la frontière d'erreur se rend sous le gabarit du salon : elle
    // ne redouble plus l'accès au compte, que l'en-tête porte déjà.
    fetchPublicTenant.mockResolvedValue(tenant);
    fetchPublicServices.mockResolvedValue([]);

    render(
      await VitrineLayout({
        children: <VitrineError error={new Error('panne')} reset={vi.fn()} />,
        params: Promise.resolve({ tenantSlug: tenant.slug }),
      }),
    );

    const sortie = within(screen.getByRole('banner')).getByRole('link', { name: 'Se connecter' });
    expect(sortie.getAttribute('href')).toBe(`/${tenant.slug}/compte/connexion`);
    expect(screen.getAllByRole('link', { name: /Se connecter|Mon compte/ })).toHaveLength(1);
  });

  it('rend à l’espace client tombé avec son gabarit un titre et la vitrine pour issue', () => {
    render(<AccountShellError error={new Error('panne')} reset={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Mon compte' })).not.toBeNull();
    const sortie = screen.getByRole('link', { name: 'Voir toutes les prestations' });
    expect(sortie.getAttribute('href')).toBe('/maison-lotus');
  });
});

describe('vitrine — le 404 se décide avant le squelette', () => {
  async function renderLayout(): Promise<void> {
    render(
      await VitrineLayout({
        children: <p>Contenu de la vitrine</p>,
        params: Promise.resolve({ tenantSlug: tenant.slug }),
      }),
    );
  }

  it('rend la page d’un salon connu, sous l’en-tête du salon', async () => {
    fetchPublicTenant.mockResolvedValue(tenant);
    fetchPublicServices.mockResolvedValue([]);

    await renderLayout();

    expect(screen.getByText('Contenu de la vitrine')).not.toBeNull();
    expect(fetchPublicTenant).toHaveBeenCalledWith(tenant.slug);
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: new RegExp(tenant.name) }),
    ).not.toBeNull();
  });

  it('répond 404 pour un salon inconnu', async () => {
    fetchPublicTenant.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Établissement introuvable.', 404),
    );

    await expect(renderLayout()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('laisse une panne à la page, qui sait en rendre l’encart', async () => {
    fetchPublicTenant.mockRejectedValue(
      new ApiClientError('SERVICE_UNAVAILABLE', 'Service indisponible.', 503),
    );
    fetchPublicServices.mockRejectedValue(
      new ApiClientError('SERVICE_UNAVAILABLE', 'Service indisponible.', 503),
    );

    await renderLayout();

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByText('Contenu de la vitrine')).not.toBeNull();
  });
});
