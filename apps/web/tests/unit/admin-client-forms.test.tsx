import type { Customer } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientNoteForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-note-form';
import { ClientSearchForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-search-form';

/**
 * Les deux gestes d'écriture de l'écran du fichier client (#54) : chercher, et
 * noter.
 *
 * Ce qui se vérifie ici est ce qu'un relecteur ne peut pas voir en lisant le
 * JSX : que la borne de recherche du contrat est signalée **sur le champ** et
 * non en bloc en haut de l'écran (web-frontend §4), et qu'une note vidée part
 * bien en `null` — la seule valeur qui l'efface, là où la chaîne vide
 * descendrait jusqu'à la colonne comme une note d'un caractère nul.
 */

const push = vi.fn();
const refresh = vi.fn();
const updateCustomerAction = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/clients/actions', () => ({
  updateCustomerAction: (...args: unknown[]) => updateCustomerAction(...args),
}));

const FARA: Customer = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Fara',
  lastName: 'Rakotoson',
  email: 'fara.rakotoson@example.mg',
  phone: '+261341234567',
  isActive: true,
  internalNote: 'Peau réactive — éviter les huiles parfumées.',
  createdAt: '2026-03-04T08:00:00.000Z',
  // Une fiche qui désigne encore quelqu'un (#529).
  anonymizedAt: null,
  // Une adresse vivante — l'état de la quasi-totalité du fichier (#525).
  emailSuppressedAt: null,
  emailSuppressionReason: null,
};

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  updateCustomerAction.mockReset();
});

describe('la recherche du fichier client', () => {
  it('cherche le terme saisi, découpé, dans l’URL', async () => {
    render(<ClientSearchForm tenantSlug="maison-lotus" term="" hint="Nom, téléphone ou e-mail." />);

    await userEvent.type(screen.getByLabelText(/rechercher un client/i), '  rako  ');
    await userEvent.click(screen.getByRole('button', { name: /rechercher/i }));

    expect(push).toHaveBeenCalledWith('/maison-lotus/admin/clients?recherche=rako');
  });

  it('refuse une lettre seule, et le dit sur le champ plutôt qu’en haut de page', async () => {
    render(<ClientSearchForm tenantSlug="maison-lotus" term="" hint="Nom, téléphone ou e-mail." />);

    await userEvent.type(screen.getByLabelText(/rechercher un client/i), 'r');
    await userEvent.click(screen.getByRole('button', { name: /rechercher/i }));

    // Le message est celui du champ — `spa-field__error`, référencé par
    // `aria-describedby` —, et rien n'est parti vers le serveur.
    expect(screen.getByRole('alert').textContent).toMatch(/au moins 2 caractères/i);
    expect(push).not.toHaveBeenCalled();
  });

  it('revient au fichier entier quand on vide le champ', async () => {
    render(
      <ClientSearchForm tenantSlug="maison-lotus" term="rako" hint="1 fiche pour « rako »." />,
    );

    await userEvent.clear(screen.getByLabelText(/rechercher un client/i));
    await userEvent.click(screen.getByRole('button', { name: /rechercher/i }));

    expect(push).toHaveBeenCalledWith('/maison-lotus/admin/clients');
  });
});

describe('la note interne d’une fiche', () => {
  function renderNote(internalNote: string | null): void {
    render(
      <ClientNoteForm
        customerId={FARA.id}
        internalNote={internalNote}
        tenantSlug="maison-lotus"
      />,
    );
  }

  it('écrit que la note est interne, plutôt que de le suggérer par une teinte', () => {
    // C'est la seule garantie qui survive à un daltonisme, à une impression en
    // gris, et à un opérateur qui tourne son écran vers la cliente.
    renderNote(FARA.internalNote);

    expect(screen.getByText('Interne au salon')).toBeDefined();
    expect(screen.getByText(/jamais transmise à la cliente/i)).toBeDefined();
  });

  it('pré-remplit la note en place et dit qu’enregistrer la remplace', () => {
    renderNote(FARA.internalNote);

    const field = screen.getByLabelText(/note interne/i) as HTMLTextAreaElement;
    expect(field.value).toBe(FARA.internalNote);
    expect(screen.getByText(/remplace la note précédente/i)).toBeDefined();
  });

  it('dit ce qu’on note quand la fiche n’en porte aucune', () => {
    renderNote(null);

    expect(screen.getByText('Aucune note pour l’instant')).toBeDefined();
  });

  it('enregistre le texte saisi sans toucher aux coordonnées', async () => {
    updateCustomerAction.mockResolvedValue({ ok: true, data: FARA });
    renderNote(null);

    await userEvent.type(screen.getByLabelText(/note interne/i), 'Préfère la fin de journée.');
    await userEvent.click(screen.getByRole('button', { name: /enregistrer la note/i }));

    // Un seul champ dans le corps : `PATCH` laisse en place ce qu'il ne nomme
    // pas, et le formulaire des notes n'a rien à dire du téléphone.
    expect(updateCustomerAction).toHaveBeenCalledWith('maison-lotus', FARA.id, {
      internalNote: 'Préfère la fin de journée.',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('efface la note par `null`, jamais par la chaîne vide', async () => {
    updateCustomerAction.mockResolvedValue({ ok: true, data: { ...FARA, internalNote: null } });
    renderNote(FARA.internalNote);

    await userEvent.clear(screen.getByLabelText(/note interne/i));
    await userEvent.click(screen.getByRole('button', { name: /enregistrer la note/i }));

    expect(updateCustomerAction).toHaveBeenCalledWith('maison-lotus', FARA.id, {
      internalNote: null,
    });
  });

  it('affiche le refus de l’API sans perdre la saisie', async () => {
    updateCustomerAction.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Fiche cliente introuvable.',
    });
    renderNote(null);

    await userEvent.type(screen.getByLabelText(/note interne/i), 'Allergie amande.');
    await userEvent.click(screen.getByRole('button', { name: /enregistrer la note/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/L’enregistrement a échoué/);
    expect((screen.getByLabelText(/note interne/i) as HTMLTextAreaElement).value).toBe(
      'Allergie amande.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
