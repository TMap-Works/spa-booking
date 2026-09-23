import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Service } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Les en-têtes du tableau du catalogue — #776.
 *
 * L'audit de conception (`ds:libelles`) a relevé deux colonnes muettes sur huit :
 * « Tampons » coiffait « 10 / 15 min » sans dire lequel des deux nombres précède
 * le soin, et « Agenda » coiffait « 1 h 25 » sans dire qu'il s'agit du temps
 * bloqué. La précision « avant et après le soin » existait, mais en
 * `spa-visually-hidden` : réservée aux lecteurs d'écran, quand c'est d'ordinaire
 * l'inverse.
 *
 * Ce que cette suite tient, et que ni le typage ni la revue ne tiennent :
 *
 * 1. **les deux libellés sont ceux-là**, et non ceux d'avant — une chaîne n'a pas
 *    de type, et rien n'empêcherait de revenir à « Tampons » demain ;
 * 2. **l'en-tête coiffe la bonne colonne**. C'est le cœur du ticket : un libellé
 *    juste au-dessus de la mauvaise colonne dirait l'ordre inverse de celui que
 *    les valeurs portent, ce qui est pire que se taire. L'assertion compare donc
 *    des **indices**, pas des textes voisins ;
 * 3. **plus rien n'est réservé aux seuls lecteurs d'écran** dans ces cellules :
 *    l'information est passée dans l'en-tête, qui se restitue avec la cellule par
 *    `scope="col"` et se lit aussi à l'œil ;
 * 4. **les mots viennent des écrans voisins**, et la suite le vérifie au
 *    **catalogue de messages** depuis que le module est bilingue (#849) :
 *    « Tampon avant / après » est le vocabulaire du formulaire de prestation,
 *    « Durée bloquée » celui de la fiche — « Bloque 1 h 25 sur l'agenda, tampons
 *    compris. » Trois écrans qui nomment le même temps de trois façons, c'est
 *    l'écart `ds:coherence` que ce ticket referme, pas un qu'il rouvre.
 */

const fetchServices = vi.fn();
const fetchOwnProfile = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : la page
// importe aussi `ApiClientError` par sa cascade d'erreurs.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchServices: (...args: unknown[]) => fetchServices(...args),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/catalogue',
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-de-session-du-comptoir'),
  adminLoadFailure: () => null,
}));

import CatalogPage from '@/app/(admin)/[tenantSlug]/admin/catalogue/(liste)/page';

const SLUG = 'salon-lotus';

/** Racine des catalogues de messages, où vivent les libellés depuis #849. */
const messagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'messages');

/**
 * Les chiffres sont ceux de la capture de l'audit : 10 et 15 minutes de tampons
 * autour d'un soin d'une heure, soit « 1 h 25 » bloquées. Ils sont **distincts**
 * à dessein — deux tampons égaux laisseraient passer une colonne qui inverse
 * l'ordre annoncé.
 */
function prestation(overrides: Partial<Service> = {}): Service {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
    occupiedMinutes: 85,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    assignedStaffCount: 1,
    activeAssignedStaffCount: 1,
    ...overrides,
  };
}

async function ouvrirLeCatalogue() {
  return CatalogPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({}),
  });
}

/**
 * La valeur rendue sous l'en-tête nommé, retrouvée par son **indice de colonne**.
 *
 * Une seule prestation est rendue : les cellules du document sont donc celles de
 * sa ligne, et leur rang est celui des en-têtes. C'est ce rang qui fait la preuve
 * — chercher « 10 / 15 min » n'importe où dans le tableau dirait seulement que la
 * valeur existe, pas qu'elle est sous le bon titre.
 */
function valeurSousLEnTete(nom: string): string {
  const colonne = screen
    .getAllByRole('columnheader')
    .findIndex((entete) => entete.textContent?.trim() === nom);

  expect(colonne).toBeGreaterThanOrEqual(0);

  return screen.getAllByRole('cell')[colonne]?.textContent?.trim() ?? '';
}

