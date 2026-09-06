import type { Appointment, AppointmentStatus, Service } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  DESK_ROUTE_MISSING_MESSAGE,
  MOVE_CONFLICT_MESSAGE,
  MOVE_GONE_MESSAGE,
  SLOT_CONFLICT_MESSAGE,
  deskFailureMessage,
  deskMoment,
  deskStatusActions,
  isReschedulable,
  isSlotConflict,
  minutesOfClock,
  moveRefusal,
  offsetDateTimeInTenant,
  offsetInTenant,
  planDeskMove,
  summarize,
  tenantFields,
} from '@/lib/admin/appointment-desk';

/**
 * La logique du comptoir (#50), sans DOM ni réseau.
 *
 * Le cas qui compte est le **fuseau** : c'est le seul endroit du ticket où une
 * erreur ne se voit pas à l'écran et coûte un rendez-vous posé une heure à côté.
 * Les cas d'un fuseau sans changement d'heure (Antananarivo) et d'un fuseau qui
 * en a un (Paris) sont donc exercés tous les deux, de part et d'autre de la
 * bascule.
 */

const ANTANANARIVO = 'Indian/Antananarivo';
const PARIS = 'Europe/Paris';

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    ...overrides,
  };
}

describe('le fuseau du salon, et lui seul', () => {
  it('mesure le décalage d’un fuseau sans changement d’heure', () => {
    expect(offsetInTenant(new Date('2026-08-26T11:30:00.000Z'), ANTANANARIVO)).toBe(180);
    expect(offsetInTenant(new Date('2026-01-15T11:30:00.000Z'), ANTANANARIVO)).toBe(180);
  });

  it('suit le changement d’heure là où il existe', () => {
    // Paris : +02:00 en août, +01:00 en janvier. Une table figée aurait faux la
    // moitié de l'année.
    expect(offsetInTenant(new Date('2026-08-26T11:30:00.000Z'), PARIS)).toBe(120);
    expect(offsetInTenant(new Date('2026-01-15T11:30:00.000Z'), PARIS)).toBe(60);
  });

  it('écrit une saisie civile avec l’offset de l’établissement', () => {
    expect(offsetDateTimeInTenant('2026-08-26', '14:30', ANTANANARIVO)).toBe(
      '2026-08-26T14:30:00+03:00',
    );
    expect(offsetDateTimeInTenant('2026-08-26', '14:30', PARIS)).toBe('2026-08-26T14:30:00+02:00');
    expect(offsetDateTimeInTenant('2026-01-15', '14:30', PARIS)).toBe('2026-01-15T14:30:00+01:00');
  });

  it('produit un instant que l’on relit à la même heure civile', () => {
    // La seule propriété qui compte vraiment : ce que l'opérateur a tapé est ce
    // que le planning réaffichera. Le trajet passe par UTC, et il doit revenir.
    for (const timeZone of [ANTANANARIVO, PARIS] as const) {
      const written = offsetDateTimeInTenant('2026-08-26', '14:30', timeZone);
      const back = tenantFields(new Date(written).toISOString(), timeZone);

      expect(back).toEqual({ date: '2026-08-26', time: '14:30' });
    }
  });

  it('ramène un instant UTC aux champs des contrôles date et heure', () => {
    // 11 h 30 UTC = 14 h 30 au salon d'Antananarivo.
    expect(tenantFields('2026-08-26T11:30:00.000Z', ANTANANARIVO)).toEqual({
      date: '2026-08-26',
      time: '14:30',
    });
    // Et le passage de minuit se fait dans le calendrier du salon, pas dans UTC.
    expect(tenantFields('2026-08-25T22:00:00.000Z', ANTANANARIVO)).toEqual({
      date: '2026-08-26',
      time: '01:00',
    });
  });
});

describe('le récapitulatif calculé', () => {
  it('dérive la fin et l’heure de libération de la prestation', () => {
    expect(summarize(service(), '14:30')).toEqual({
      startTime: '14:30',
      endTime: '15:30',
      bufferMinutes: 15,
      freeAtTime: '15:45',
      durationMinutes: 60,
    });
  });

  it('n’invente rien d’une heure illisible', () => {
    expect(summarize(service(), '')).toBeNull();
    expect(summarize(service(), '25:00')).toBeNull();
    expect(minutesOfClock('14:30')).toBe(870);
    expect(minutesOfClock('14h30')).toBeNull();
  });

  it('replie sur la journée un soin qui déborde de minuit', () => {
    const late = summarize(service({ durationMinutes: 120, bufferAfterMinutes: 0 }), '23:30');

    expect(late?.endTime).toBe('01:30');
  });
});

