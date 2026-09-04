/**
 * Le contrat de la réservation invitée, tenu des deux côtés (#314).
 *
 * ## Ce que cette suite prouve, et que rien d'autre ne prouve
 *
 * La demande de réservation du tunnel public est décrite **deux fois** : par
 * `bookGuestAppointmentRequestSchema` / `guestContactSchema` dans
 * `packages/shared/src/schemas/appointment.ts`, que le formulaire de #45
 * applique, et par `BookAppointmentDto` / `GuestContactDto` ici, que le
 * `ValidationPipe` applique. Ce doublon est délibéré et temporaire — `apps/api`
 * ne dépend pas encore de `@spa/shared`, c'est ce que le quatrième critère de
 * #314 attend de #26 — mais tant qu'il dure, **rien n'empêche les deux moitiés
 * de diverger en silence**, et une divergence ne se manifesterait que chez la
 * cliente : un formulaire qui laisse passer ce que l'API refuse, ou l'inverse.
 *
 * Les fixtures sont donc **littéralement celles** de
 * `packages/shared/src/__tests__/guest-booking.spec.ts`, recopiées et non
 * importées. C'est la convention déjà tenue par `date-time.validation.spec.ts`
 * pour la frontière des dates : les deux suites exercent les mêmes chaînes de
 * part et d'autre, et c'est ce qui rend visible le jour où l'une des deux
 * bougerait seule.
 *
 * Le pipe monté ici est celui d'`app.module.ts`, `whitelist` et
 * `forbidNonWhitelisted` compris : la stricture du DTO n'est pas dans le DTO,
 * elle est dans le pipe, et c'est elle qui répond au `.strict()` du contrat.
 *
 * ## Ce que l'écriture de cette suite a trouvé
 *
 * Une divergence, refermée : `emailSchema` ne bornait **aucune** des deux
 * longueurs que la RFC 5321 impose et que validator.js applique — 254 octets
 * pour l'adresse, 64 pour la partie locale. Le contrat était donc plus permissif
 * que la route qu'il décrit — le sens dangereux — et huit tunnels frontend
 * l'auraient découvert un par un, en 400. Voir l'en-tête d'`emailSchema`, qui
 * porte aussi ce que ces bornes ne couvrent pas.
 *
 * ## L'écart restant sur ce DTO, et il est assumé
 *
 * `phone`. Le contrat le veut en E.164 et **normalise** ; le DTO accepte un
 * format libre borné et **conserve** la saisie. L'écart est orienté dans le sens
 * sûr — le contrat étant le plus strict, un formulaire qui valide avec lui ne
 * produit jamais une requête que cette route refuse — et il est exercé ici comme
 * un fait délibéré. Le jour où quelqu'un le refermera, ce sont ces deux cas qui
 * échoueront, et c'est exactement ce qu'on veut d'eux.
 */

import { ValidationPipe } from '@nestjs/common';

import { BookAppointmentDto, GuestContactDto, toGuestContact } from '../dto/book-appointment.dto';

/** Le pipe tel qu'`app.module.ts` le monte pour toute l'application. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

const SERVICE_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21';
const STAFF_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b23';
const CLIENT_ID = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22';

/**
 * Les bornes du contrat — `packages/shared/src/constants/limits.ts`, recopiées.
 *
 * Une borne plus large ici que là-bas ferait accepter une saisie que le
 * formulaire refuse ; plus étroite, elle ferait refuser une saisie qu'il
 * propose. Les deux se voient sur ces trois nombres.
 */
const NAME_MAX_LENGTH = 80;
const EMAIL_MAX_LENGTH = 320;
const LONG_TEXT_MAX_LENGTH = 2000;

/** Les coordonnées de `guest-booking.spec.ts`, au caractère près. */
const CONTACT = {
  firstName: '  Camille ',
  lastName: 'Rakoto',
  email: '  Camille@Example.TEST ',
  phone: '+261 34 12 345 67',
};

/** La demande de `guest-booking.spec.ts`, au caractère près. */
const REQUEST = {
  serviceId: SERVICE_ID,
  startsAt: '2026-09-01T11:00:00+02:00',
  client: {
    firstName: 'Camille',
    lastName: 'Rakoto',
    email: 'camille@example.test',
  },
};

