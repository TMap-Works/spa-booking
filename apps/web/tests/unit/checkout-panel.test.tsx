import type { Appointment, AppointmentStatus } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';

/**
 * Le panneau d'encaissement tel qu'il se manipule (#59, critères 2, 3, 4 et 5).
 *
 * Les actions serveur sont doublées : ce qui est exercé ici est **l'écran** —
 * les moyens offerts, la protection du double clic, ce que le reçu affirme —,
 * pas le transport. Le transport a sa recette, et l'API a la sienne.
 *
 * Le SDK de Stripe est doublé lui aussi, et pour une raison qui n'est pas
 * seulement pratique : la vraie implémentation charge un script depuis
 * `js.stripe.com`, précisément parce que les champs carte ne doivent jamais
 * appartenir à notre DOM. Il n'y a donc rien à monter dans jsdom, et c'est le
 * signe que la frontière PCI tient.
 */

const settleInCashAction = vi.fn();
const openCardPaymentAction = vi.fn();
const confirmPayment = vi.fn();
const mount = vi.fn();
const destroy = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  settleInCashAction: (...args: unknown[]) => settleInCashAction(...args),
  openCardPaymentAction: (...args: unknown[]) => openCardPaymentAction(...args),
}));

vi.mock('@/lib/admin/payment-stripe', () => ({
  loadStripeSdk: () =>
    Promise.resolve({
      elements: () => ({ create: () => ({ mount, unmount: vi.fn(), destroy }) }),
      confirmPayment: (...args: unknown[]) => confirmPayment(...args),
    }),
}));

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function appointment(status: AppointmentStatus = 'confirmed'): Appointment {
  return {
    id: APPOINTMENT_ID,
    status,
    client: { id: 'cccccccc-0000-4000-8000-000000000002', firstName: 'Rina', lastName: 'Andriamana' },
    staff: { id: 'dddddddd-0000-4000-8000-000000000003', displayName: 'Hasina' },
    service: {
      id: 'eeeeeeee-0000-4000-8000-000000000004',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: '2026-09-05T06:00:00.000Z',
    endsAt: '2026-09-05T07:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

function renderPanel(status: AppointmentStatus = 'confirmed'): void {
  render(
    <CheckoutPanel appointment={appointment(status)} tenantSlug={SLUG} timeZone={TIMEZONE} />,
  );
}

const CASH_TRANSACTION = {
  id: 'ffffffff-0000-4000-8000-000000000005',
  appointmentId: APPOINTMENT_ID,
  amount: { amountMinor: 3500, currency: 'EUR' },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'cash' as const,
  status: 'succeeded' as const,
  capturedAt: '2026-09-05T07:05:00.000Z',
  createdAt: '2026-09-05T07:05:00.000Z',
};

afterEach(() => {
  cleanup();
  settleInCashAction.mockReset();
  openCardPaymentAction.mockReset();
  confirmPayment.mockReset();
  mount.mockReset();
  destroy.mockReset();
});

describe('le choix du moyen de paiement', () => {
  it('offre les espèces et la carte, et rien qui suppose un lecteur absent', () => {
    renderPanel();

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Espèces/ })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Carte/ })).toBeDefined();
  });

  it('n’offre nulle part où saisir un numéro de carte', () => {
    // La preuve la plus solide de la frontière PCI : il n'y a aucun champ de
    // saisie sur ce panneau, hors les deux boutons radio du moyen de paiement.
    renderPanel();

    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('type')).toBe('radio');
    }
  });

  it('ferme la carte sur un rendez-vous honoré, et dit ce qu’il reste à faire', () => {
    renderPanel('completed');

    expect(screen.getByRole('radio', { name: /Carte/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /Espèces/ })).toHaveProperty('disabled', false);
  });

  it('n’encaisse rien sur un rendez-vous annulé', () => {
    renderPanel('cancelled');

    expect(screen.getByText('Rien à encaisser')).toBeDefined();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});