beforeEach(() => {
  fetchOwnProfile.mockResolvedValue({ id: 'compte-1', role: 'manager' });
  fetchServices.mockResolvedValue([prestation()]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('catalogue — chaque en-tête dit ce que sa colonne mesure', () => {
  it('nomme les deux tampons, dans l’ordre où ils sont rendus', async () => {
    render(await ouvrirLeCatalogue());

    expect(screen.getByRole('columnheader', { name: 'Tampons avant / après' })).toBeTruthy();
    // Le libellé d'avant ne coiffe plus rien : il laissait choisir entre « 10
    // avant » et « 10 après », une fois sur deux à tort.
    expect(screen.queryByRole('columnheader', { name: 'Tampons' })).toBeNull();
    expect(valeurSousLEnTete('Tampons avant / après')).toBe('10 / 15 min');
  });

  it('nomme la durée bloquée là où « Agenda » pouvait annoncer une date', async () => {
    render(await ouvrirLeCatalogue());

    expect(screen.getByRole('columnheader', { name: 'Durée bloquée' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Agenda' })).toBeNull();
    // 60 min de soin et 25 min de tampons : c'est le temps que la fiche annonce
    // bloqué, et non la durée du soin, que la colonne voisine porte déjà.
    expect(valeurSousLEnTete('Durée bloquée')).toBe('1 h 25');
    expect(valeurSousLEnTete('Durée')).toBe('1 h');
  });

  it('ne réserve plus la précision aux seuls lecteurs d’écran', async () => {
    render(await ouvrirLeCatalogue());

    // La cellule ne porte plus que sa valeur : la mention est passée dans
    // l'en-tête, que `scope="col"` restitue avec elle — et que l'œil lit aussi.
    expect(screen.queryByText(/avant et après le soin/)).toBeNull();
  });
});

/**
 * Les mots ne sont plus lus **à la source** mais **au catalogue de messages**,
 * depuis que le module est bilingue (#849).
 *
 * L'ancrage est le même — le libellé d'une colonne doit rester celui du champ
 * qu'il coiffe et de la phrase de la fiche —, mais les deux vivent désormais dans
 * `messages/<langue>/admin-catalog.json` et non plus en clair dans le JSX. Lire
 * le catalogue est même un ancrage **plus** fort : le test de parité garantit que
 * les deux langues portent les mêmes clés, si bien qu'un renommage en français
 * sans son pendant anglais échoue de toute façon.
 */
describe('catalogue — les en-têtes reprennent le vocabulaire des écrans voisins', () => {
  interface CatalogWords {
    list: { columns: { buffers: string; occupied: string } };
    form: { bufferBefore: string; bufferAfter: string };
    service: { occupiedHint: string };
  }

  const wordsOf = (locale: string): CatalogWords =>
    JSON.parse(
      readFileSync(path.join(messagesDir, locale, 'admin-catalog.json'), 'utf8'),
    ) as CatalogWords;

  /*
   * Les **deux** langues, et pas seulement celle des suites : la parité des clés
   * n'empêche pas l'anglais de renommer « Buffer before » sans renommer sa
   * colonne, et l'écart de vocabulaire que ce fichier existe pour interdire est
   * alors rouvert d'un seul côté.
   */
  const expected = {
    fr: {
      bufferBefore: 'Tampon avant (minutes)',
      bufferAfter: 'Tampon après (minutes)',
      buffers: 'Tampons avant / après',
      occupied: 'Durée bloquée',
      occupiedHint: /^Bloque .* sur l’agenda, tampons compris\.$/,
    },
    en: {
      bufferBefore: 'Buffer before (minutes)',
      bufferAfter: 'Buffer after (minutes)',
      buffers: 'Buffers before / after',
      occupied: 'Time blocked',
      occupiedHint: /^Blocks .* on the agenda, buffers included\.$/,
    },
  } as const;

  for (const [locale, attendu] of Object.entries(expected)) {
    describe(`en ${locale}`, () => {
      const words = wordsOf(locale);

      it('« Tampons avant / après » est celui du formulaire de prestation', () => {
        // Le jour où le formulaire renomme ses deux champs, cette assertion échoue —
        // et c'est exactement le jour où la colonne doit être renommée avec eux.
        expect(words.form.bufferBefore).toBe(attendu.bufferBefore);
        expect(words.form.bufferAfter).toBe(attendu.bufferAfter);
        expect(words.list.columns.buffers).toBe(attendu.buffers);
      });

      it('« Durée bloquée » est ce que la fiche écrit en toutes lettres', () => {
        expect(words.service.occupiedHint).toMatch(attendu.occupiedHint);
        expect(words.list.columns.occupied).toBe(attendu.occupied);
      });
    });
  }
});