describe('ce que le pied du tiroir propose', () => {
  it('n’offre le solde que depuis un rendez-vous confirmé', () => {
    expect(deskStatusActions('confirmed').map((action) => action.status)).toEqual([
      'completed',
      'no_show',
    ]);
    // `pending → completed` n'est pas dans la table du contrat : un bouton qui y
    // mènerait ne rendrait qu'un 422.
    expect(deskStatusActions('pending')).toEqual([]);
    expect(deskStatusActions('completed')).toEqual([]);
    expect(deskStatusActions('no_show')).toEqual([]);
  });

  it('ne laisse déplacer que ce qui n’est pas soldé', () => {
    expect(isReschedulable('pending')).toBe(true);
    expect(isReschedulable('confirmed')).toBe(true);
    expect(isReschedulable('completed')).toBe(false);
    expect(isReschedulable('cancelled')).toBe(false);
  });
});

describe('les refus, et ce qu’ils veulent dire à l’opérateur', () => {
  it('reconnaît le créneau perdu sous concurrence', () => {
    expect(isSlotConflict('SLOT_NO_LONGER_AVAILABLE')).toBe(true);
    expect(isSlotConflict('CONFLICT')).toBe(true);
    expect(isSlotConflict('NOT_FOUND')).toBe(false);

    expect(deskFailureMessage('SLOT_NO_LONGER_AVAILABLE', 'peu importe')).toBe(
      SLOT_CONFLICT_MESSAGE,
    );
  });

  it('nomme la route absente plutôt que de recracher le cadre HTTP', () => {
    expect(deskFailureMessage('HTTP_404', 'Cannot POST /api/v1/appointments')).toBe(
      DESK_ROUTE_MISSING_MESSAGE,
    );
    expect(deskFailureMessage('NOT_FOUND', 'introuvable')).toBe(DESK_ROUTE_MISSING_MESSAGE);
  });

  it('laisse passer tel quel un refus que l’API a su formuler', () => {
    expect(deskFailureMessage('SLOT_OUTSIDE_WORKING_HOURS', 'Le salon est fermé.')).toBe(
      'Le salon est fermé.',
    );
  });
});

/**
 * Le report par glisser-déposer (#51), côté calcul.
 *
 * Ce qui se joue ici et nulle part ailleurs : le lâcher est une **journée civile
 * et une heure civile du salon**, l'API attend un instant à offset explicite, et
 * l'écran doit afficher le bloc à sa nouvelle place sans attendre la réponse.
 * Trois conversions à ne pas rater, dont deux qui ne se verraient pas à l'œil.
 */
