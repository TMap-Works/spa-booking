import { DISPLAY_NAME_MAX_LENGTH, type StaffMember } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffProfilePanel } from '@/app/(admin)/[tenantSlug]/admin/personnel/[staffId]/staff-profile-panel';

/**
 * Ce que le panneau de la fiche montre, et ce que son `PATCH` envoie (#705, #771).
 *
 * Depuis #771, la présentation **se relit** : `GET /v1/staff` la sert, et le
 * champ s'ouvre donc sur ce qui est publié sous le nom de la praticienne. C'est
 * ce qui change tout le reste de ce fichier — jusque-là le champ s'ouvrait vide
 * au-dessus d'un texte en ligne, et l'écran devait se souvenir qu'on y avait
 * touché pour savoir s'il fallait l'envoyer.
 *
 * Trois règles s'y jouent, qu'aucun test d'intégration ne peut tenir à leur
 * place —
 *
 * - le champ **montre le texte publié** : c'est la réparation même du ticket ;
 * - **ce qui part est ce qui a changé**, mesuré contre cette valeur publiée.
 *   Retaper le même texte n'envoie rien, et corriger le seul nom ne touche pas à
 *   la présentation ;
 * - un champ **vidé** envoie `null` et non `""` — le premier des deux constats
 *   laissés par la revue de #694.
 *
 * L'action serveur et le routeur sont des modules Next qui n'existent pas hors du
 * serveur : ce qu'on éprouve est le composant, pas le transport.
 */

const updateStaffMemberAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  updateStaffMemberAction: (...args: unknown[]) => updateStaffMemberAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  updateStaffMemberAction.mockReset();
  refresh.mockReset();
});

const LEA: StaffMember = {
  id: '22222222-2222-4222-8222-222222222222',
  displayName: 'Léa Praticienne',
  isActive: true,
};

/**
 * La même fiche, **avec** une présentation publiée.
 *
 * `bio` est absente de `LEA` plutôt que nulle : c'est la forme que le contrat
 * décrit et que l'API rend pour une fiche sans présentation. Les deux fiches
 * ensemble couvrent les deux états que l'écran doit savoir ouvrir.
 */
const CLAIRE: StaffMember = {
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Claire Fontaine',
  bio: 'Quinze ans de massage suédois.',
  isActive: true,
};

function renderPanel(member: StaffMember = LEA, canManage = true): void {
  render(<StaffProfilePanel canManage={canManage} member={member} tenantSlug="spa-lumiere" />);
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /Enregistrer la fiche/ });
}

