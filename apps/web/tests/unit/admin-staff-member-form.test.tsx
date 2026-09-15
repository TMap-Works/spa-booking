import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffMemberForm } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-member-form';
import type { StaffAccount } from '@/lib/admin/staff-contract';

/**
 * La création d'une fiche praticien (#694).
 *
 * Ce que ces cas tiennent, et qui est exactement ce que la campagne de QA a
 * trouvé manquant : le back-office a un geste qui **rend une personne
 * réservable**, il envoie l'identifiant du **compte** — pas un nom, pas
 * l'identifiant d'une fiche —, et il dit ce qui se passe quand ce compte a déjà
 * sa fiche.
 *
 * L'action serveur et le routeur sont des modules Next qui n'existent pas hors
 * du serveur : ce qu'on éprouve ici est le formulaire — ce qu'il envoie et ce
 * qu'il signale —, pas le transport.
 */

const createStaffMemberAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  createStaffMemberAction: (...args: unknown[]) => createStaffMemberAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  createStaffMemberAction.mockReset();
  refresh.mockReset();
});

const LEA: StaffAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'lea@salon-des-lilas.test',
  role: 'staff',
  firstName: 'Léa',
  lastName: 'Praticienne',
  phone: null,
};

const HASINA: StaffAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'hasina@salon-des-lilas.test',
  role: 'manager',
  firstName: 'Hasina',
  lastName: 'Rakoto',
  phone: null,
};

function renderForm(accounts: readonly StaffAccount[] = [LEA, HASINA]): void {
  render(<StaffMemberForm accounts={accounts} tenantSlug="spa-lumiere" />);
}

const COMPTE = /Compte à rendre réservable/;
const NOM = /Nom d’affichage/;
const PRESENTATION = /Présentation/;

/** La valeur saisie dans un contrôle, désigné par son libellé à l'écran. */
function valeur(label: RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

async function soumettre(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Créer la fiche/ }));
}

describe('StaffMemberForm — ce qu’il envoie', () => {
  it('envoie l’identifiant du compte choisi, et non son nom', async () => {
    // La confusion que le produit entretenait : « inviter Léa » créait un compte
    // et rien d'autre. Ici, le corps porte `userId` — ce que l'API attend pour
    // nouer la fiche au compte.
    createStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { id: 'fiche', displayName: 'Léa Praticienne', isActive: true },
    });
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(COMPTE), LEA.id);
    await soumettre();

    expect(createStaffMemberAction).toHaveBeenCalledWith('spa-lumiere', {
      userId: LEA.id,
      displayName: 'Léa Praticienne',
    });
  });

  it('préremplit le nom d’affichage, et cesse de le faire dès qu’on le corrige', async () => {
    // Le nom de vitrine n'est pas l'état civil : la proposition rend service,
    // elle ne s'impose pas. Réécrire par-dessus une saisie serait le pire des
    // deux mondes.
    createStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { id: 'fiche', displayName: 'Léa', isActive: true },
    });
    renderForm();

    const compte = screen.getByLabelText(COMPTE);
    await userEvent.selectOptions(compte, LEA.id);
    expect(valeur(NOM)).toBe('Léa Praticienne');

    await userEvent.clear(screen.getByLabelText(NOM));
    await userEvent.type(screen.getByLabelText(NOM), 'Léa');
    await userEvent.selectOptions(compte, HASINA.id);

    expect(valeur(NOM)).toBe('Léa');
  });

  it('n’envoie pas de présentation vide', async () => {
    // « Absente » et « vide » disent la même chose. Le contrat accepterait
    // pourtant la chaîne vide, qui irait s'écrire en base à la place du `NULL`
    // qui veut dire « pas de présentation » : c'est l'écran qui l'empêche.
    createStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { id: 'fiche', displayName: 'Léa Praticienne', isActive: true },
    });
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(COMPTE), LEA.id);
    await userEvent.type(screen.getByLabelText(PRESENTATION), '   ');
    await soumettre();

    expect(createStaffMemberAction.mock.calls[0]?.[1]).not.toHaveProperty('bio');
  });
});

describe('StaffMemberForm — ce qu’il signale', () => {
  it('marque le compte manquant sur son propre contrôle, et n’appelle rien', async () => {
    // web-frontend §4 : le message est sous le champ fautif, jamais en bloc en
    // haut de page. Et un refus de validation ne traverse pas la frontière.
    renderForm();

    await soumettre();

    expect(screen.getByLabelText(COMPTE).getAttribute('aria-invalid')).toBe('true');
    expect(createStaffMemberAction).not.toHaveBeenCalled();
  });

  it('dit « choisissez un compte » plutôt que de parler d’UUID', async () => {
    // Le contrat ne peut dire que « identifiant attendu au format UUID v4 » : il
    // ne sait pas qu'à l'écran ce champ est un sélecteur dont la valeur vide est
    // le défaut. Ce message-là ne s'adresse à personne sous une liste déroulante.
    renderForm();

    await soumettre();

    expect(screen.getByText('Choisissez le compte à rendre réservable.')).toBeTruthy();
    expect(screen.queryByText(/UUID/)).toBeNull();
  });

  it('efface la marque du champ qu’on corrige, et de lui seul', async () => {
    renderForm();

    await userEvent.clear(screen.getByLabelText(NOM));
    await soumettre();
    expect(screen.getByLabelText(COMPTE).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(NOM).getAttribute('aria-invalid')).toBe('true');

    await userEvent.type(screen.getByLabelText(NOM), 'Léa');

    expect(screen.getByLabelText(NOM).getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByLabelText(COMPTE).getAttribute('aria-invalid')).toBe('true');
  });

  it('dit qu’un compte a déjà sa fiche plutôt que d’échouer en silence', async () => {
    // La liste des comptes ne peut pas filtrer ceux qui ont déjà une fiche —
    // l'API ne publie pas `userId` en lecture. Le doublon se rattrape donc ici,
    // avec le message du 409.
    createStaffMemberAction.mockResolvedValue({
      ok: false,
      code: 'STAFF_PROFILE_ALREADY_EXISTS',
      message: 'Ce compte a déjà une fiche praticien.',
    });
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(COMPTE), LEA.id);
    await soumettre();

    expect(screen.getByText('Ce compte a déjà une fiche praticien.')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('confirme la création et rafraîchit la liste', async () => {
    createStaffMemberAction.mockResolvedValue({
      ok: true,
      data: { id: 'fiche', displayName: 'Léa Praticienne', isActive: true },
    });
    renderForm();

    await userEvent.selectOptions(screen.getByLabelText(COMPTE), LEA.id);
    await soumettre();

    expect(screen.getByText(/Léa Praticienne apparaît désormais/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
    // Le formulaire se vide : la fiche suivante part d'une page blanche, et non
    // du nom de la précédente.
    expect(valeur(NOM)).toBe('');
  });

  it('dit pourquoi il ne peut rien faire quand aucun compte n’existe', async () => {
    // L'état d'amorçage d'un salon neuf : la fiche se rattache à un compte, et
    // il faut donc en inviter un d'abord. Un sélecteur muet ne le dirait pas.
    renderForm([]);

    expect(screen.getByText(/Invitez d’abord une personne/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Créer la fiche/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
