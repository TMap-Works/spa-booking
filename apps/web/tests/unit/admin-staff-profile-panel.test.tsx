import { DISPLAY_NAME_MAX_LENGTH, type StaffMember } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffProfilePanel } from '@/app/(admin)/[tenantSlug]/admin/personnel/[staffId]/staff-profile-panel';

/**
 * Ce que le panneau de la fiche envoie — et surtout ce qu'il n'envoie pas (#705).
 *
 * Le corps d'un `PATCH` est ici la seule chose qui compte : l'API accepte les
 * trois champs, et c'est l'écran qui décide lesquels partent. Deux règles s'y
 * jouent, qu'aucun test d'intégration ne peut tenir à sa place —
 *
 * - la **présentation ne se relit pas** (`StaffMemberDto` ne publie pas `bio`) :
 *   un champ laissé vide ne veut donc pas dire « efface », et `bio` ne doit pas
 *   figurer dans le corps tant qu'on n'y a pas touché ;
 * - quand on y a touché et qu'on l'a vidée, ce qui part est `null` et non `""` —
 *   le premier des deux constats laissés par la revue de #694.
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

  it('n’envoie pas `bio` quand la présentation n’a pas été touchée', async () => {
    // Le champ s'ouvre vide faute de pouvoir être relu : l'y lire comme un
    // « efface » supprimerait une présentation que la gérante ne voit même pas.
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: { ...LEA, displayName: 'Léa R.' } });

    renderPanel();
    const name = screen.getByLabelText(/Nom d’affichage/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Léa R.');
    await userEvent.click(saveButton());

    const [, , body] = updateStaffMemberAction.mock.calls[0] as [string, string, object];
    expect(Object.hasOwn(body, 'bio')).toBe(false);
  });

  it('envoie `null` — et non une chaîne vide — pour effacer la présentation', async () => {
    // Le constat de la revue de #694 : `PATCH { bio: "" }` écrirait une chaîne
    // vide là où `NULL` veut dire « pas de présentation ».
    updateStaffMemberAction.mockResolvedValue({ ok: true, data: LEA });

    renderPanel();
    const bio = screen.getByLabelText(/Présentation/);
    await userEvent.type(bio, 'Spécialiste du massage');
    await userEvent.clear(bio);
    await userEvent.click(saveButton());

    expect(updateStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, { bio: null });
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
