import type { BookedAppointment } from '@spa/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bookingSearch,
  contactAccountKey,
  draftForAccount,
  draftFromSearch,
  emptyBookingDraft,
  emptyContactDraft,
  readBookingDraft,
  reachableStep,
  writeBookingDraft,
  type BookingDraft,
} from '@/lib/booking/draft';

const SLUG = 'maison-lotus';
const PRESTATION = '22222222-2222-4222-8222-222222222222';
const PRATICIEN = '44444444-4444-4444-8444-444444444444';
const CRENEAU = '2026-09-01T06:00:00.000Z';
/** Le compte sous lequel `COORDONNEES` a été saisi (#1151). */
const COMPTE = 'camille@example.test';

const COORDONNEES = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261341234567',
  clientNote: '',
  // Des coordonnées « complètes » le sont depuis #734 : la case de consentement
  // de l'étape 4 conditionne le récapitulatif au même titre que le nom et
  // l'adresse. Le cas contraire est éprouvé par `booking-consent.test.tsx`.
  consent: true,
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
          contact: COORDONNEES,
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
    // Et par le même chemin : `?etape=confirmation` partagé retombe sur le
    // récapitulatif, qui n'a pas plus de destinataire pour autant.
    expect(reachableStep({ ...sansCoordonnees, step: 'confirmation' })).toBe('coordonnees');
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

/**
 * Le brouillon a un propriétaire, et change de mains avec le compte (#1151).
 *
 * `sessionStorage` meurt avec l'onglet, pas avec la session : entre les deux il
 * y a la place d'une déconnexion suivie d'une connexion sous un autre compte.
 * Ce que la campagne du 22/09/2026 a relevé, et ce que ces cas éprouvent, c'est
 * que les coordonnées de la première ne se présentent pas à la seconde.
 */
