import type { BookedAppointment } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_PLURAL_LABELS,
  appointmentBadge,
  appointmentOutcomeLabel,
  appointmentStatusLabelInSentence,
  appointmentTone,
  isStillActionable,
  PENDING_CONFIRMATION_LABEL,
} from '@/lib/appointment-status';

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

/**
 * Ce que le **back-office** lit du même rendez-vous — #917.
 *
 * Le planning, le tiroir, la fiche cliente et l'encaissement appellent tous
 * `appointmentOutcomeLabel` : c'est le geste unique par lequel les quatre
 * surfaces disent la même chose. Le cas qui compte reste le même qu'à l'espace
 * client — l'absence d'auteur —, à ceci près que le contrat de l'agenda l'exprime
 * par une clé **omise** là où les deux autres posent `null`.
 */
describe('le mot du comptoir', () => {
  it('lit « Déplacé » aussi bien sur une clé absente que sur un `null`', () => {
    // `appointmentSchema` omet la clé, `bookedAppointmentSchema` et
    // `customerVisitSchema` la posent à `null`. Les deux disent « personne à
    // nommer », c'est-à-dire l'origine d'un report.
    expect(appointmentOutcomeLabel({ status: 'cancelled' })).toBe('Déplacé');
    expect(appointmentOutcomeLabel({ status: 'cancelled', cancelledBy: null })).toBe('Déplacé');
    expect(appointmentOutcomeLabel({ status: 'cancelled', cancelledBy: undefined })).toBe(
      'Déplacé',
    );
  });

  it('nomme l’auteur d’une vraie annulation, à la personne de son audience', () => {
    const parLaCliente = { status: 'cancelled', cancelledBy: 'client' } as const;

    expect(appointmentOutcomeLabel(parLaCliente)).toBe('Annulé par la cliente');
    // Le comptoir parle du salon à la troisième personne, l'espace client à la
    // deuxième. Même fait, même table, deux interlocuteurs.
    expect(appointmentOutcomeLabel(parLaCliente, 'client')).toBe('Annulé par vous');
    expect(appointmentOutcomeLabel({ status: 'cancelled', cancelledBy: 'staff' })).toBe(
      'Annulé par le salon',
    );
    // `system` — une annulation automatique — reste du côté du salon : c'est sa
    // décision, prise par son outil.
    expect(appointmentOutcomeLabel({ status: 'cancelled', cancelledBy: 'system' })).toBe(
      'Annulé par le salon',
    );
  });

  it('ignore l’auteur sur tout statut qui n’est pas une annulation', () => {
    // Une donnée résiduelle sur une ligne rouverte ne doit pas faire dire
    // « Déplacé » à un rendez-vous honoré.
    expect(appointmentOutcomeLabel({ status: 'completed', cancelledBy: null })).toBe('Honoré');
    expect(appointmentOutcomeLabel({ status: 'no_show' })).toBe('Non honoré');
  });
});

/**
 * Le vocabulaire lui-même — la table que six surfaces lisent désormais.
 *
 * C'est le cinquième critère de #917 : « le vocabulaire n'est plus écrit qu'à un
 * seul endroit du front ». Ce qui se vérifie ici est ce que cette unicité devait
 * produire — « Non honoré » et non plus « non présenté » ni « No-shows », et le
 * même mot au singulier et au pluriel.
 */
describe('table de vocabulaire', () => {
  it('dit « Non honoré » du no-show, au singulier comme au pluriel', () => {
    expect(APPOINTMENT_STATUS_LABELS.no_show).toBe('Non honoré');
    expect(APPOINTMENT_STATUS_PLURAL_LABELS.no_show).toBe('Non honorés');
  });

  it('accorde chaque statut sans jamais changer de mot', () => {
    for (const status of Object.keys(APPOINTMENT_STATUS_LABELS) as (keyof typeof APPOINTMENT_STATUS_LABELS)[]) {
      const singulier = APPOINTMENT_STATUS_LABELS[status];
      const pluriel = APPOINTMENT_STATUS_PLURAL_LABELS[status];

      // Le pluriel est le singulier, éventuellement suivi d'un `s`. Rien d'autre :
      // c'est ce qui interdit qu'une des deux tables reparte vers « No-shows ».
      expect([singulier, `${singulier}s`]).toContain(pluriel);
    }
  });

  it('descend l’initiale pour les libellés insérés au fil d’une phrase', () => {
    // « Marquer non honoré », et non « Marquer Non honoré » : une capitale au
    // milieu d'une phrase se lit comme un nom propre.
    expect(appointmentStatusLabelInSentence('no_show')).toBe('non honoré');
    expect(appointmentStatusLabelInSentence('completed')).toBe('honoré');
  });

  it('dérive le ton d’un statut vers le vocabulaire des feuilles de style', () => {
    expect(appointmentTone('no_show')).toBe('no-show');
    expect(appointmentTone('confirmed')).toBe('confirmed');
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
