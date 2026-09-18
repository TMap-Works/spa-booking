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

  it('annonce la rubrique créée par son nom, et offre d’ouvrir son écran (#998)', async () => {
    // L'audit `d20260917-2`, critère `ds:etats` : le formulaire se vidait sans un
    // mot, quand enregistrer une rubrique **existante** affichait « Rubrique
    // enregistrée ». Deux issues du même geste, deux traitements — et la seule
    // trace de la création était une ligne de plus dans un tableau qui passe sous
    // le pli dès la dixième rubrique.
    createServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    renderManager();

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Soins du visage');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    // Le bandeau **nomme** ce qui vient d'être créé : le formulaire est vide
    // juste après, et un « c'est fait » anonyme laisserait chercher dans la liste.
    expect(await screen.findByText('Rubrique « Soins du visage » créée')).toBeDefined();

    // Le geste suivant que l'audit demandait — c'est là que se corrige un slug
    // dérivé du nom qu'on ne voulait pas.
    expect(
      screen.getByRole('link', { name: 'Ouvrir la rubrique' }).getAttribute('href'),
    ).toBe(`/salon-des-lilas/admin/catalogue/rubriques/${VISAGE}`);

    // Et le formulaire est bien reparti à vide : le bandeau n'est pas un
    // succédané de la réinitialisation, il s'y ajoute.
    expect((screen.getByLabelText(/Nom de la rubrique/) as HTMLInputElement).value).toBe('');
  });

  it('écrit l’annonce dans une région montée d’avance, et dans le même nœud (#998)', async () => {
    // WCAG 2.2 AA, 4.1.3 « Messages d'état ». Une région `aria-live` insérée
    // **avec** son message n'est annoncée par aucun lecteur d'écran de façon
    // fiable : l'annonce se déclenche sur la mutation d'une région déjà suivie.
    // C'est donc l'identité du nœud qui se vérifie, pas la présence d'un texte.
    createServiceCategoryAction.mockResolvedValue({ ok: true, data: visage });
    const user = userEvent.setup();
    const { container } = render(
      <CategoryManager tenantSlug="salon-des-lilas" categories={categories} />,
    );

    const region = container.querySelector<HTMLElement>('[aria-live="polite"]');

    // Avant tout geste : montée, vide, hors du flux — une région qui
    // consommerait la gouttière de `.spa-admin__section` poserait du blanc
    // au-dessus du premier champ, sur tous les écrans, pour ne rien dire.
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');
    expect(region?.className).toContain('spa-visually-hidden');
    // Le titre lu seul perdrait le nom de la rubrique.
    expect(region?.getAttribute('aria-atomic')).toBe('true');

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Soins du visage');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    const banniere = await screen.findByText('Rubrique « Soins du visage » créée');

    // Le même nœud qu'avant le geste — c'est ce qui rend la mutation annonçable.
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.contains(banniere)).toBe(true);
    expect(region?.className ?? '').not.toContain('spa-visually-hidden');
  });

  it('laisse l’échec hors de la région polie — il interrompt, il n’attend pas (#998)', async () => {
    // `Notification` rend le ton `danger` en `role="alert"`, assertif par nature.
    // L'enfermer dans une région `aria-live="polite"` reviendrait à le faire
    // attendre une pause du lecteur d'écran.
    createServiceCategoryAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL',
      message: 'Le service est indisponible.',
    });
    const user = userEvent.setup();
    const { container } = render(
      <CategoryManager tenantSlug="salon-des-lilas" categories={categories} />,
    );

    await user.type(screen.getByLabelText(/Nom de la rubrique/), 'Massages');
    await user.click(screen.getByRole('button', { name: /Créer la rubrique/ }));

    const alerte = await screen.findByRole('alert');
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]');

    expect(alerte.textContent).toContain('Le service est indisponible.');
    expect(region?.contains(alerte)).toBe(false);
    // Et la région reste vide : un échec n'annonce aucun succès.
    expect(region?.textContent).toBe('');
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

