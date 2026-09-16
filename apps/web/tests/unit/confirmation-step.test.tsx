/**
 * L'écran terminal du tunnel — ce qui en sort, et ce qu'il a le droit d'affirmer
 * (#732).
 *
 * Deux choses lui étaient reprochées par l'audit de conception `d20260916-1`, et
 * la suite les tient séparément :
 *
 * - **il ne sortait nulle part.** La seule action offerte était « Annuler ce
 *   rendez-vous », alors que `docs/design/appointments/wireframes.md` — Étape 6
 *   — prescrit des prochaines actions : réserver à nouveau, rejoindre le
 *   rendez-vous là où il se modifie ;
 * - **il affirmait un état qu'il ne relit pas.** Le brouillon est écrit une fois,
 *   à la réservation ; reporté ou annulé depuis l'espace client, le rendez-vous
 *   restait annoncé « enregistré » à son ancien horaire.
 */

import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmationStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/confirmation-step';

import { contact, service, tenant } from './fixtures';

const cancelAppointmentAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  cancelAppointmentAction: (...args: unknown[]) => cancelAppointmentAction(...args),
}));

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    status: 'confirmed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '',
    clientId: '66666666-6666-4666-8666-666666666666',
    startsAt: '2026-09-01T06:00:00.000Z',
    endsAt: '2026-09-01T07:00:00.000Z',
    price: service.price,
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

function renderConfirmation(
  options: { readonly restored?: boolean; readonly cancelled?: boolean } = {},
) {
  const onRestart = vi.fn();
  const onCancelled = vi.fn();

  render(
    <ConfirmationStep
      tenant={tenant}
      service={service}
      appointment={
        options.cancelled === true
          ? appointment({ status: 'cancelled', cancelledAt: '2026-08-31T10:00:00.000Z' })
          : appointment()
      }
      contact={contact}
      restored={options.restored ?? false}
      onCancelled={onCancelled}
      onRestart={onRestart}
    />,
  );

  return { onRestart, onCancelled, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  cancelAppointmentAction.mockReset();
});

describe('l’écran terminal est une sortie', () => {
  it('propose de réserver à nouveau, et repart alors d’un brouillon vierge', async () => {
    const { onRestart, user } = renderConfirmation();

    await user.click(screen.getByRole('button', { name: 'Réserver à nouveau' }));

    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('mène à l’espace client, où le rendez-vous se reporte et s’annule', () => {
    renderConfirmation();

    const lien = screen.getByRole('link', { name: 'Voir mes rendez-vous' });

    // Un lien et non un bouton : c'est une navigation, elle doit s'ouvrir dans
    // un onglet et se copier comme n'importe quelle adresse.
    expect(lien.getAttribute('href')).toBe('/maison-lotus/compte');
  });

  it('range l’annulation en action secondaire, le rouge restant au geste destructif', async () => {
    const { user } = renderConfirmation();

    const annuler = screen.getByRole('button', { name: 'Annuler ce rendez-vous' });

    // L'entrée dans l'annulation n'est plus l'action mise en avant de l'écran :
    // c'est « Réserver à nouveau » qui porte l'accent.
    expect(annuler.className).toContain('spa-button--quiet');
    expect(
      screen.getByRole('button', { name: 'Réserver à nouveau' }).className,
    ).toContain('spa-button--accent');

    await user.click(annuler);

    // Le rouge reparaît là où il compte : sur la confirmation elle-même.
    expect(screen.getByRole('button', { name: 'Confirmer l’annulation' }).className).toContain(
      'spa-button--danger',
    );
  });

  it('écarte les sorties tant que la question de l’annulation attend sa réponse', async () => {
    const { user } = renderConfirmation();

    await user.click(screen.getByRole('button', { name: 'Annuler ce rendez-vous' }));

    // Deux boutons face à une question, et rien qui invite à passer à côté sans
    // y répondre.
    expect(screen.queryByRole('button', { name: 'Réserver à nouveau' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Voir mes rendez-vous' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Garder mon rendez-vous' })).toBeDefined();
  });

  it('garde ses deux sorties une fois le rendez-vous annulé, sans reproposer l’annulation', () => {
    renderConfirmation({ cancelled: true });

    expect(screen.getByRole('button', { name: 'Réserver à nouveau' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Annuler ce rendez-vous' })).toBeNull();
  });

  it('nomme la reprise d’un seul libellé, celui du wireframe', () => {
    // Le même geste en portait deux selon l'état du rendez-vous : « Réserver à
    // nouveau » confirmé, « Prendre un nouveau rendez-vous » annulé. Le
    // wireframe — Étape 6 — n'en connaît qu'un, et un écran qui renomme son
    // action selon l'état apprend deux fois la même chose au visiteur.
    renderConfirmation({ cancelled: true });

    expect(screen.queryByRole('button', { name: 'Prendre un nouveau rendez-vous' })).toBeNull();
  });
});

describe('ce que l’écran a le droit d’affirmer', () => {
  it('annonce le rendez-vous enregistré quand il sort de la réponse de l’API', () => {
    renderConfirmation();

    expect(screen.getByText('Votre rendez-vous est enregistré')).toBeDefined();
  });

  it('n’affirme plus rien quand il ne fait que resservir le brouillon', () => {
    renderConfirmation({ restored: true });

    // « enregistré » est une affirmation sur l'agenda du salon, que le front n'a
    // aucun moyen de vérifier : aucune lecture publique d'un rendez-vous
    // n'existe côté API.
    expect(screen.queryByText('Votre rendez-vous est enregistré')).toBeNull();

    const avis = screen.getByText('Votre dernière réservation dans cet onglet');

    expect(avis).toBeDefined();
    // L'autorité nommée est celle qui vaut pour tout le monde : une cliente qui
    // a réservé sans compte n'a pas d'espace client à consulter.
    expect(avis.parentElement?.textContent).toContain('agenda du salon');
    // La sortie, elle, reste offerte à celles qui en ont un.
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' })).toBeDefined();
  });

  it('dit annulé ce que l’API vient d’annuler, même restitué depuis le brouillon', () => {
    // L'annulation, elle, est un état que le brouillon ne peut pas inventer :
    // il n'y arrive que par la réponse de l'API.
    renderConfirmation({ restored: true, cancelled: true });

    expect(screen.getByText('Votre rendez-vous est annulé')).toBeDefined();
  });
});
