import type { ServiceStaffMember, StaffMemberSummary } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceStaffPanel } from '@/app/(admin)/[tenantSlug]/admin/components/service-staff-panel';

const assignServiceStaffAction = vi.fn();
const removeServiceStaffAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  assignServiceStaffAction: (...args: unknown[]) => assignServiceStaffAction(...args),
  removeServiceStaffAction: (...args: unknown[]) => removeServiceStaffAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const SERVICE_ID = 'b7e1c2d3-2222-4c53-8f0e-1b2c3d4e5f60';
const HASINA = '11111111-1111-4111-8111-111111111111';
const RINA = '22222222-2222-4222-8222-222222222222';

const assigned: ServiceStaffMember[] = [
  { id: HASINA, displayName: 'Hasina', isActive: true },
];
const candidates: StaffMemberSummary[] = [{ id: RINA, displayName: 'Rina' }];

afterEach(() => {
  cleanup();
  assignServiceStaffAction.mockReset();
  removeServiceStaffAction.mockReset();
  refresh.mockReset();
});

function renderPanel(
  overrides: {
    readonly assigned?: ServiceStaffMember[];
    readonly candidates?: StaffMemberSummary[];
  } = {},
): void {
  render(
    <ServiceStaffPanel
      tenantSlug="salon-des-lilas"
      serviceId={SERVICE_ID}
      assigned={overrides.assigned ?? assigned}
      candidates={overrides.candidates ?? candidates}
    />,
  );
}

describe('affectation des praticiens — ce que l’écran montre', () => {
  it('dit ce qu’implique une prestation sans praticien', () => {
    // Un état vide sans explication est un bug d'UX : ici l'absence a une
    // conséquence — aucun créneau ne sera proposé.
    renderPanel({ assigned: [] });

    expect(screen.getByText('Aucun praticien affecté')).toBeDefined();
    expect(screen.getByText(/ne proposera aucun créneau/i)).toBeDefined();
  });

  it('garde un praticien désactivé dans la liste, en le disant', () => {
    // Le masquer ferait croire à une affectation perdue et inviterait à la
    // recréer — pour se heurter au conflit d'unicité de `service_staff`.
    renderPanel({ assigned: [{ id: HASINA, displayName: 'Hasina', isActive: false }] });

    // Le nom est aussi dans le nom accessible du bouton de retrait : on vise
    // donc le libellé visible de la ligne, pas n'importe quelle occurrence.
    expect(screen.getByText('Hasina', { selector: '.spa-admin-toolbar__caption' })).toBeDefined();
    expect(screen.getByText('Compte désactivé')).toBeDefined();
    expect(screen.getByRole('button', { name: /Retirer Hasina/ })).toBeDefined();
  });

  it('désactive le choix quand il ne reste personne à affecter, et dit pourquoi', () => {
    renderPanel({ candidates: [] });

    expect(screen.getByLabelText(/Ajouter un praticien/).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/pratiquent déjà cette prestation/i)).toBeDefined();
  });
});

describe('affectation des praticiens — les gestes', () => {
  it('affecte le praticien choisi, un seul à la fois', async () => {
    // Unitaire, et non « remplace la liste » : envoyer l'ensemble à chaque clic
    // écraserait ce qu'un collègue vient d'ajouter depuis un autre poste.
    assignServiceStaffAction.mockResolvedValue({
      ok: true,
      data: { id: RINA, displayName: 'Rina', isActive: true },
    });
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(screen.getByLabelText(/Ajouter un praticien/), RINA);
    await user.click(screen.getByRole('button', { name: /^Affecter$/ }));

    expect(assignServiceStaffAction).toHaveBeenCalledWith('salon-des-lilas', SERVICE_ID, {
      staffId: RINA,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('n’appelle pas l’API quand aucun praticien n’est choisi', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /^Affecter$/ }));

    expect(assignServiceStaffAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/Choisissez un praticien/i)).toBeDefined();
  });

  it('traite un 409 comme un cas normal, pas comme une panne', async () => {
    // Quelqu'un a affecté ce praticien entre le rendu de la page et le clic.
    assignServiceStaffAction.mockResolvedValue({
      ok: false,
      code: 'CONFLICT',
      message: 'Ce praticien est déjà affecté à cette prestation.',
    });
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(screen.getByLabelText(/Ajouter un praticien/), RINA);
    await user.click(screen.getByRole('button', { name: /^Affecter$/ }));

    expect(await screen.findByText(/déjà affecté à cette prestation/i)).toBeDefined();
    // La liste est rechargée : c'est ce qui remet l'écran d'aplomb.
    expect(refresh).toHaveBeenCalled();
  });

  it('retire une affectation sans confirmation — le geste est réversible', async () => {
    removeServiceStaffAction.mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /Retirer Hasina/ }));

    expect(removeServiceStaffAction).toHaveBeenCalledWith('salon-des-lilas', SERVICE_ID, HASINA);
    expect(refresh).toHaveBeenCalled();
  });

  it('ne produit qu’une affectation sur un double clic', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    assignServiceStaffAction.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(screen.getByLabelText(/Ajouter un praticien/), RINA);
    const button = screen.getByRole('button', { name: /^Affecter$/ });
    await user.click(button);
    await user.click(button);

    expect(assignServiceStaffAction).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: { id: RINA, displayName: 'Rina', isActive: true } });
  });
});
