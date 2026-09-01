import { beforeEach, describe, expect, it } from 'vitest';

import {
  emptyBookingDraft,
  readBookingDraft,
  reachableStep,
  writeBookingDraft,
  type BookingDraft,
} from '@/lib/booking/draft';

const SLUG = 'maison-lotus';

function draftWith(patch: Partial<BookingDraft>): BookingDraft {
  return { ...emptyBookingDraft(), ...patch };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('survie de l’étape à un rafraîchissement', () => {
  it('relit ce qui a été écrit', () => {
    const draft = draftWith({
      step: 'coordonnees',
      serviceId: '22222222-2222-4222-8222-222222222222',
      startsAt: '2026-09-01T06:00:00.000Z',
      contact: {
        firstName: 'Camille',
        lastName: 'Rakoto',
        email: 'camille@example.test',
        phone: '+261341234567',
        clientNote: '',
      },
    });

    writeBookingDraft(SLUG, draft);

    expect(readBookingDraft(SLUG)).toEqual(draft);
  });

  it('ne mélange pas deux établissements', () => {
    writeBookingDraft(SLUG, draftWith({ step: 'coordonnees' }));

    expect(readBookingDraft('autre-salon')).toEqual(emptyBookingDraft());
  });

  it('repart de zéro sur un brouillon illisible plutôt que de planter', () => {
    window.sessionStorage.setItem(`spa.booking.${SLUG}`, '{ pas du JSON');

    expect(readBookingDraft(SLUG)).toEqual(emptyBookingDraft());
  });

  it('repart de zéro sur un brouillon d’une forme inconnue', () => {
    window.sessionStorage.setItem(`spa.booking.${SLUG}`, JSON.stringify({ step: 'paiement' }));

    expect(readBookingDraft(SLUG)).toEqual(emptyBookingDraft());
  });
});

describe('reachableStep', () => {
  it('ramène à la première étape incomplète', () => {
    expect(reachableStep(draftWith({ step: 'recapitulatif' }))).toBe('prestation');
    expect(
      reachableStep(
        draftWith({ step: 'recapitulatif', serviceId: '22222222-2222-4222-8222-222222222222' }),
      ),
    ).toBe('creneau');
  });

  it('laisse l’étape en place quand tout ce qu’elle exige est là', () => {
    expect(
      reachableStep(
        draftWith({
          step: 'coordonnees',
          serviceId: '22222222-2222-4222-8222-222222222222',
          startsAt: '2026-09-01T06:00:00.000Z',
        }),
      ),
    ).toBe('coordonnees');
  });

  it('n’affiche pas une confirmation sans rendez-vous à confirmer', () => {
    expect(
      reachableStep(
        draftWith({
          step: 'confirmation',
          serviceId: '22222222-2222-4222-8222-222222222222',
          startsAt: '2026-09-01T06:00:00.000Z',
        }),
      ),
    ).toBe('recapitulatif');
  });
});