/** Fait franchir au corps brut le pipe global, puis le DTO. */
async function validate<T>(type: new () => T, body: unknown): Promise<T> {
  return (await pipe.transform(body, { type: 'body', metatype: type })) as T;
}

/** `true` si la frontière laisse passer ce corps. */
async function accepts(type: new () => unknown, body: unknown): Promise<boolean> {
  try {
    await validate(type, body);

    return true;
  } catch {
    return false;
  }
}

/** Une chaîne de `length` caractères — pour éprouver une borne au caractère près. */
function filled(length: number): string {
  return 'a'.repeat(length);
}

describe('GuestContactDto — concordance avec guestContactSchema', () => {
  it('élague et canonise l’e-mail, comme le contrat', async () => {
    const dto = await validate(GuestContactDto, { ...CONTACT });

    expect(dto.firstName).toBe('Camille');
    expect(dto.lastName).toBe('Rakoto');
    expect(dto.email).toBe('camille@example.test');
  });

  it('accepte l’absence de téléphone — l’e-mail est le canal obligatoire', async () => {
    const { phone: _phone, ...withoutPhone } = CONTACT;

    expect(await accepts(GuestContactDto, withoutPhone)).toBe(true);
  });

  it('refuse un prénom vide une fois élagué', async () => {
    expect(await accepts(GuestContactDto, { ...CONTACT, firstName: '   ' })).toBe(false);
  });

  it('refuse un champ inconnu — un mot de passe n’a rien à faire ici', async () => {
    expect(await accepts(GuestContactDto, { ...CONTACT, password: 'motdepassetreslong' })).toBe(
      false,
    );
  });

  it.each([
    ['firstName', NAME_MAX_LENGTH],
    ['lastName', NAME_MAX_LENGTH],
  ])('borne %s à la longueur du contrat', async (field, max) => {
    expect(await accepts(GuestContactDto, { ...CONTACT, [field]: filled(max) })).toBe(true);
    expect(await accepts(GuestContactDto, { ...CONTACT, [field]: filled(max + 1) })).toBe(false);
  });

  it('refuse une adresse plus longue que la borne du contrat', async () => {
    // `EMAIL_MAX_LENGTH` porte sur l'adresse entière. Un domaine long tient la
    // partie locale sous sa propre borne, éprouvée juste en dessous.
    const long = `camille@${filled(EMAIL_MAX_LENGTH)}.test`;

    expect(await accepts(GuestContactDto, { ...CONTACT, email: long })).toBe(false);
  });

  /**
   * La borne de la partie locale — 64 octets, RFC 5321 §4.5.3.1.1 (#314).
   *
   * C'est `@IsEmail()` qui l'applique ici, et le contrat ne l'appliquait **pas**
   * avant #314 : `.email()` de Zod s'arrête à la longueur totale. Le contrat
   * était donc plus permissif que la route qu'il décrit — le sens dangereux de
   * l'écart, celui où le formulaire annonce bonne une adresse que l'API refuse.
   * `emailSchema` porte désormais la même borne ; ces deux cas sont la moitié
   * API de la paire, et `guest-booking.spec.ts` en tient l'autre.
   */
  it.each([
    [64, true],
    [65, false],
  ])('borne la partie locale à 64 octets — %i caractères : %s', async (length, accepted) => {
    const email = `${filled(length)}@example.test`;

    expect(await accepts(GuestContactDto, { ...CONTACT, email })).toBe(accepted);
  });

  it('refuse une adresse mal formée', async () => {
    expect(await accepts(GuestContactDto, { ...CONTACT, email: 'camille@' })).toBe(false);
  });

  describe('téléphone — l’écart assumé avec le contrat', () => {
    it('accepte l’E.164 que le contrat produit, sans le transformer', async () => {
      const dto = await validate(GuestContactDto, { ...CONTACT, phone: '+261341234567' });

      expect(dto.phone).toBe('+261341234567');
    });

    it('conserve la saisie là où le contrat la normaliserait', async () => {
      const dto = await validate(GuestContactDto, { ...CONTACT });

      // `e164PhoneSchema` rendrait `+261341234567`. Le tunnel de #45 valide avec
      // le contrat et envoie donc déjà la forme normalisée ; c'est un appelant
      // qui ne serait pas ce front qui poserait cette chaîne-ci.
      expect(dto.phone).toBe('+261 34 12 345 67');
    });

    it('accepte un numéro national, que le contrat refuse faute de pays déductible', async () => {
      expect(await accepts(GuestContactDto, { ...CONTACT, phone: '0341234567' })).toBe(true);
    });

    it('refuse tout de même une lettre — un numéro « vanity » n’est pas composable', async () => {
      expect(await accepts(GuestContactDto, { ...CONTACT, phone: '+261 34 SPA 4567' })).toBe(false);
    });
  });
});

