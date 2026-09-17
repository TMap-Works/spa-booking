import type { ServiceCategory } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CategoryForm,
  CategoryManager,
} from '@/app/(admin)/[tenantSlug]/admin/components/category-manager';

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

/** Nommée : l'écran d'une rubrique la reçoit seule, et un accès par indice la rendrait `| undefined`. */
const visage: ServiceCategory = {
  id: VISAGE,
  slug: 'soins-du-visage',
  name: 'Soins du visage',
  description: 'Nettoyage, gommage.',
  isActive: true,
};

const coiffure: ServiceCategory = {
  id: COIFFURE,
  slug: 'coiffure',
  name: 'Coiffure',
  description: null,
  isActive: false,
};

const categories: ServiceCategory[] = [visage, coiffure];

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

  it('ouvre la rubrique par son nom, comme la liste des prestations (#769)', () => {
    // L'écart `ds:coherence` de l'audit `d20260916-1` : les deux listes du module
    // catalogue ouvrent le même type d'objet, et l'une le faisait dans la cellule
    // du tableau quand l'autre le fait sur un écran.
    renderManager();

    const lien = within(screen.getByRole('row', { name: /Soins du visage/ })).getByRole('link', {
      name: 'Soins du visage',
    });

    expect(lien.getAttribute('href')).toBe(
      `/salon-des-lilas/admin/catalogue/rubriques/${VISAGE}`,
    );
  });

  it('laisse le tableau au rôle de tableau — aucun formulaire déplié dans une ligne', () => {
    // Le bouton « Modifier » dépliait le formulaire complet dans la première
    // cellule : la ligne passait à quelque 370 px de haut, le nom s'y affichait
    // deux fois, et « Enregistrer » entrait en concurrence avec « Créer la
    // rubrique » sans rien qui les distingue.
    renderManager();

    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Fermer/ })).toBeNull();
    // Un seul champ « Nom » à l'écran, et c'est celui de la création.
    expect(screen.getAllByLabelText(/Nom de la rubrique/)).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: /^Enregistrer/ })).toHaveLength(0);
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
    createServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    renderManager();

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Massages');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    expect(createServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', {
      name: 'Massages',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('rend « Créer la rubrique » comme « Créer la prestation » — pleine largeur d’une carte bornée (#634)', () => {
    // La campagne de QA a relevé 164 px ici contre 966 px sur /catalogue/nouveau,
    // à 1280 px de fenêtre. Deux rendus pour un même rôle, à un clic de distance.
    //
    // Les deux classes tiennent ensemble et se vérifient ensemble : `block` sans
    // la borne rendrait un bouton de toute la zone de contenu — plus large que
    // celui de l'écran voisin, donc toujours pas le même rendu.
    renderManager();

    const form = screen.getByRole('button', { name: /Créer la rubrique/ }).closest('form');

    expect(form?.className).toContain('spa-admin-form');
    expect(screen.getByRole('button', { name: /Créer la rubrique/ }).className).toContain(
      'spa-button--block',
    );
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

describe('rubriques — l’écran d’une rubrique (#769)', () => {
  /** Le formulaire tel que le rend `rubriques/{categoryId}/page.tsx`. */
  function renderScreen(canManage = true): void {
    render(
      <CategoryForm tenantSlug="salon-des-lilas" category={visage} canManage={canManage} />,
    );
  }

  it('envoie `null` — et non la chaîne vide — quand la description est effacée', async () => {
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    renderScreen();

    await user.clear(screen.getByLabelText(/Description/));
    await user.click(screen.getByRole('button', { name: /^Enregistrer$/ }));

    expect(updateServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', VISAGE, {
      name: 'Soins du visage',
      slug: 'soins-du-visage',
      description: null,
    });
  });

  it('dit que c’est enregistré, et redemande l’écran au serveur', async () => {
    // L'écran est rendu côté serveur : sans ce rafraîchissement, il
    // réafficherait les valeurs d'avant l'enregistrement.
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: /^Enregistrer$/ }));

    expect(await screen.findByText('Rubrique enregistrée')).toBeDefined();
    expect(refresh).toHaveBeenCalled();
  });

  it('retire le bandeau de succès dès qu’une saisie est refusée', async () => {
    // Une saisie refusée par le schéma n'appelle pas l'action : le bandeau du
    // précédent enregistrement resterait sinon au-dessus de l'erreur du champ,
    // et annoncerait comme enregistré un nom vide qui ne l'est pas.
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: /^Enregistrer$/ }));
    expect(await screen.findByText('Rubrique enregistrée')).toBeDefined();

    await user.clear(screen.getByLabelText(/Nom de la rubrique/));
    await user.click(screen.getByRole('button', { name: /^Enregistrer$/ }));

    expect(updateServiceCategoryAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Rubrique enregistrée')).toBeNull();
  });

  it('rend les champs inertes au rang praticien, et dit pourquoi (#619)', () => {
    // `PATCH /v1/service-categories/{id}` est `@AuthAtLeast('MANAGER')` : laisser
    // les champs vifs, c'était faire saisir puis rendre « Droits insuffisants ».
    renderScreen(false);

    expect(screen.getByLabelText(/Nom de la rubrique/).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText(/Adresse publique/).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Enregistrer$/ })).toBeNull();
    expect(screen.getByText(/réservée au rang gérant/i)).toBeDefined();
  });
});

describe('rubriques — activité', () => {
  it('bascule l’activité sans toucher au reste de la rubrique', async () => {
    // `PATCH` est partiel : n'envoyer que `isActive`, c'est ne pas réécrire le
    // nom avec la valeur qu'affichait la page — donc ne pas écraser ce qu'un
    // collègue vient de modifier.
    updateServiceCategoryAction.mockResolvedValue({ ok: true, data: coiffure });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole('button', { name: /Réactiver Coiffure/ }));

    expect(updateServiceCategoryAction).toHaveBeenCalledWith('salon-des-lilas', COIFFURE, {
      isActive: true,
    });
  });
});

describe('rubriques — ce que le rang praticien voit (#619)', () => {
  function renderReadOnly(): void {
    render(
      <CategoryManager tenantSlug="salon-des-lilas" categories={categories} canManage={false} />,
    );
  }

  it('garde la liste et retire la colonne « Actions »', () => {
    // Même geste que la liste du personnel : la colonne disparaît pour le rôle
    // qui ne peut rien en faire, plutôt que d'offrir des boutons qui rendraient
    // 403.
    renderReadOnly();

    expect(screen.getByRole('cell', { name: 'Soins du visage' })).toBeDefined();
    expect(screen.getByRole('cell', { name: 'Coiffure' })).toBeDefined();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Désactiver/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Réactiver/ })).toBeNull();
  });

  it('garde le nom cliquable — l’écran d’une rubrique se lit à ce rang', () => {
    // `GET /v1/service-categories` se lit dès le rang praticien, et l'écran rend
    // ses champs inertes plutôt que de disparaître : une praticienne a besoin de
    // lire la description et l'adresse publique de ce sous quoi elle travaille.
    renderReadOnly();

    expect(screen.getByRole('link', { name: 'Soins du visage' })).toBeDefined();
  });

  it('retire le formulaire de création et dit pourquoi', () => {
    renderReadOnly();

    expect(screen.queryByRole('heading', { name: 'Nouvelle rubrique' })).toBeNull();
    expect(screen.queryByLabelText(/Nom de la rubrique/)).toBeNull();
    expect(screen.getByText(/réservées au rang gérant/i)).toBeDefined();
  });
});