describe('le règlement en espèces', () => {
  it('n’envoie que l’établissement et le rendez-vous — jamais un montant', async () => {
    // Le prix est celui figé à la réservation, relu en base : un montant envoyé
    // par l'écran serait un prix choisi par l'écran.
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    await waitFor(() => {
      expect(settleInCashAction).toHaveBeenCalledWith(SLUG, APPOINTMENT_ID);
    });
  });

  it('rend un reçu définitif — la caisse fait foi', async () => {
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText(/Encaissement enregistré/)).toBeDefined();
    expect(screen.getByText(/caisse qui fait foi/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Imprimer le ticket' })).toBeDefined();
  });

  it('dit que le passage en « honoré » n’est pas encore servi par l’API', async () => {
    // Un encaissement qui laisse le rendez-vous en `confirmed` doit s'expliquer
    // au comptoir, faute de quoi l'opérateur cherche l'erreur de son côté.
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText(/honoré/)).toBeDefined();
  });

  it('désactive le bouton dès le premier clic — un double clic n’encaisse pas deux fois', async () => {
    settleInCashAction.mockReturnValue(new Promise(() => undefined));
    renderPanel();

    const button = screen.getByRole('button', { name: /en espèces/ });
    await userEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveProperty('disabled', true);
    });
    await userEvent.click(button);

    expect(settleInCashAction).toHaveBeenCalledTimes(1);
  });

  it('rend la main quand l’action serveur ne répond pas du tout', async () => {
    // Une action serveur ne rend un résultat que si elle aboutit : si le réseau
    // du poste tombe entre le clic et le POST, la promesse est **rejetée**. Sans
    // reprise, le bouton resterait grisé et muet, et il ne resterait qu'à
    // recharger la page devant la cliente.
    settleInCashAction.mockRejectedValue(new Error('Failed to fetch'));
    renderPanel();

    const button = screen.getByRole('button', { name: /en espèces/ });
    await userEvent.click(button);

    expect((await screen.findByRole('alert')).textContent).toMatch(/n’a pas répondu/);
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
  });

  it('traduit le refus de l’API en une conduite, pas en un code', async () => {
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'PAYMENT_ALREADY_SETTLED',
      message: 'Already settled.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    const refusal = await screen.findByRole('alert');
    expect(refusal.textContent).toMatch(/déjà été encaissé/i);
    expect(refusal.textContent).not.toMatch(/Already settled/);
  });
});

describe('le paiement par carte', () => {
  const INTENT = {
    paymentId: 'aaaaaaaa-0000-4000-8000-000000000009',
    appointmentId: APPOINTMENT_ID,
    amount: { amountMinor: 3500, currency: 'EUR' },
    status: 'pending' as const,
    // Volontairement écrit en clair et sans entropie : `gitleaks` lit
    // « clientSecret: … » comme une clé d'API et fait rougir la CI sur une valeur
    // qui *ressemble* à un laissez-passer Stripe, fût-elle inventée. Le schéma
    // n'attend qu'une chaîne non vide — la ressemblance ne prouvait rien.
    clientSecret: 'laissez-passer-de-recette',
    publishableKey: 'cle-publiable-de-recette',
  };

  async function openCard(): Promise<void> {
    openCardPaymentAction.mockResolvedValue({ ok: true, data: INTENT });
    renderPanel();

    await userEvent.click(screen.getByRole('radio', { name: /Carte/ }));
    await userEvent.click(screen.getByRole('button', { name: /par carte/ }));
  }

  it('monte l’élément de Stripe plutôt qu’un formulaire de carte à nous', async () => {
    await openCard();

    await waitFor(() => {
      expect(mount).toHaveBeenCalledTimes(1);
    });

    // Toujours aucun champ de saisie hors les radios : ce que Stripe monte est
    // une iframe servie par son domaine, pas un `<input>` de notre arbre.
    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('type')).toBe('radio');
    }
  });

  it('rend un reçu explicitement provisoire quand Stripe accepte', async () => {
    // Le navigateur n'a jamais autorité pour déclarer un paiement abouti : c'est
    // le webhook signé qui inscrit l'encaissement (payments-stripe §2).
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    await openCard();

    // Le bouton reste inerte tant que le SDK n'est pas prêt : confirmer sans lui
    // n'enverrait rien nulle part.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /par carte$/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: /par carte$/ }));

    expect(await screen.findByText('Paiement accepté par le prestataire')).toBeDefined();
    expect(screen.getByText(/pas de capture/i)).toBeDefined();

    // Et rien, sur ce reçu-là, ne prétend l'encaissement déjà inscrit : c'est le
    // webhook qui l'inscrit, et il n'est pas arrivé. Une note qui l'affirmerait
    // contredirait la ligne du dessus, sur le seul point qui ne se brouille pas.
    expect(screen.queryByText(/l’encaissement est bien inscrit/)).toBeNull();
  });

  it('affiche le refus de Stripe sans rien conclure', async () => {
    confirmPayment.mockResolvedValue({ error: { message: 'Votre carte a été refusée.' } });
    await openCard();

    // Le bouton reste inerte tant que le SDK n'est pas prêt : confirmer sans lui
    // n'enverrait rien nulle part.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /par carte$/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: /par carte$/ }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Votre carte a été refusée.',
    );
    expect(screen.queryByText(/Paiement accepté/)).toBeNull();
  });
});