describe('le report par glisser-déposer', () => {
  const HASINA = { id: 'staff-hasina', displayName: 'Hasina' };
  const TIANA = { id: 'staff-tiana', displayName: 'Tiana' };

  /** 09:00 – 10:00 au salon d'Antananarivo, le mercredi 26 août 2026. */
  function moved(status: AppointmentStatus = 'confirmed'): Appointment {
    return {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      status,
      client: { id: 'client-1', firstName: 'Rina', lastName: 'Andriamana' },
      staff: HASINA,
      service: {
        id: 'service-1',
        name: 'Massage suédois',
        durationMinutes: 60,
        price: { amountMinor: 3500, currency: 'EUR' },
      },
      startsAt: '2026-08-26T06:00:00.000Z',
      endsAt: '2026-08-26T07:00:00.000Z',
      price: { amountMinor: 3500, currency: 'EUR' },
      createdAt: '2026-08-01T08:00:00.000Z',
    };
  }

  it('convertit le créneau visé avec le fuseau du salon, jamais celui du navigateur', () => {
    const move = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );

    // Le corps part en ISO 8601 avec l'offset de l'établissement, comme
    // `offsetDateTimeSchema` l'exige.
    expect(move?.request.startsAt).toBe('2026-08-26T14:30:00+03:00');
    expect(move?.request.staffId).toBe(HASINA.id);
    // Et l'état optimiste est stocké en UTC, comme tout instant du produit.
    expect(move?.optimistic.startsAt).toBe('2026-08-26T11:30:00.000Z');
  });

  it('conserve la durée du rendez-vous déplacé', () => {
    const move = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );

    // Un report ne change pas la prestation, donc ne change pas sa durée : une
    // heure avant, une heure après.
    expect(move?.optimistic.endsAt).toBe('2026-08-26T12:30:00.000Z');
    expect(move?.optimistic.id).toBe(moved().id);
  });

  it('signale le changement de praticien, et lui seul', () => {
    const sameStaff = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );
    const otherStaff = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: TIANA },
      ANTANANARIVO,
    );

    expect(sameStaff?.changesStaff).toBe(false);
    expect(otherStaff?.changesStaff).toBe(true);
    expect(otherStaff?.optimistic.staff).toEqual(TIANA);
  });

  it('garde le praticien du rendez-vous quand la colonne n’en désigne aucun', () => {
    // Vue semaine : une colonne est une journée de toute l'équipe. Rien à
    // confirmer, et rien à envoyer — le serveur garde le praticien d'origine.
    const move = planDeskMove(
      moved(),
      { day: '2026-08-28', time: '09:00', staff: null },
      ANTANANARIVO,
    );

    expect(move?.changesStaff).toBe(false);
    expect(move?.optimistic.staff).toEqual(HASINA);
    expect(move?.request).toEqual({ startsAt: '2026-08-28T09:00:00+03:00' });
  });

  it('ne déplace pas ce qui est soldé', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      expect(
        planDeskMove(
          moved(status),
          { day: '2026-08-26', time: '14:30', staff: HASINA },
          ANTANANARIVO,
        ),
      ).toBeNull();
    }
  });

  it('ne rend rien d’un lâcher qui ne déplace rien', () => {
    // Même praticien, même heure : envoyer le report réécrirait l'agenda —
    // identifiant neuf, avis de déplacement — pour un geste sans effet.
    expect(
      planDeskMove(moved(), { day: '2026-08-26', time: '09:00', staff: HASINA }, ANTANANARIVO),
    ).toBeNull();
  });
});

describe('le retour arrière, et ce qu’il annonce', () => {
  const previous: Appointment = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'confirmed',
    client: { id: 'client-1', firstName: 'Rina', lastName: 'Andriamana' },
    staff: { id: 'staff-hasina', displayName: 'Hasina' },
    service: {
      id: 'service-1',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: '2026-08-26T06:00:00.000Z',
    endsAt: '2026-08-26T07:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-08-01T08:00:00.000Z',
  };

  it('dit l’heure d’origine à l’heure du salon', () => {
    expect(deskMoment(previous.startsAt, ANTANANARIVO)).toBe('mercredi 26 août à 09:00');
  });

  it('traite le créneau perdu comme un cas normal, pas comme une panne', () => {
    const refusal = moveRefusal(previous, ANTANANARIVO, 'SLOT_NO_LONGER_AVAILABLE', 'peu importe');

    expect(refusal.tone).toBe('warning');
    expect(refusal.title).toContain('remis en place');
    // Les deux choses que l'opérateur doit lire : où le rendez-vous est revenu,
    // et pourquoi il n'a pas pu aller ailleurs.
    expect(refusal.body).toContain(
      'Le rendez-vous de Rina Andriamana est resté le mercredi 26 août à 09:00',
    );
    expect(refusal.body).toContain('chez Hasina');
    expect(refusal.body).toContain(MOVE_CONFLICT_MESSAGE);
  });

  it('reprend le refus de l’API quand il n’est pas passager', () => {
    const refusal = moveRefusal(
      previous,
      ANTANANARIVO,
      'SLOT_OUTSIDE_WORKING_HOURS',
      'Hasina ne travaille pas à cette heure-là.',
    );

    expect(refusal.tone).toBe('danger');
    expect(refusal.body).toContain('Hasina ne travaille pas à cette heure-là.');
  });

  it('lit un 404 comme un rendez-vous disparu, jamais comme une route absente', () => {
    // `POST /appointments/:id/reschedule` est servie depuis #464 : sur un
    // report, `NOT_FOUND` ne peut plus vouloir dire que l'API ne sait pas
    // déplacer. Annoncer « le formulaire est complet, l'enregistrement suivra »
    // sur un glisser-déposer promettrait un enregistrement qui ne viendra pas.
    for (const code of ['NOT_FOUND', 'HTTP_404']) {
      const refusal = moveRefusal(previous, ANTANANARIVO, code, 'Cannot POST …');

      expect(refusal.tone).toBe('danger');
      expect(refusal.body).toContain(MOVE_GONE_MESSAGE);
      expect(refusal.body).not.toContain(DESK_ROUTE_MISSING_MESSAGE);
    }
  });
});
