import { type StaffAccountState } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffAccountActions } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-account-actions';

/**
 * Ce que la ligne d'un compte propose, et sur quoi elle se fonde (#695).
 *
 * Le défaut relevé par la campagne de QA était entier ici : l'état d'activation
 * partait d'un `null`, si bien qu'un rechargement de page ramenait « Désactiver »
 * sur un compte pourtant fermé. Ces cas tiennent l'inverse — le libellé découle
 * de ce que l'API rend, avant tout clic.
 *
 * L'action serveur et le routeur sont des modules Next qui n'existent pas hors du
 * serveur : ce qu'on éprouve est le composant, pas le transport.
 */

const setStaffAccountStatusAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  changeStaffAccountRoleAction: vi.fn(),
  reissueStaffInvitationAction: vi.fn(),
  setStaffAccountStatusAction: (...args: unknown[]) => setStaffAccountStatusAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  setStaffAccountStatusAction.mockReset();
  refresh.mockReset();
});

const LEA: StaffAccountState = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'lea@salon-des-lilas.test',
  role: 'staff',
  firstName: 'Léa',
  lastName: 'Praticienne',
  phone: null,
  isActive: true,
};

function renderActions(account: StaffAccountState = LEA): void {
  render(<StaffAccountActions account={account} isSelf={false} tenantSlug="spa-lumiere" />);
}

describe('StaffAccountActions — l’état vient de l’API', () => {
  it('propose « Désactiver » sur un compte actif', () => {
    renderActions();

    expect(screen.getByRole('button', { name: /Désactiver le compte de Léa/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Réactiver le compte de Léa/ })).toBeNull();
  });

  it('propose « Réactiver » sur un compte désactivé, sans qu’aucun clic n’ait eu lieu', () => {
    // Le cas exact de #695 : c'est l'état de la ligne au premier rendu — donc
    // après un rechargement de page — qui était faux.
    renderActions({ ...LEA, isActive: false });

    expect(screen.getByRole('button', { name: /Réactiver le compte de Léa/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Désactiver le compte de Léa/ })).toBeNull();
  });

  it('demande la réactivation — et non une seconde désactivation — d’un compte fermé', async () => {
    setStaffAccountStatusAction.mockResolvedValue({
      ok: true,
      data: { ...LEA, isActive: true },
    });

    renderActions({ ...LEA, isActive: false });
    await userEvent.click(screen.getByRole('button', { name: /Réactiver le compte de Léa/ }));

    expect(setStaffAccountStatusAction).toHaveBeenCalledWith('spa-lumiere', LEA.id, {
      isActive: true,
    });
    expect(screen.getByText(/Compte réactivé/)).toBeDefined();
    expect(refresh).toHaveBeenCalled();
  });
});
