/**
 * Réservation invitée — coordonnées, normalisation E.164, réponse du tunnel (#45).
 *
 * Les deux premiers critères d'acceptation de l'issue se vérifient ici et nulle
 * part ailleurs : le formulaire du front n'a pas de règle propre, il applique ce
 * schéma. Une régression de ce fichier est une régression du formulaire.
 */

import { normalizeToE164 } from '../common/identifiers';
import {
  bookGuestAppointmentRequestSchema,
  bookedAppointmentSchema,
  guestContactSchema,
} from '../schemas/appointment';

describe('normalizeToE164', () => {
  it.each([
    ['+261341234567', '+261341234567'],
    ['+261 34 12 345 67', '+261341234567'],
    ['+261-34-12-345-67', '+261341234567'],
    ['00261341234567', '+261341234567'],
    ['  +261 34 12 345 67  ', '+261341234567'],
  ])('normalise « %s »', (input, expected) => {
    expect(normalizeToE164(input)).toBe(expected);
  });

  it.each([
    // Numéro national : le pays manque, et le deviner enverrait le SMS ailleurs.
    ['0341234567'],
    ['341234567'],
    // Un indicatif ne commence pas par zéro.
    ['+0261341234567'],
    // Quinze chiffres significatifs au plus (UIT-T E.164).
    ['+2613412345678901'],
    // Une lettre n'est pas un chiffre, même dans un numéro « vanity ».
    ['+261 34 SPA 4567'],
    [''],
    ['+'],
  ])('refuse « %s »', (input) => {
    expect(normalizeToE164(input)).toBeNull();
  });
});

describe('guestContactSchema', () => {
  const contact = {
    firstName: '  Camille ',
    lastName: 'Rakoto',
    email: '  Camille@Example.TEST ',
    phone: '+261 34 12 345 67',
  };

  it('élague, canonise l’e-mail et normalise le téléphone', () => {
    expect(guestContactSchema.parse(contact)).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '+261341234567',
    });
  });

  it('accepte l’absence de téléphone — l’e-mail est le canal obligatoire', () => {
    const { phone: _phone, ...withoutPhone } = contact;

    expect(guestContactSchema.parse(withoutPhone)).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
    });
  });

  it('nomme le champ en défaut plutôt que de rendre un refus global', () => {
    const result = guestContactSchema.safeParse({ ...contact, phone: '0341234567' });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(['phone']);
  });

  it('refuse un prénom vide une fois élagué', () => {
    expect(guestContactSchema.safeParse({ ...contact, firstName: '   ' }).success).toBe(false);
  });

  it('refuse un champ inconnu — un mot de passe n’a rien à faire ici', () => {
    expect(
      guestContactSchema.safeParse({ ...contact, password: 'motdepassetreslong' }).success,
    ).toBe(false);
  });
});

describe('bookGuestAppointmentRequestSchema', () => {
  const request = {
    serviceId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21',
    startsAt: '2026-09-01T11:00:00+02:00',
    client: {
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
    },
  };

  it('normalise l’instant de début en UTC', () => {
    expect(bookGuestAppointmentRequestSchema.parse(request).startsAt).toBe(
      '2026-09-01T09:00:00.000Z',
    );
  });

  it('accepte l’omission de staffId — c’est « premier disponible »', () => {
    expect(bookGuestAppointmentRequestSchema.parse(request)).not.toHaveProperty('staffId');
  });

  it('refuse un clientId — le tunnel public ne réserve pas au nom d’un autre', () => {
    expect(
      bookGuestAppointmentRequestSchema.safeParse({
        ...request,
        clientId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22',
      }).success,
    ).toBe(false);
  });

  it('refuse une date-heure nue, dont le fuseau ne pourrait qu’être deviné', () => {
    expect(
      bookGuestAppointmentRequestSchema.safeParse({ ...request, startsAt: '2026-09-01T11:00:00' })
        .success,
    ).toBe(false);
  });
});

describe('bookedAppointmentSchema', () => {
  const response = {
    id: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21',
    status: 'PENDING',
    serviceId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22',
    staffId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b23',
    clientId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b24',
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };

  it('ramène le statut du fil au vocabulaire du contrat', () => {
    expect(bookedAppointmentSchema.parse(response).status).toBe('pending');
  });

  it('ramène l’auteur d’annulation de la même façon', () => {
    const cancelled = bookedAppointmentSchema.parse({
      ...response,
      status: 'CANCELLED',
      cancelledAt: '2026-08-27T14:32:10.000Z',
      cancelledBy: 'CLIENT',
    });

    expect(cancelled.cancelledBy).toBe('client');
  });

  it('refuse un statut hors énumération plutôt que de le laisser passer', () => {
    expect(bookedAppointmentSchema.safeParse({ ...response, status: 'ARCHIVED' }).success).toBe(
      false,
    );
  });

  it('refuse un instant porteur d’offset — la sortie n’a qu’un référentiel', () => {
    expect(
      bookedAppointmentSchema.safeParse({ ...response, startsAt: '2026-09-01T11:00:00+02:00' })
        .success,
    ).toBe(false);
  });
});
