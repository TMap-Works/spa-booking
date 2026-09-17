import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ServiceStaffPanel,
  type ServiceStaffChoice,
} from '@/app/(admin)/[tenantSlug]/admin/components/service-staff-panel';

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

/** Une affectée et une non affectée : les deux moitiés de la bascule. */
const staff: ServiceStaffChoice[] = [
  { id: HASINA, displayName: 'Hasina', isActive: true, assigned: true },
  { id: RINA, displayName: 'Rina', isActive: true, assigned: false },
];

afterEach(() => {
  cleanup();
  assignServiceStaffAction.mockReset();
  removeServiceStaffAction.mockReset();
  refresh.mockReset();
});

function renderPanel(overrides: { readonly staff?: ServiceStaffChoice[] } = {}): void {
  render(
    <ServiceStaffPanel
      tenantSlug="salon-des-lilas"
      serviceId={SERVICE_ID}
      staff={overrides.staff ?? staff}
    />,
  );
}

describe('affectation des praticiens — ce que l’écran montre', () => {
  it('liste tout l’établissement, affectés comme non affectés (#768)', () => {
    // Le motif retenu pour les deux faces du lien (CDC §2.4) : la liste
    // complète, une bascule par ligne. Plus de sélecteur « Ajouter un
    // praticien » qui n'aurait montré que les non affectés.
    renderPanel();

    expect(screen.getByText('Hasina', { selector: '.spa-admin-toolbar__caption' })).toBeDefined();
    expect(screen.getByText('Rina', { selector: '.spa-admin-toolbar__caption' })).toBeDefined();
    expect(screen.queryByLabelText(/Ajouter un praticien/)).toBeNull();
  });

  it('distingue les deux états par un badge et par le libellé de la bascule', () => {
    // Les mêmes mots, les mêmes variantes de bouton que « Prestations
    // pratiquées » sur la fiche praticien : neutre pour affecter, discret pour
    // retirer.
    renderPanel();

    expect(screen.getByText('Affecté')).toBeDefined();
    expect(screen.getByRole('button', { name: /Retirer Hasina/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Affecter Rina/ })).toBeDefined();
  });

  it('dit ce qu’implique une prestation que personne ne pratique', () => {
    // La conséquence est annoncée en tête du panneau, qu'il y ait ou non
    // quelqu'un d'affecté : c'est elle qui explique pourquoi la liste compte.
    renderPanel({ staff: [{ id: RINA, displayName: 'Rina', isActive: true, assigned: false }] });

    expect(screen.getByText(/ne proposera aucun créneau/i)).toBeDefined();
  });

  it('garde une fiche désactivée dans la liste, en le disant', () => {
    // La masquer ferait croire à une affectation perdue et inviterait à la
    // recréer — pour se heurter au conflit d'unicité de `service_staff`.
    renderPanel({
      staff: [{ id: HASINA, displayName: 'Hasina', isActive: false, assigned: true }],
    });

    expect(screen.getByText('Compte désactivé')).toBeDefined();
    expect(screen.getByRole('button', { name: /Retirer Hasina/ })).toBeDefined();
  });

  it('propose une fiche désactivée non affectée plutôt que de la masquer', () => {
    // L'API accepte de l'affecter, et le back-office est l'écran où on la
    // retrouve.
    renderPanel({
      staff: [{ id: RINA, displayName: 'Rina', isActive: false, assigned: false }],
    });

    expect(screen.getByText('Compte désactivé')).toBeDefined();
    expect(screen.getByRole('button', { name: /Affecter Rina/ })).toBeDefined();
  });

  it('dit qu’aucune fiche praticien n’existe dans l’établissement', () => {
    // Un état de démarrage dont on ne sort pas depuis cet écran : le taire
    // laisserait chercher une liste vide sans savoir pourquoi.
    renderPanel({ staff: [] });

    expect(screen.getByText('Aucune fiche praticien')).toBeDefined();
    expect(screen.getByText(/Créez au moins une fiche praticien/i)).toBeDefined();
  });
});

describe('affectation des praticiens — les gestes', () => {
  it('affecte en un seul clic, un praticien à la fois', async () => {
    // Unitaire, et non « remplace la liste » : envoyer l'ensemble à chaque clic
    // écraserait ce qu'un collègue vient d'ajouter depuis un autre poste.
    assignServiceStaffAction.mockResolvedValue({
      ok: true,
      data: { id: RINA, displayName: 'Rina', isActive: true },
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /Affecter Rina/ }));

    expect(assignServiceStaffAction).toHaveBeenCalledWith('salon-des-lilas', SERVICE_ID, {
      staffId: RINA,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('retire en un seul clic, sans confirmation — le geste est réversible', async () => {
    removeServiceStaffAction.mockResolvedValue({ ok: true, data: null });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /Retirer Hasina/ }));

    expect(removeServiceStaffAction).toHaveBeenCalledWith('salon-des-lilas', SERVICE_ID, HASINA);
    expect(refresh).toHaveBeenCalled();
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

    await user.click(screen.getByRole('button', { name: /Affecter Rina/ }));

    expect(await screen.findByText(/déjà affecté à cette prestation/i)).toBeDefined();
    // La liste est rechargée : c'est ce qui remet l'écran d'aplomb.
    expect(refresh).toHaveBeenCalled();
  });

  it('affiche le motif d’un échec qui n’est pas un conflit', async () => {
    removeServiceStaffAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL',
      message: 'Le service est momentanément indisponible.',
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /Retirer Hasina/ }));

    expect(await screen.findByText(/momentanément indisponible/i)).toBeDefined();
  });

  it('rend les autres lignes inertes tant qu’une bascule est en vol', async () => {
    // `pending` est une clé unique : deux bascules concurrentes se
    // décomptabilisent — la première à répondre remet `pending` à `null` et
    // rouvre le bouton de la seconde, dont la requête est toujours en vol.
    let resolve: ((value: unknown) => void) | undefined;
    assignServiceStaffAction.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /Affecter Rina/ }));

    expect(
      screen.getByRole('button', { name: /Retirer Hasina/ }).hasAttribute('disabled'),
    ).toBe(true);

    resolve?.({ ok: true, data: { id: RINA, displayName: 'Rina', isActive: true } });
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

    const button = screen.getByRole('button', { name: /Affecter Rina/ });
    await user.click(button);
    await user.click(button);

    expect(assignServiceStaffAction).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: { id: RINA, displayName: 'Rina', isActive: true } });
  });
});

describe('affectation des praticiens — ce que le rang praticien voit (#619)', () => {
  function renderReadOnly(): void {
    render(
      <ServiceStaffPanel
        tenantSlug="salon-des-lilas"
        serviceId={SERVICE_ID}
        staff={staff}
        canManage={false}
      />,
    );
  }

  it('garde la liste et retire ses bascules', () => {
    // `POST` et `DELETE /v1/services/{id}/staff` sont `@AuthAtLeast('MANAGER')` :
    // qui pratique la prestation reste une information utile, l'affecter non.
    renderReadOnly();

    expect(screen.getByText('Hasina', { selector: '.spa-admin-toolbar__caption' })).toBeDefined();
    expect(screen.getByText('Rina', { selector: '.spa-admin-toolbar__caption' })).toBeDefined();
    expect(screen.getByText('Affecté')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Retirer/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Affecter/ })).toBeNull();
  });

  it('dit pourquoi l’affectation n’est pas proposée', () => {
    renderReadOnly();

    expect(screen.getByText(/réservée au rang gérant/i)).toBeDefined();
  });
});