describe('les coordonnées appartiennent à un compte (#1151)', () => {
  const RENDEZ_VOUS: BookedAppointment = {
    id: '55555555-5555-4555-8555-555555555555',
    reference: 'RDV-8F3K-27',
    status: 'pending',
    serviceId: PRESTATION,
    staffId: PRATICIEN,
    clientId: '66666666-6666-4666-8666-666666666666',
    startsAt: CRENEAU,
    endsAt: CRENEAU,
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };

  /** Le brouillon de Camille, arrivée au bout du tunnel dans cet onglet. */
  function brouillonDeCamille(): BookingDraft {
    return draftWith({
      step: 'confirmation',
      serviceId: PRESTATION,
      staffId: PRATICIEN,
      startsAt: CRENEAU,
      contact: COORDONNEES,
      contactAccount: COMPTE,
      appointment: RENDEZ_VOUS,
    });
  }

  it('laisse le brouillon intact au compte qui l’a écrit', () => {
    const brouillon = brouillonDeCamille();

    expect(draftForAccount(brouillon, COMPTE)).toBe(brouillon);
  });

  it('rend les coordonnées et le rendez-vous de la cliente précédente', () => {
    // Le cas du ticket : déconnexion puis connexion sous un autre compte, dans
    // le même onglet. Rien de ce qui décrit *une personne* ne doit survivre.
    const repris = draftForAccount(brouillonDeCamille(), 'clara@example.test');

    expect(repris.contact).toEqual(emptyContactDraft());
    expect(repris.contactAccount).toBeNull();
    expect(repris.appointment).toBeNull();
  });

  it('garde la prestation, le praticien et le créneau, qui ne décrivent personne', () => {
    // Ils sont déjà dans l'URL, que `bookingSearchParams` écrit et qu'un lien
    // partage : les faire tomber ici ne les effacerait même pas.
    const repris = draftForAccount(brouillonDeCamille(), 'clara@example.test');

    expect(repris.serviceId).toBe(PRESTATION);
    expect(repris.staffId).toBe(PRATICIEN);
    expect(repris.startsAt).toBe(CRENEAU);
  });

  it('ramène à l’étape « Coordonnées » plutôt qu’au récapitulatif', () => {
    // La cliente qui vient de se connecter reprend le parcours de l'onglet là
    // où il en était — sur l'écran qui demande à qui écrire, cette fois le sien.
    expect(reachableStep(draftForAccount(brouillonDeCamille(), 'clara@example.test'))).toBe(
      'coordonnees',
    );
  });

  it('traite comme celui d’une autre un brouillon sans propriétaire', () => {
    // Celui d'une cliente qui avait la page ouverte au déploiement : la clé
    // n'existait pas encore, et rien ne dit à qui ces coordonnées sont. La
    // lecture prudente d'une donnée personnelle est de ne pas la montrer.
    const anterieur = draftWith({ step: 'coordonnees', contact: COORDONNEES });

    expect(draftForAccount(anterieur, COMPTE).contact).toEqual(emptyContactDraft());
  });

  it('les rend aussi à la déconnexion, et pas seulement au changement de compte', () => {
    expect(draftForAccount(brouillonDeCamille(), null).contact).toEqual(emptyContactDraft());
  });

  it('ne rend pas un brouillon sans propriétaire à une session sans adresse', () => {
    // Les deux `null` ne disent pas la même chose, et les confondre rouvrirait
    // la fuite : `contactAccountKey` rend `null` d'une présence sans adresse —
    // un cookie posé avant #1086, un champ que `presenceSchema` a replié sur
    // `''` — et le brouillon écrit sous cette présence porte `null` lui aussi.
    // Une égalité sèche représenterait ses coordonnées, son consentement et son
    // rendez-vous à la cliente suivante.
    const sansProprietaire = draftWith({
      step: 'confirmation',
      serviceId: PRESTATION,
      startsAt: CRENEAU,
      contact: COORDONNEES,
      appointment: RENDEZ_VOUS,
    });

    const repris = draftForAccount(sansProprietaire, null);

    expect(repris.contact).toEqual(emptyContactDraft());
    expect(repris.appointment).toBeNull();
  });

  it('ne fait pas d’une casse différente un changement de compte', () => {
    // `sessionStorage` se bricole à la main, et un brouillon d'une autre
    // version du tunnel a pu y laisser l'adresse telle que le compte la porte.
    const brouillon = draftWith({
      step: 'coordonnees',
      serviceId: PRESTATION,
      startsAt: CRENEAU,
      contact: COORDONNEES,
      contactAccount: ' Camille@Example.test ',
    });

    expect(draftForAccount(brouillon, COMPTE).contact).toEqual(COORDONNEES);
  });

  it('relit sans propriétaire un brouillon écrit avant le ticket, sans rien perdre d’autre', () => {
    // `.catch(null)` et non un champ requis : faire échouer tout le schéma
    // renverrait la cliente à la première étape en lui prenant son créneau.
    window.sessionStorage.setItem(
      `spa.booking.${SLUG}`,
      JSON.stringify({
        step: 'coordonnees',
        serviceId: PRESTATION,
        staffId: null,
        startsAt: CRENEAU,
        contact: COORDONNEES,
        appointment: null,
      }),
    );

    const relu = readBookingDraft(SLUG);

    expect(relu.contactAccount).toBeNull();
    expect(relu.serviceId).toBe(PRESTATION);
    expect(relu.startsAt).toBe(CRENEAU);
  });

  describe('la clé du compte', () => {
    it('ne distingue ni la casse ni les espaces de bord', () => {
      // Deux écritures du même cookie ne sont pas garanties identiques : une
      // différence de casse ferait tomber les coordonnées d'une cliente qui n'a
      // pourtant pas changé d'identité.
      expect(contactAccountKey('  Camille@Example.test ')).toBe(COMPTE);
    });

    it('ne fait pas un compte d’une adresse absente', () => {
      // Le cookie de présence accepte une adresse vide — celle d'un cookie posé
      // avant #1086. Deux comptes sans adresse ne sont pas le même compte.
      expect(contactAccountKey('')).toBeNull();
      expect(contactAccountKey(null)).toBeNull();
      expect(contactAccountKey(undefined)).toBeNull();
    });
  });
});
