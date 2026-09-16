import { beforeEach, describe, expect, it } from 'vitest';

import {
  bookingSearch,
  draftFromSearch,
  emptyBookingDraft,
  readBookingDraft,
  reachableStep,
  writeBookingDraft,
  type BookingDraft,
} from '@/lib/booking/draft';

const SLUG = 'maison-lotus';
const PRESTATION = '22222222-2222-4222-8222-222222222222';
const PRATICIEN = '44444444-4444-4444-8444-444444444444';
const CRENEAU = '2026-09-01T06:00:00.000Z';

const COORDONNEES = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261341234567',
  clientNote: '',
};

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
      serviceId: PRESTATION,
      startsAt: CRENEAU,
      contact: COORDONNEES,
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
    expect(reachableStep(draftWith({ step: 'recapitulatif', serviceId: PRESTATION }))).toBe(
      'creneau',
    );
  });

  it('laisse l’étape en place quand tout ce qu’elle exige est là', () => {
    expect(
      reachableStep(
        draftWith({
          step: 'coordonnees',
          serviceId: PRESTATION,
          startsAt: CRENEAU,
        }),
      ),
    ).toBe('coordonnees');
  });

  it('n’affiche pas une confirmation sans rendez-vous à confirmer', () => {
    expect(
      reachableStep(
        draftWith({
          step: 'confirmation',
          serviceId: PRESTATION,
          startsAt: CRENEAU,
        }),
      ),
    ).toBe('recapitulatif');
  });

  it('n’affiche pas un récapitulatif sans personne à qui écrire (#733)', () => {
    // C'est ce qu'ouvrirait un `?etape=recapitulatif` mis en favori puis rouvert
    // dans un onglet neuf : tout est là sauf la cliente, et « Confirmer »
    // partirait en 400.
    const sansCoordonnees = draftWith({
      step: 'recapitulatif',
      serviceId: PRESTATION,
      startsAt: CRENEAU,
    });

    expect(reachableStep(sansCoordonnees)).toBe('coordonnees');
    expect(reachableStep({ ...sansCoordonnees, contact: COORDONNEES })).toBe('recapitulatif');
  });
});

describe('la progression portée par l’URL (#733)', () => {
  it('écrit l’étape et les choix, jamais les coordonnées', () => {
    const search = bookingSearch(
      draftWith({
        step: 'recapitulatif',
        serviceId: PRESTATION,
        staffId: PRATICIEN,
        startsAt: CRENEAU,
        contact: COORDONNEES,
      }),
    );
    const params = new URLSearchParams(search);

    expect(params.get('etape')).toBe('recapitulatif');
    expect(params.get('prestation')).toBe(PRESTATION);
    expect(params.get('praticien')).toBe(PRATICIEN);
    expect(params.get('creneau')).toBe(CRENEAU);
    // Une URL se partage, se met en favori et finit dans les journaux des
    // serveurs qu'elle traverse : le nom et l'e-mail n'y entrent pas.
    expect(search).not.toContain('Camille');
    expect(search).not.toContain('camille@example.test');
    expect(search).not.toContain('261341234567');
  });

  it('n’écrit pas un choix qui n’a pas été fait', () => {
    // `praticien` absent vaut « premier disponible » (CDC §1.4), et une
    // prestation absente emporte ce qui n'a pas de sens sans elle.
    expect(bookingSearch(draftWith({ step: 'creneau', serviceId: PRESTATION }))).toBe(
      `?etape=creneau&prestation=${PRESTATION}`,
    );
    expect(bookingSearch(emptyBookingDraft())).toBe('?etape=prestation');
  });

  it('préserve les paramètres qui ne sont pas les siens', () => {
    const search = bookingSearch(
      draftWith({ step: 'creneau', serviceId: PRESTATION }),
      '?utm_source=insta&creneau=2026-01-01T00:00:00.000Z',
    );
    const params = new URLSearchParams(search);

    // L'attribution d'une campagne mène au tunnel ; le premier changement
    // d'étape l'effacerait si l'URL était refabriquée à neuf.
    expect(params.get('utm_source')).toBe('insta');
    // Le créneau, lui, nous appartient : il tombe avec le brouillon qui ne le
    // porte plus.
    expect(params.has('creneau')).toBe(false);
  });

  it('fait le tour : ce qui est écrit se relit', () => {
    const draft = draftWith({
      step: 'coordonnees',
      serviceId: PRESTATION,
      staffId: PRATICIEN,
      startsAt: CRENEAU,
    });

    expect(draftFromSearch(bookingSearch(draft), emptyBookingDraft())).toEqual(draft);
  });

  it('laisse les coordonnées au brouillon, qu’un retour arrière ne doit pas coûter', () => {
    const enCours = draftWith({
      step: 'coordonnees',
      serviceId: PRESTATION,
      startsAt: CRENEAU,
      contact: COORDONNEES,
    });

    expect(draftFromSearch(`?etape=creneau&prestation=${PRESTATION}`, enCours)).toEqual({
      ...enCours,
      step: 'creneau',
      startsAt: null,
    });
  });

  it('fait foi dès qu’elle porte une clé, plutôt que de mélanger deux parcours', () => {
    // Le lien d'une collègue, ouvert dans un onglet qui a déjà son brouillon :
    // ce que le lien ne dit pas n'a pas été choisi.
    const autre = draftFromSearch('?etape=prestation', draftWith({ serviceId: PRESTATION }));

    expect(autre.serviceId).toBeNull();
  });

  it('rend la main au brouillon quand l’URL ne dit rien du tunnel', () => {
    const stocke = draftWith({ step: 'creneau', serviceId: PRESTATION });

    expect(draftFromSearch('?utm_source=insta', stocke)).toEqual(stocke);
  });

  it('ignore une valeur bricolée plutôt que de la propager', () => {
    const relu = draftFromSearch(
      '?etape=paiement&prestation=pas-un-uuid&creneau=hier',
      emptyBookingDraft(),
    );

    expect(relu.step).toBe('prestation');
    expect(relu.serviceId).toBeNull();
    expect(relu.startsAt).toBeNull();
  });
});