/**
 * L'ordre de tabulation de l'écran — audit `d20260916-1`, critère `ds:a11y` (#770).
 *
 * WCAG 2.2 AA, 2.4.3 « Ordre de focus » : quand un contrôle révèle du contenu,
 * la tabulation suivante doit entrer dans ce qui vient d'apparaître. La liste
 * des rubriques y manquait, et d'une façon coûteuse : le bouton « Modifier »
 * dépliait le formulaire dans la **première** cellule de la ligne, donc avant
 * son déclencheur dans l'ordre du document. Le focus restait sur le bouton, une
 * seule frappe Tab le portait sur « Désactiver » — l'action destructive de cette
 * même rubrique —, et les quatre champs du formulaire comme son « Enregistrer »
 * étaient entièrement sautés. Un opérateur au clavier était à un Entrée de
 * désactiver la rubrique qu'il voulait renommer.
 *
 * #769 a refermé l'écart plus fort que la direction proposée au ticket (« une
 * ligne de détail sous la ligne ») : il n'y a plus de contenu révélé du tout,
 * le formulaire vit sur `rubriques/{id}`. Ce qui restait dû, c'est la
 * **serrure** — sans elle, rien n'empêche une reprise de rouvrir un formulaire
 * dans une cellule. Ces trois tests parcourent l'écran à la tabulation et en
 * figent la séquence ; ils ne relisent pas le balisage, ils déplacent le focus.
 */
describe('rubriques — ordre de tabulation (#770, WCAG 2.2 AA 2.4.3)', () => {
  /** Ce sur quoi le focus se pose, tabulation après tabulation, dans l'ordre. */
  async function suitLaTabulation(
    user: ReturnType<typeof userEvent.setup>,
    attendu: readonly Element[],
  ): Promise<void> {
    for (const cible of attendu) {
      await user.tab();
      expect(document.activeElement).toBe(cible);
    }
  }

  it('déroule la liste dans l’ordre du document — le formulaire, puis chaque ligne par son nom', async () => {
    const user = userEvent.setup();
    renderManager();

    const visageRow = screen.getByRole('row', { name: /Soins du visage/ });
    const coiffureRow = screen.getByRole('row', { name: /Coiffure/ });

    // Aucun saut, aucun retour en arrière : la séquence suit ce qui est lu.
    await suitLaTabulation(user, [
      screen.getByLabelText(/Nom de la rubrique/),
      screen.getByLabelText(/Description/),
      screen.getByLabelText(/Adresse publique/),
      screen.getByRole('button', { name: /Créer la rubrique/ }),
      within(visageRow).getByRole('link', { name: 'Soins du visage' }),
      within(visageRow).getByRole('button', { name: /Désactiver/ }),
      within(coiffureRow).getByRole('link', { name: 'Coiffure' }),
      within(coiffureRow).getByRole('button', { name: /Réactiver/ }),
    ]);
  });

  it('entre chaque ligne par le nom de la rubrique, jamais par son action destructive', () => {
    renderManager();

    const table = screen.getByRole('table');

    // Un champ de saisie dans le tableau, c'est le formulaire revenu dans la
    // cellule — et avec lui l'ordre de focus que ce ticket a fait fermer.
    expect(table.querySelectorAll('input, textarea, select')).toHaveLength(0);

    for (const { name } of categories) {
      // Le nom se cherche en correspondance exacte, et la ligne se déduit de
      // lui : une rubrique dont le nom en contient un autre ne doit pas faire
      // échouer ce test sur une ambiguïté qui n'est pas la régression visée.
      const lien = within(table).getByRole('link', { name });
      const tabulables = Array.from(
        lien.closest('tr')?.querySelectorAll('a[href], button, input, textarea, select') ?? [],
      );

      // Deux contrôles par ligne, et le premier est le nom : c'est par lui qu'on
      // ouvre la rubrique, pas par la bascule qui la retire du catalogue.
      expect(tabulables).toHaveLength(2);
      expect(tabulables[0]).toBe(lien);
      expect(tabulables[1]?.textContent).toContain(name);
    }
  });

  it('déroule le formulaire d’une rubrique dans l’ordre annoncé, jusqu’à « Enregistrer »', async () => {
    // Les quatre contrôles que la tabulation sautait sont désormais traversés
    // dans l'ordre où ils se lisent. C'est le formulaire seul qui est monté ici,
    // tel que `rubriques/[categoryId]/page.tsx` le rend : la page le fait
    // précéder du lien « Retour aux rubriques » de sa barre d'outils, et ne pose
    // aucune action destructive à ses côtés.
    const user = userEvent.setup();
    render(<CategoryForm tenantSlug="salon-des-lilas" category={visage} />);

    await suitLaTabulation(user, [
      screen.getByLabelText(/Nom de la rubrique/),
      screen.getByLabelText(/Description/),
      screen.getByLabelText(/Adresse publique/),
      screen.getByRole('button', { name: /^Enregistrer$/ }),
    ]);
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
