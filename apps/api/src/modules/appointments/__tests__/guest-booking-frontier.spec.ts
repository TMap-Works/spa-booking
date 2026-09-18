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

import type { BookAppointmentBody } from '../dto/book-appointment.dto';
import { bookAppointmentPipe } from './appointments.doubles';

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
    // L'accord au traitement des données, obligatoire depuis #790 : c'est le
    // corps d'un tunnel qui a fait cocher la case, et le seul que cette
    // frontière laisse passer. Les cas qui l'omettent ou le refusent le disent
    // par `overrides`.
    dataConsent: true,
    ...overrides,
  };
}

/**
 * La frontière, telle qu'elle est montée pour un établissement **sans pays** —
 * la variante par défaut, et celle qui vaut pour tous les cas de cette suite qui
 * ne parlent pas de téléphone.
 */
const frontier = bookAppointmentPipe();

/** Le corps validé, tel que le contrôleur le recevrait. */
async function accepted(
  raw: Record<string, unknown>,
  countryCode: string | null = null,
): Promise<BookAppointmentBody> {
  return bookAppointmentPipe(countryCode).transform(raw);
}

/** `true` si la frontière laisse passer ce corps. */
async function accepts(
  raw: Record<string, unknown>,
  countryCode: string | null = null,
): Promise<boolean> {
  try {
    await bookAppointmentPipe(countryCode).transform(raw);

    return true;
  } catch {
    return false;
  }
}

/** Un corps complet dont seul le téléphone varie. */
function withPhone(phone: string): Record<string, unknown> {
  return {
    client: { firstName: 'Camille', lastName: 'Rakoto', email: 'camille@example.test', phone },
  };
}

