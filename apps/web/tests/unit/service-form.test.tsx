import type { Service, ServiceCategory } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';

const createServiceAction = vi.fn();
const updateServiceAction = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

// Les actions serveur sont des modules Next qui n'existent pas hors du serveur,
// et le routeur non plus. Ce qu'on éprouve ici est le formulaire — les règles de
// saisie et ce qu'il envoie —, pas le transport.
vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: (...args: unknown[]) => createServiceAction(...args),
  updateServiceAction: (...args: unknown[]) => updateServiceAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
}));

const categories: ServiceCategory[] = [
  {
    id: '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60',
    slug: 'soins-du-visage',
    name: 'Soins du visage',
    description: null,
    isActive: true,
  },
];

const service: Service = {
  id: 'b7e1c2d3-2222-4c53-8f0e-1b2c3d4e5f60',
  slug: 'massage-suedois',
  name: 'Massage suédois',
  description: 'Un classique.',
  category: { id: categories[0]!.id, slug: 'soins-du-visage', name: 'Soins du visage' },
  durationMinutes: 60,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 5,
  occupiedMinutes: 75,
  price: { amountMinor: 3500, currency: 'EUR' },
  isActive: true,
};

afterEach(() => {
  cleanup();
  createServiceAction.mockReset();
  updateServiceAction.mockReset();
  push.mockReset();
  refresh.mockReset();
});

function renderCreation(): void {
  render(<ServiceForm tenantSlug="salon-des-lilas" currency="EUR" categories={categories} />);
}

function renderEdition(): void {
  render(
    <ServiceForm
      tenantSlug="salon-des-lilas"
      currency="EUR"
      categories={categories}
      service={service}
    />,
  );
}

function valueOf(label: RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;
}

describe('prestation — pré-remplissage', () => {
  it('rend le prix enregistré tel qu’il se ressaisit', () => {
    // 3500 centimes se relisent « 35,00 », et se renverront 3500 : c'est cet
    // aller-retour qui garantit qu'ouvrir une fiche pour changer sa durée ne
    // change pas son prix au passage.
    renderEdition();

    expect(valueOf(/Prix/)).toBe('35,00');
    expect(valueOf(/Durée du soin/)).toBe('60');
    expect(valueOf(/Tampon avant/)).toBe('10');
    expect(valueOf(/Tampon après/)).toBe('5');
  });

  it('affiche la durée réellement bloquée sur l’agenda', () => {
    renderEdition();

    // 60 + 10 + 5 — c'est ce qui explique pourquoi le créneau suivant n'est pas
    // libre à l'heure attendue.
    expect(screen.getByText('1 h 15')).toBeDefined();
  });

  it('recalcule cette durée pendant la saisie', async () => {
    const user = userEvent.setup();
    renderEdition();

    const buffer = screen.getByLabelText(/Tampon après/);
    await user.clear(buffer);
    await user.type(buffer, '30');

    expect(screen.getByText('1 h 40')).toBeDefined();
  });
});

