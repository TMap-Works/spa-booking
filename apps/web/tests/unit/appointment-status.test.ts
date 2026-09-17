import type { BookedAppointment } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  appointmentBadge,
  isStillActionable,
  PENDING_CONFIRMATION_LABEL,
} from '@/app/(account)/[tenantSlug]/compte/components/appointment-status';

/**
 * Ce que l'espace client annonce d'un rendez-vous (#47).
 *
 * Logique de présentation pure : aucun DOM, aucun réseau. Le cas qui compte est
 * la distinction entre une **annulation** et un **report**, que l'API n'exprime
 * que par l'absence d'auteur sur la ligne d'origine.
 */

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'pending',
    serviceId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d',
    staffId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2e',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

describe('pastille de statut', () => {
  it('distingue un report d’une annulation', () => {
    // Un report annule la ligne d'origine **sans auteur** : c'est la seule chose
    // qui l'en distingue. Les confondre ferait lire « annulé » à une cliente qui
    // vient précisément de conserver son rendez-vous en le déplaçant.
    const deplace = appointmentBadge(
      appointment({ status: 'cancelled', cancelledAt: '2026-08-30T09:00:00.000Z' }),
      'past',
    );
    const annuleParElle = appointmentBadge(
      appointment({
        status: 'cancelled',
        cancelledAt: '2026-08-30T09:00:00.000Z',
        cancelledBy: 'client',
      }),
      'past',
    );
    const annuleParLeSalon = appointmentBadge(
      appointment({
        status: 'cancelled',
        cancelledAt: '2026-08-30T09:00:00.000Z',
        cancelledBy: 'staff',
      }),
      'past',
    );

    expect(deplace.label).toBe('Déplacé');
    expect(annuleParElle.label).toBe('Annulé par vous');
    expect(annuleParLeSalon.label).toBe('Annulé par le salon');
    // Le ton reste le même : ce qui porte la nuance est le libellé, pas la
    // couleur — elle ne porte jamais l'information seule.
    expect([deplace.tone, annuleParElle.tone, annuleParLeSalon.tone]).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it.each([
    ['pending', 'À confirmer par le salon'],
    ['confirmed', 'Confirmé'],
    ['completed', 'Honoré'],
    ['no_show', 'Non honoré'],
  ] as const)('nomme le statut %s en clair', (status, label) => {
    expect(appointmentBadge(appointment({ status }), 'upcoming').label).toBe(label);
  });

  /**
   * Le mot de l'attente, et le seul (#743).
   *
   * L'écran terminal du tunnel importe cette même constante : c'est d'avoir
   * écrit deux fois la même chose que les deux surfaces ont fini par la dire
   * autrement — « Votre rendez-vous est enregistré » d'un côté, « En attente de
   * confirmation » de l'autre, sur le même rendez-vous.
   */
  it('nomme l’acteur attendu plutôt qu’une attente sans sujet', () => {
    expect(PENDING_CONFIRMATION_LABEL).toBe('À confirmer par le salon');
    expect(appointmentBadge(appointment({ status: 'pending' }), 'upcoming').label).toBe(
      PENDING_CONFIRMATION_LABEL,
    );
  });

  it('ne promet plus de confirmation à un rendez-vous que son heure a dépassé', () => {
    // « à venir » est l'intervalle non terminé **dont le statut occupe encore le
    // créneau » : un `pending` dont l'heure est passée descend donc dans
    // l'historique. Lui laisser « À confirmer par le salon » lui promettrait une
    // suite qui ne viendra pas — c'est le rendez-vous de la veille que l'audit a
    // relevé, pastille intacte.
    const badge = appointmentBadge(appointment({ status: 'pending' }), 'past');

    expect(badge.label).toBe('Non confirmé');
    // Le ton ne bouge pas : c'est bien le même statut, et la couleur ne porte
    // jamais l'information seule.
    expect(badge.tone).toBe('pending');
  });
});

describe('gestes encore possibles', () => {
  it('n’offre report et annulation que sur un rendez-vous qui tient son créneau', () => {
    expect(isStillActionable(appointment({ status: 'pending' }))).toBe(true);
    expect(isStillActionable(appointment({ status: 'confirmed' }))).toBe(true);
    // Terminé, annulé, non honoré : il n'y a plus rien à déplacer ni à annuler,
    // et proposer le bouton serait une promesse que le clic ne tiendrait pas.
    expect(isStillActionable(appointment({ status: 'completed' }))).toBe(false);
    expect(isStillActionable(appointment({ status: 'cancelled' }))).toBe(false);
    expect(isStillActionable(appointment({ status: 'no_show' }))).toBe(false);
  });
});