describe('la frontière de POST /public/:tenantSlug/appointments', () => {
  it('normalise ce que le contrat normalise — adresse et instant', async () => {
    const parsed = await accepted(
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

  it('refuse un champ inconnu — c’est le `.strict()` du contrat qui tient la porte', async () => {
    // `tenantId` est le champ dont l'absence est une propriété d'isolation
    // (tenant-isolation §2) ; `clientId` est celui qui ferait réserver au nom
    // d'un autre depuis le tunnel public.
    expect(await accepts(body({ tenantId: SERVICE_ID }))).toBe(false);
    expect(await accepts(body({ clientId: CLIENT_ID }))).toBe(false);
    expect(await accepts(body({ price: { amountMinor: 1, currency: 'EUR' } }))).toBe(false);

    // Et la garde tient **quel que soit le pays** : c'est la forme du schéma
    // qu'elle juge, et la fabrique ne fait varier que le contenu d'un champ.
    expect(await accepts(body({ tenantId: SERVICE_ID }), 'FR')).toBe(false);
  });

  /**
   * Le câblage du consentement — ce que cette suite existe pour tenir (#790).
   *
   * Elle ne revérifie pas la règle, qui est celle de `dataConsentSchema` et que
   * `packages/shared/src/__tests__/guest-booking.spec.ts` exerce. Elle vérifie
   * que **cette route-ci** est bien montée dessus : c'est exactement ce que son
   * en-tête annonce pour le téléphone et pour la version d'UUID, et c'est le
   * seul endroit où un pipe monté sur un schéma trop permissif se verrait.
   */
  describe('le consentement au traitement des données', () => {
    it('refuse un corps qui ne le porte pas', async () => {
      const { dataConsent: _absent, ...sansConsentement } = body();

      expect(await accepts(sansConsentement)).toBe(false);
    });

    it('refuse un consentement refusé, et ne réserve donc pas', async () => {
      expect(await accepts(body({ dataConsent: false }))).toBe(false);
    });

    it('laisse passer l’accord tel quel — c’est le service qui l’horodate', async () => {
      expect((await accepted(body())).dataConsent).toBe(true);
    });

    it('refuse une date de consentement envoyée par l’appelant', async () => {
      expect(await accepts(body({ dataConsentAt: '2026-09-01T09:00:00.000Z' }))).toBe(false);
    });

    it('nomme le champ dans son refus, plutôt que de le taire', async () => {
      let message = '';
      try {
        await frontier.transform(body({ dataConsent: false }));
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

  /**
   * Le téléphone — l'écart de #314 refermé sur l'E.164, puis celui de #1028
   * refermé sur le **pays de l'établissement**.
   *
   * Ce que cette suite tient ici n'est toujours pas la règle — elle est dans
   * `e164PhoneSchemaFor`, et `packages/shared/src/__tests__/phone.spec.ts`
   * l'exerce — mais le **câblage** : que le pipe de cette route-ci instancie
   * bien la fabrique du contrat avec le pays qu'on lui fournit, au lieu d'un
   * schéma figé. C'est le seul endroit où un pipe resté sur la variante sans
   * pays se verrait.
   */
  describe('téléphone — l’E.164 et le pays de l’établissement', () => {
    it('normalise un numéro international écrit avec des séparateurs', async () => {
      const parsed = await accepted(body(withPhone('+261 34 12 345 67')));

      // Le DTO conservait la saisie. C'est ce numéro-ci que la chaîne SMS
      // compose, et il n'a plus qu'une écriture possible — donc une seule clé de
      // déduplication d'envoi.
      expect(parsed.client.phone).toBe('+261341234567');
    });

    it('accepte et complète un numéro national avec le pays de l’établissement', async () => {
      // Le cas de la capture de #824 : « 06 12 34 56 78 » sur un salon français,
      // refusé par ce tunnel alors que `/auth/register` l'accepte sur le même
      // établissement. C'est le même numéro qui est désormais enregistré des deux
      // côtés.
      expect((await accepted(body(withPhone('06 12 34 56 78')), 'FR')).client.phone).toBe(
        '+33612345678',
      );

      // Et le salon malgache, d'où vient le cas « refusé » de cette suite : même
      // conduite, autre plan de numérotation.
      expect((await accepted(body(withPhone('034 12 345 67')), 'MG')).client.phone).toBe(
        '+261341234567',
      );
      expect((await accepted(body(withPhone('0341234567')), 'MG')).client.phone).toBe(
        '+261341234567',
      );
    });

    it('laisse passer l’international inchangé, même sous un pays par défaut', async () => {
      // Le pays ne **remplace** rien : il ne sert qu'à compléter ce qui n'a pas
      // d'indicatif. Un numéro malgache saisi chez un salon français reste
      // malgache — c'est la cliente en voyage, et son rappel doit lui parvenir.
      expect((await accepted(body(withPhone('+261341234567')), 'FR')).client.phone).toBe(
        '+261341234567',
      );
    });

    it('refuse un numéro national quand l’établissement n’a pas de pays', async () => {
      // Le cas du salon qui n'a pas saisi son adresse. Deviner l'indicatif
      // produirait un numéro syntaxiquement valide et faux — un rappel envoyé à
      // quelqu'un d'autre.
      expect(await accepts(body(withPhone('0341234567')))).toBe(false);
      expect(await accepts(body(withPhone('06 12 34 56 78')))).toBe(false);
    });

    it('refuse un numéro que le pays ne permet pas de compléter', async () => {
      // Le pays n'est pas un blanc-seing : trop court pour tout plan de
      // numérotation, le numéro reste refusé.
      expect(await accepts(body(withPhone('06 12 34')), 'FR')).toBe(false);
    });
  });

  it('refuse un identifiant qui n’est pas une v4 — l’écart de #403 refermé', async () => {
    expect(await accepts(body({ serviceId: '2b0f3a1c-6a4d-1a2e-9d3b-8f7c1e5a4b21' }))).toBe(false);
    expect(await accepts(body({ staffId: '00000000-0000-0000-0000-000000000000' }))).toBe(false);
  });

  it('refuse en 400, le corps que `DomainExceptionFilter` sert en VALIDATION_ERROR', async () => {
    let caught: unknown = null;

    try {
      await frontier.transform(body({ serviceId: 'pas-un-uuid' }));
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