describe('prestation — validation', () => {
  it('rattache le refus de prix au champ, jamais en bloc en haut de page', async () => {
    const user = userEvent.setup();
    renderCreation();

    await user.type(screen.getByLabelText(/Nom de la prestation/), 'Gommage');
    await user.type(screen.getByLabelText(/Durée du soin/), '30');
    await user.type(screen.getByLabelText(/Prix/), '35,005');
    await user.click(screen.getByRole('button', { name: /Créer la prestation/ }));

    const message = await screen.findByText(/montant attendu dans la devise du salon/i);
    const price = screen.getByLabelText(/Prix/);

    expect(price.getAttribute('aria-describedby')).toContain(message.id);
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  it('refuse une durée nulle — un soin de zéro minute n’existe pas', async () => {
    const user = userEvent.setup();
    renderCreation();

    await user.type(screen.getByLabelText(/Nom de la prestation/), 'Gommage');
    await user.type(screen.getByLabelText(/Durée du soin/), '0');
    await user.type(screen.getByLabelText(/Prix/), '20');
    await user.click(screen.getByRole('button', { name: /Créer la prestation/ }));

    expect(await screen.findByText(/strictement positive/i)).toBeDefined();
    expect(createServiceAction).not.toHaveBeenCalled();
  });
});

describe('prestation — ce qui part vers l’API', () => {
  it('envoie un prix entier et sa devise, jamais un flottant', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: { ...service, id: 'neuve' } });
    const user = userEvent.setup();
    renderCreation();

    await user.type(screen.getByLabelText(/Nom de la prestation/), 'Gommage');
    await user.type(screen.getByLabelText(/Durée du soin/), '30');
    await user.type(screen.getByLabelText(/Prix/), '19,90');
    await user.click(screen.getByRole('button', { name: /Créer la prestation/ }));

    expect(createServiceAction).toHaveBeenCalledWith('salon-des-lilas', {
      name: 'Gommage',
      durationMinutes: 30,
      // Les tampons vides valent zéro — le cas courant d'un soin sans
      // préparation.
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      price: { amountMinor: 1990, currency: 'EUR' },
    });
  });

  it('ouvre la fiche de la prestation créée, pour enchaîner sur les praticiens', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: service });
    const user = userEvent.setup();
    renderCreation();

    await user.type(screen.getByLabelText(/Nom de la prestation/), 'Gommage');
    await user.type(screen.getByLabelText(/Durée du soin/), '30');
    await user.type(screen.getByLabelText(/Prix/), '20');
    await user.click(screen.getByRole('button', { name: /Créer la prestation/ }));

    expect(push).toHaveBeenCalledWith(`/salon-des-lilas/admin/catalogue/${service.id}`);
  });

  it('envoie `null` — et non la chaîne vide — quand la description est effacée', async () => {
    // `null` **efface** ; la chaîne vide descendrait jusqu'à la colonne comme
    // une description d'un caractère nul.
    updateServiceAction.mockResolvedValue({ ok: true, data: service });
    const user = userEvent.setup();
    renderEdition();

    await user.clear(screen.getByLabelText(/Description/));
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(updateServiceAction).toHaveBeenCalledWith(
      'salon-des-lilas',
      service.id,
      expect.objectContaining({ description: null }),
    );
  });

  it('déclasse une prestation par `categoryId: null`', async () => {
    updateServiceAction.mockResolvedValue({ ok: true, data: service });
    const user = userEvent.setup();
    renderEdition();

    await user.selectOptions(screen.getByLabelText(/Rubrique/), '');
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(updateServiceAction).toHaveBeenCalledWith(
      'salon-des-lilas',
      service.id,
      expect.objectContaining({ categoryId: null }),
    );
  });
});

describe('prestation — soumission', () => {
  it('ne produit qu’un enregistrement sur un double clic', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    updateServiceAction.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );

    const user = userEvent.setup();
    renderEdition();

    const submit = screen.getByRole('button', { name: /Enregistrer/ });
    await user.click(submit);
    await user.click(submit);

    expect(updateServiceAction).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: service });
  });

  it('pose le conflit de slug sur le champ d’adresse, pas en bandeau', async () => {
    // Le slug est la seule unicité que porte la table : un 409 ne peut venir que
    // de lui, et le message doit se poser là où la saisie se corrige.
    updateServiceAction.mockResolvedValue({
      ok: false,
      code: 'CONFLICT',
      message: 'Une prestation de cet établissement porte déjà ce slug.',
    });
    const user = userEvent.setup();
    renderEdition();

    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    const message = await screen.findByText(/porte déjà cette adresse/i);
    expect(screen.getByLabelText(/Adresse publique/).getAttribute('aria-describedby')).toContain(
      message.id,
    );
  });

  it('annonce l’échec sans effacer la saisie', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'La prestation saisie est invalide.',
    });
    const user = userEvent.setup();
    renderEdition();

    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByText('La prestation saisie est invalide.')).toBeDefined();
    expect(valueOf(/Nom de la prestation/)).toBe('Massage suédois');
  });
});
