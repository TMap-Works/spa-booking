/**
 * La frontière de la réservation publique est **celle du contrat** (#404).
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
 * Quatre cas y suffisent, un par propriété que la substitution déplace : la
 * stricture, la normalisation de l'instant, le consentement et la version
 * d'UUID. Au-delà, on réécrit les tests du contrat à la main.
 *
 * ## Ce que #1222 a retiré d'ici, et où la règle vit maintenant
 *
 * Le **téléphone**. Cette suite tenait le câblage du pays de l'établissement
 * (#1028) parce que la demande portait des coordonnées, et que leur numéro était
 * le seul champ du corps à dépendre du salon. La demande n'en porte plus : le
 * pipe est redevenu un `ZodValidationPipe` ordinaire, et la règle E.164 n'a plus
 * qu'un appelant — le formulaire de coordonnées du tunnel, monté sur
 * `guestContactSchemaFor`, dont `packages/shared/src/__tests__/phone.spec.ts`
 * exerce la règle.
 */

import { BadRequestException } from '@nestjs/common';

import { type BookAppointmentBody, BookAppointmentBodyPipe } from '../dto/book-appointment.dto';

const SERVICE_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21';
const CLIENT_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceId: SERVICE_ID,
    startsAt: '2026-09-01T11:00:00+02:00',
    // L'accord au traitement des données, obligatoire depuis #790 : c'est le
    // corps d'un tunnel qui a fait cocher la case, et le seul que cette
    // frontière laisse passer. Les cas qui l'omettent ou le refusent le disent
    // par `overrides`.
    dataConsent: true,
    ...overrides,
  };
}

/** La frontière, telle que le contrôleur la monte. */
const frontier = BookAppointmentBodyPipe;

/** Le corps validé, tel que le contrôleur le recevrait. */
function accepted(raw: Record<string, unknown>): BookAppointmentBody {
  return frontier.transform(raw);
}

/** `true` si la frontière laisse passer ce corps. */
function accepts(raw: Record<string, unknown>): boolean {
  try {
    frontier.transform(raw);

    return true;
  } catch {
    return false;
  }
}

describe('la frontière de POST /public/:tenantSlug/appointments', () => {
  it('normalise ce que le contrat normalise — l’instant de début', () => {
    // `offsetDateTimeSchema` ramène l'instant en UTC **à la frontière** : passé
    // ce point, plus aucune couche n'a à se demander dans quel référentiel elle
    // lit un horodatage.
    expect(accepted(body()).startsAt).toBe('2026-09-01T09:00:00.000Z');
  });

  it('refuse un champ inconnu — c’est le `.strict()` du contrat qui tient la porte', () => {
    // `tenantId` est le champ dont l'absence est une propriété d'isolation
    // (tenant-isolation §2) ; `clientId` est celui qui ferait réserver au nom
    // d'un autre depuis le tunnel public.
    expect(accepts(body({ tenantId: SERVICE_ID }))).toBe(false);
    expect(accepts(body({ clientId: CLIENT_ID }))).toBe(false);
    expect(accepts(body({ price: { amountMinor: 1, currency: 'EUR' } }))).toBe(false);
  });

  /**
   * Le champ retiré par #1222, et la seule chose qui le tient : la stricture.
   *
   * Il n'y a aucun contrôle à écrire pour refuser `client` — il suffit qu'aucun
   * champ ne porte ce nom. Le cas est ici parce que c'est la propriété que le
   * ticket livre : un appelant qui l'envoie croit désigner une cliente, et la
   * seule réponse honnête est un refus.
   */
  it('refuse des coordonnées — la cliente vient du jeton, pas du corps', () => {
    expect(
      accepts(
        body({
          client: { firstName: 'Camille', lastName: 'Rakoto', email: 'camille@example.test' },
        }),
      ),
    ).toBe(false);
  });

  /**
   * Le câblage du consentement — ce que cette suite existe pour tenir (#790).
   *
   * Elle ne revérifie pas la règle, qui est celle de `dataConsentSchema` et que
   * `packages/shared/src/__tests__/guest-booking.spec.ts` exerce. Elle vérifie
   * que **cette route-ci** est bien montée dessus : c'est exactement ce que son
   * en-tête annonce pour la version d'UUID, et c'est le seul endroit où un pipe
   * monté sur un schéma trop permissif se verrait.
   */
  describe('le consentement au traitement des données', () => {
    it('refuse un corps qui ne le porte pas', () => {
      const { dataConsent: _absent, ...sansConsentement } = body();

      expect(accepts(sansConsentement)).toBe(false);
    });

    it('refuse un consentement refusé, et ne réserve donc pas', () => {
      expect(accepts(body({ dataConsent: false }))).toBe(false);
    });

    it('laisse passer l’accord tel quel — c’est le service qui l’horodate', () => {
      expect(accepted(body()).dataConsent).toBe(true);
    });

    it('refuse une date de consentement envoyée par l’appelant', () => {
      expect(accepts(body({ dataConsentAt: '2026-09-01T09:00:00.000Z' }))).toBe(false);
    });

    it('nomme le champ dans son refus, plutôt que de le taire', () => {
      let message = '';
      try {
        frontier.transform(body({ dataConsent: false }));
      } catch (error) {
        message = JSON.stringify((error as BadRequestException).getResponse());
      }

      // Le message remonte jusqu'au formulaire : « Invalid literal value,
      // expected true » se lit par un développeur, pas par une cliente. C'est ce
      // que l'en-tête de `dataConsentSchema` motive.
      expect(message).toContain('dataConsent');
      expect(message).not.toContain('Invalid literal');
    });
  });

  it('refuse un identifiant qui n’est pas une v4 — l’écart de #403 refermé', () => {
    expect(accepts(body({ serviceId: '2b0f3a1c-6a4d-1a2e-9d3b-8f7c1e5a4b21' }))).toBe(false);
    expect(accepts(body({ staffId: '00000000-0000-0000-0000-000000000000' }))).toBe(false);
  });

  it('refuse en 400, le corps que `DomainExceptionFilter` sert en VALIDATION_ERROR', () => {
    let caught: unknown = null;

    try {
      frontier.transform(body({ serviceId: 'pas-un-uuid' }));
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