describe('BookAppointmentDto — concordance avec bookGuestAppointmentRequestSchema', () => {
  it('accepte la demande du contrat telle quelle', async () => {
    const dto = await validate(BookAppointmentDto, { ...REQUEST });

    expect(dto.serviceId).toBe(SERVICE_ID);
    expect(dto.startsAt).toBe('2026-09-01T11:00:00+02:00');
    expect(dto.client.email).toBe('camille@example.test');
  });

  it('accepte l’omission de staffId — c’est « premier disponible »', async () => {
    const dto = await validate(BookAppointmentDto, { ...REQUEST });

    expect(dto.staffId).toBeUndefined();
  });

  it('accepte un staffId désigné', async () => {
    const dto = await validate(BookAppointmentDto, { ...REQUEST, staffId: STAFF_ID });

    expect(dto.staffId).toBe(STAFF_ID);
  });

  it('refuse un clientId — le tunnel public ne réserve pas au nom d’un autre', async () => {
    expect(await accepts(BookAppointmentDto, { ...REQUEST, clientId: CLIENT_ID })).toBe(false);
  });

  it('refuse une date-heure nue, dont le fuseau ne pourrait qu’être deviné', async () => {
    expect(await accepts(BookAppointmentDto, { ...REQUEST, startsAt: '2026-09-01T11:00:00' })).toBe(
      false,
    );
  });

  it('exige les coordonnées — sans elles, le serveur n’a personne à ficher', async () => {
    const { client: _client, ...withoutClient } = REQUEST;

    expect(await accepts(BookAppointmentDto, withoutClient)).toBe(false);
  });

  it('borne clientNote à la longueur du contrat', async () => {
    expect(
      await accepts(BookAppointmentDto, { ...REQUEST, clientNote: filled(LONG_TEXT_MAX_LENGTH) }),
    ).toBe(true);
    expect(
      await accepts(BookAppointmentDto, {
        ...REQUEST,
        clientNote: filled(LONG_TEXT_MAX_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it.each([
    // Le contrat ne les déclare pas ; le pipe les refuse. La fin se dérive de la
    // durée du catalogue et le prix vient du catalogue, jamais du navigateur.
    ['endsAt', '2026-09-01T12:00:00+02:00'],
    ['price', { amountMinor: 1, currency: 'EUR' }],
    // Le champ dont l'absence est une propriété d'isolation (tenant-isolation §2).
    ['tenantId', SERVICE_ID],
  ])('refuse %s, que le contrat ne déclare pas non plus', async (field, value) => {
    expect(await accepts(BookAppointmentDto, { ...REQUEST, [field]: value })).toBe(false);
  });
});

describe('toGuestContact — la traversée vers le domaine', () => {
  it('ramène l’absence de téléphone au `null` que la colonne accepte', async () => {
    const { phone: _phone, ...withoutPhone } = CONTACT;
    const dto = await validate(GuestContactDto, withoutPhone);

    expect(toGuestContact(dto)).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: null,
    });
  });

  it('ne porte que les quatre champs du contrat', async () => {
    const contact = toGuestContact(await validate(GuestContactDto, { ...CONTACT }));

    expect(Object.keys(contact).sort()).toEqual(['email', 'firstName', 'lastName', 'phone']);
  });
});