describe('StaffProfilePanel — le corps ne porte que ce qui change', () => {
  it('n’a rien à enregistrer tant que rien n’a bougé', () => {
    renderPanel();

    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('n’envoie que le nom quand seul le nom a été corrigé', async () => {
    updateStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { ...LEA, displayName: 'Léa Rakoto' },
    });

    renderPanel();
    const name = screen.getByLabelText(/Nom d’affichage/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Léa Rakoto');
    await userEvent.click(saveButton());

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, {
      displayName: 'Léa Rakoto',
    });
    expect(screen.getByText(/Fiche enregistrée/)).toBeDefined();
    expect(refresh).toHaveBeenCalled();
  });

  it('ouvre le champ sur la présentation publiée', async () => {
    // La réparation même du ticket : jusqu'ici le champ s'ouvrait vide au-dessus
    // d'un texte déjà en ligne, et la gérante ne pouvait pas savoir ce qui était
    // publié sous le nom de sa praticienne.
    renderPanel(CLAIRE);

    expect(screen.getByLabelText(/Présentation/)).toHaveProperty(
      'value',
      'Quinze ans de massage suédois.',
    );
    // Rien n'a bougé : ouvrir la fiche n'est pas la modifier.
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('n’envoie pas `bio` quand la présentation n’a pas changé', async () => {
    // Le champ est prérempli : tout renvoyer à chaque correction de nom serait
    // une écriture de plus, et deux gérants qui corrigent l'un le nom, l'autre
    // la présentation, s'écraseraient l'un l'autre.
    updateStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { ...CLAIRE, displayName: 'Claire F.' },
    });

    renderPanel(CLAIRE);
    const name = screen.getByLabelText(/Nom d’affichage/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Claire F.');
    await userEvent.click(saveButton());

    const [, , body] = updateStaffMemberAction.mock.calls[0] as [string, string, object];
    expect(Object.hasOwn(body, 'bio')).toBe(false);
  });

  it('n’a rien à enregistrer quand le texte publié est retapé à l’identique', async () => {
    // Ce qu'un drapeau « ce champ a été touché » ne saurait pas voir : un
    // aller-retour dans le champ n'est pas une modification, et le bouton n'a
    // pas à s'allumer pour une écriture qui n'écrirait rien.
    renderPanel(CLAIRE);
    const bio = screen.getByLabelText(/Présentation/);
    await userEvent.clear(bio);
    await userEvent.type(bio, 'Quinze ans de massage suédois.');

    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('envoie `null` — et non une chaîne vide — pour effacer la présentation', async () => {
    // Le geste est devenu direct : on vide le champ qu'on lit, sans manœuvre ni
    // bouton dédié. Ce qui part reste `null` — le constat de la revue de #694 :
    // `PATCH { bio: "" }` écrirait une chaîne vide là où `NULL` veut dire « pas
    // de présentation ».
    // La fiche effacée, telle que l'API la rend : `bio` **absente**, et non nulle
    // ni vide — `staffMemberSchema` la déclare facultative.
    const effacee: StaffMember = {
      id: CLAIRE.id,
      displayName: CLAIRE.displayName,
      isActive: CLAIRE.isActive,
    };
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: effacee });

    renderPanel(CLAIRE);
    await userEvent.clear(screen.getByLabelText(/Présentation/));
    await userEvent.click(saveButton());

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', CLAIRE.id, { bio: null });
  });

  it('dit l’état réel de la présentation, sans parler de l’API à la gérante', async () => {
    // L'écart relevé par l'audit `d20260916-1` : l'aide expliquait une contrainte
    // du back-end (« L'API ne la relit pas… ») et prescrivait une manœuvre
    // inapplicable. Elle dit désormais ce qui est publié, en mots de salon.
    renderPanel(CLAIRE);
    expect(screen.getByText(/présentation enregistrée aujourd’hui/)).toBeDefined();
    expect(screen.queryByText(/API/)).toBeNull();
    // Et rien ne promet une page publique : aucune surface publique ne rend
    // `bio` aujourd'hui, et le CDC ne prescrit pas de présentation en vitrine.
    // Remplacer une phrase fausse par une autre rouvrirait le ticket.
    expect(screen.queryByText(/page publique/)).toBeNull();

    cleanup();

    renderPanel(LEA);
    expect(screen.getByText(/Aucune présentation n’est enregistrée/)).toBeDefined();
    expect(screen.queryByText(/API/)).toBeNull();
    expect(screen.queryByText(/page publique/)).toBeNull();
  });

  it('envoie la présentation saisie, débarrassée de ses espaces', async () => {
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: LEA });

    renderPanel();
    await userEvent.type(screen.getByLabelText(/Présentation/), '  Massage suédois  ');
    await userEvent.click(saveButton());

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, {
      bio: 'Massage suédois',
    });
  });

  it('neutralise la saisie et l’autre bouton tant que l’écriture est en vol', async () => {
    // Deux pertes silencieuses tiennent à cette borne — une frappe glissée
    // pendant l'aller-retour, que la relecture de la fiche écraserait sans un
    // mot ; et une suspension lancée pendant un enregistrement, dont la réponse
    // du premier effacerait l'attente, rouvrant son bouton sur un `PATCH`
    // encore en vol.
    updateStaffMemberAction.mockReturnValue(new Promise(() => undefined));

    renderPanel();
    const name = screen.getByLabelText(/Nom d’affichage/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Léa Rakoto');
    await userEvent.click(saveButton());

    expect(name).toHaveProperty('disabled', true);
    expect(screen.getByLabelText(/Présentation/)).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Suspendre la fiche de Léa/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('marque le champ fautif plutôt que d’appeler l’API', async () => {
    renderPanel();
    const name = screen.getByLabelText(/Nom d’affichage/);
    await userEvent.clear(name);
    // Collé plutôt que frappé : cent soixante et une frappes simulées coûtent
    // plus de temps que tout le reste de la suite réunie.
    await userEvent.paste('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1));
    await userEvent.click(saveButton());

    expect(updateStaffMemberAction).not.toHaveBeenCalled();
    // Le message du contrat, rendu sous le champ par `Field` (web-frontend §4).
    expect(screen.getByText(new RegExp(String(DISPLAY_NAME_MAX_LENGTH)))).toBeDefined();
  });
});

describe('StaffProfilePanel — suspendre et réactiver', () => {
  it('suspend une fiche active, et dit ce que la suspension n’emporte pas', async () => {
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: { ...LEA, isActive: false } });

    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Suspendre la fiche de Léa/ }));

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, {
      isActive: false,
    });
    expect(screen.getByText(/rendez-vous passés sont intacts/)).toBeDefined();
    expect(refresh).toHaveBeenCalled();
  });

  it('propose « Réactiver » sur une fiche suspendue, sans qu’aucun clic n’ait eu lieu', async () => {
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: LEA });

    renderPanel({ ...LEA, isActive: false });
    expect(screen.queryByRole('button', { name: /Suspendre la fiche/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Réactiver la fiche de Léa/ }));

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, { isActive: true });
  });

  it('affiche le refus de l’API sans prétendre que la fiche a changé', async () => {
    updateStaffMemberAction.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Praticien introuvable.',
    });

    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Suspendre la fiche de Léa/ }));

    expect(screen.getByText('Praticien introuvable.')).toBeDefined();
    expect(screen.getByRole('button', { name: /Suspendre la fiche de Léa/ })).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('StaffProfilePanel — le rang qui écrit', () => {
  it('ne propose aucun contrôle au rang praticien', () => {
    renderPanel(LEA, false);

    expect(screen.queryByRole('button', { name: /Enregistrer la fiche/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Suspendre la fiche/ })).toBeNull();
    expect(screen.getByText(/réservées aux gérants/)).toBeDefined();
  });
});
