import type { ServiceCategory } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CategoryManager } from '@/app/(admin)/[tenantSlug]/admin/components/category-manager';

const createServiceCategoryAction = vi.fn();
const updateServiceCategoryAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceCategoryAction: (...args: unknown[]) => createServiceCategoryAction(...args),
  updateServiceCategoryAction: (...args: unknown[]) => updateServiceCategoryAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const VISAGE = '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60';
const COIFFURE = '0a5b1e6c-2222-4c53-8f0e-1b2c3d4e5f60';

const categories: ServiceCategory[] = [
  {
    id: VISAGE,
    slug: 'soins-du-visage',
    name: 'Soins du visage',
    description: 'Nettoyage, gommage.',
    isActive: true,
  },
  { id: COIFFURE, slug: 'coiffure', name: 'Coiffure', description: null, isActive: false },
];

afterEach(() => {
  cleanup();
  createServiceCategoryAction.mockReset();
  updateServiceCategoryAction.mockReset();
  refresh.mockReset();
});

function renderManager(list: ServiceCategory[] = categories): void {
  render(<CategoryManager tenantSlug="salon-des-lilas" categories={list} />);
}

describe('rubriques — ce que l’écran montre', () => {
  it('garde les rubriques désactivées à l’écran, en écrivant leur état', () => {
    // C'est ici qu'on vient les remettre en ligne. Les masquer inviterait à en
    // recréer une du même nom — pour se heurter au conflit d'unicité du slug.
    renderManager();

    // Le nom se répète dans le nom accessible des boutons de la ligne : on vise
    // la cellule, et l'état est lu dans cette même ligne.
    const row = screen.getByRole('row', { name: /Coiffure/ });

    expect(within(row).getByRole('cell', { name: 'Coiffure' })).toBeDefined();
    expect(within(row).getByText('Désactivée')).toBeDefined();
    expect(
      within(screen.getByRole('row', { name: /Soins du visage/ })).getByText('Active'),
    ).toBeDefined();
  });

  it('explique un catalogue sans rubrique au lieu de laisser un vide', () => {
    renderManager([]);

    expect(screen.getByText('Aucune rubrique')).toBeDefined();
    expect(screen.getByText(/sans regroupement/i)).toBeDefined();
  });

  it('n’offre aucune suppression — une rubrique se désactive', () => {
    renderManager();

    expect(screen.queryByRole('button', { name: /Supprimer/i })).toBeNull();
  });
});

describe('rubriques — création', () => {
  it('laisse le serveur dériver le slug quand il n’est pas saisi', async () => {
    createServiceCategoryAction.mockResolvedValue({ ok: true, data: categories[0] });
    const user = userEvent.setup();
    renderManager();

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Massages');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    expect(createServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', {
      name: 'Massages',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('pose le conflit de slug sur le champ d’adresse', async () => {
    createServiceCategoryAction.mockResolvedValue({
      ok: false,
      code: 'CONFLICT',
      message: 'Une rubrique de cet établissement porte déjà ce slug.',
    });
    const user = userEvent.setup();
    renderManager();

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Massages');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    const message = await screen.findByText(/porte déjà cette adresse/i);
    const slug = screen.getAllByLabelText(/Adresse publique/)[0];

    expect(slug?.getAttribute('aria-describedby')).toContain(message.id);
  });
});

describe('rubriques — modification et activité', () => {
  it('n’ouvre l’édition que sur demande, et une seule à la fois', async () => {
    const user = userEvent.setup();
    renderManager();

    // Au repos, seul le formulaire de création porte un champ « Nom ».
    expect(screen.getAllByLabelText(/Nom de la rubrique/)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Modifier Soins du visage/ }));
    expect(screen.getAllByLabelText(/Nom de la rubrique/)).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /Modifier Coiffure/ }));
    // Deux formulaires ouverts sur la même liste inviteraient à en enregistrer
    // un et à perdre l'autre sans le voir.
    expect(screen.getAllByLabelText(/Nom de la rubrique/)).toHaveLength(2);
  });

  it('envoie `null` — et non la chaîne vide — quand la description est effacée', async () => {
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: categories[0] });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole('button', { name: /Modifier Soins du visage/ }));
    const row = screen.getByRole('row', { name: /Soins du visage/ });
    await user.clear(within(row).getByLabelText(/Description/));
    await user.click(within(row).getByRole('button', { name: /^Enregistrer$/ }));

    expect(updateServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', VISAGE, {
      name: 'Soins du visage',
      slug: 'soins-du-visage',
      description: null,
    });
  });

  it('bascule l’activité sans toucher au reste de la rubrique', async () => {
    // `PATCH` est partiel : n'envoyer que `isActive`, c'est ne pas réécrire le
    // nom avec la valeur qu'affichait la page — donc ne pas écraser ce qu'un
    // collègue vient de modifier.
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: categories[1] });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole('button', { name: /Réactiver Coiffure/ }));

    expect(updateServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', COIFFURE, {
      isActive: true,
    });
  });
});
