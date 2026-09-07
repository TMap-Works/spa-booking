/**
 * La frontière de la réservation invitée est **celle du contrat** (#404).
 *
 * ## Ce que cette suite prouve, et ce qu'elle ne prouve plus
 *
 * Elle ne prouve **pas** que deux écritures d'une même règle sont d'accord :
 * c'était l'objet de `guest-contract.spec.ts`, supprimé par #404 parce qu'il n'y
 * a plus qu'une écriture. La reprendre reviendrait à recopier
 * `packages/shared/src/__tests__/guest-booking.spec.ts` de ce côté-ci du
 * dépôt — c'est-à-dire à recréer le doublon que la substitution supprime.
 *
 * Elle prouve le **câblage**, qui est ce que l'ADR 0008 laisse à la charge de
 * l'appelant : que la route est bien montée sur `bookGuestAppointmentRequestSchema`,
 * et non sur une classe DTO devenue muette. Un contrôleur qui aurait gardé
 * `@Body() body: BookAppointmentDto` compilerait, passerait ses tests unitaires,
 * et laisserait le `ValidationPipe` global vider le corps de tous ses champs —
 * la classe n'ayant plus aucun décorateur `class-validator` à mettre sur sa
 * liste blanche.
 *
 * Quatre cas y suffisent, un par propriété que la substitution déplace :
 * la stricture, la normalisation, la règle du téléphone, la version d'UUID.
 * Au-delà, on réécrit les tests du contrat à la main.
 */

import { BadRequestException } from '@nestjs/common';

import { type BookAppointmentBody, bookAppointmentBody } from '../dto/book-appointment.dto';

const SERVICE_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21';
const CLIENT_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceId: SERVICE_ID,
    startsAt: '2026-09-01T11:00:00+02:00',
    client: {
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
    },
    ...overrides,
  };
}

/** Le corps validé, tel que le contrôleur le recevrait. */
function accepted(raw: Record<string, unknown>): BookAppointmentBody {
  return bookAppointmentBody.transform(raw) as BookAppointmentBody;
}

/** `true` si la frontière laisse passer ce corps. */
function accepts(raw: Record<string, unknown>): boolean {
  try {
    bookAppointmentBody.transform(raw);

    return true;
  } catch {
    return false;
  }
}

describe('la frontière de POST /public/:tenantSlug/appointments', () => {
  it('normalise ce que le contrat normalise — adresse et instant', () => {
    const parsed = accepted(
      body({
        client: {
          firstName: '  Camille ',
          lastName: 'Rakoto',
          email: '  Camille@Example.TEST ',
        },
      }),
    );

    expect(parsed.client.firstName).toBe('Camille');
    expect(parsed.client.email).toBe('camille@example.test');
    // `offsetDateTimeSchema` ramène l'instant en UTC **à la frontière** : passé
    // ce point, plus aucune couche n'a à se demander dans quel référentiel elle
    // lit un horodatage.
    expect(parsed.startsAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('refuse un champ inconnu — c’est le `.strict()` du contrat qui tient la porte', () => {
    // `tenantId` est le champ dont l'absence est une propriété d'isolation
    // (tenant-isolation §2) ; `clientId` est celui qui ferait réserver au nom
    // d'un autre depuis le tunnel public.
    expect(accepts(body({ tenantId: SERVICE_ID }))).toBe(false);
    expect(accepts(body({ clientId: CLIENT_ID }))).toBe(false);
    expect(accepts(body({ price: { amountMinor: 1, currency: 'EUR' } }))).toBe(false);
  });

  describe('téléphone — l’écart de #314 refermé sur l’E.164', () => {
    it('normalise un numéro international écrit avec des séparateurs', () => {
      const parsed = accepted(
        body({
          client: {
            firstName: 'Camille',
            lastName: 'Rakoto',
            email: 'camille@example.test',
            phone: '+261 34 12 345 67',
          },
        }),
      );

      // Le DTO conservait la saisie. C'est ce numéro-ci que la chaîne SMS
      // compose, et il n'a plus qu'une écriture possible — donc une seule clé de
      // déduplication d'envoi.
      expect(parsed.client.phone).toBe('+261341234567');
    });

    it('refuse un numéro national, dont le pays n’est déductible de rien', () => {
      // Le DTO l'acceptait. Deviner l'indicatif produirait un numéro
      // syntaxiquement valide et faux — un rappel envoyé à quelqu'un d'autre.
      expect(
        accepts(
          body({
            client: {
              firstName: 'Camille',
              lastName: 'Rakoto',
              email: 'camille@example.test',
              phone: '0341234567',
            },
          }),
        ),
      ).toBe(false);
    });
  });

  it('refuse un identifiant qui n’est pas une v4 — l’écart de #403 refermé', () => {
    expect(accepts(body({ serviceId: '2b0f3a1c-6a4d-1a2e-9d3b-8f7c1e5a4b21' }))).toBe(false);
    expect(accepts(body({ staffId: '00000000-0000-0000-0000-000000000000' }))).toBe(false);
  });

  it('refuse en 400, avec le corps que `DomainExceptionFilter` sert en VALIDATION_ERROR', () => {
    let caught: unknown = null;

    try {
      bookAppointmentBody.transform(body({ serviceId: 'pas-un-uuid' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: ['serviceId : identifiant attendu au format UUID v4'],
    });
  });
});
