/**
 * Le téléphone dans le contrat partagé — plancher de saisie et carte des règles (#66).
 *
 * Deux choses se verrouillent ici, et nulle part ailleurs.
 *
 * 1. **Le plancher de `phoneSchema`.** Le motif du format libre décrit la forme
 *    d'un numéro, pas sa substance : `+`, `0` et `+ ()` le satisfont sans porter
 *    un seul chiffre composable. Un tel champ traversait la saisie, la fiche
 *    cliente et la file d'envoi pour n'être reconnu inexploitable qu'au moment
 *    de composer — trop tard pour le redemander à qui le connaissait.
 *
 * 2. **La carte des règles.** `phoneSchema` et `e164PhoneSchema` coexistent
 *    délibérément, et la répartition entre les surfaces est une décision (voir
 *    l'en-tête d'`e164PhoneSchema`), pas un reste d'histoire. Ces cas la
 *    verrouillent surface par surface : basculer l'une d'elles fait échouer un
 *    cas nommé. Sans cela, la migration se ferait à moitié — le contrat
 *    resserré, le formulaire d'`apps/web` non — et le refus s'afficherait en
 *    bloc en tête de page au lieu du champ, ce que la skill web-frontend §4
 *    interdit.
 *
 * Un cas de la seconde partie qui échoue n'est donc pas forcément une
 * régression : c'est peut-être la migration de #404 qui commence. Elle se fait
 * alors d'un seul tenant — schéma de requête, DTO `class-validator` d'`apps/api`
 * et formulaire d'`apps/web` —, et ces cas se retournent avec elle.
 */

import { e164PhoneSchema, phoneSchema, storedPhoneSchema } from '../common/identifiers';
import { PHONE_MIN_DIGITS } from '../constants/limits';
import {
  createCustomerRequestSchema,
  customerSummarySchema,
  updateCustomerRequestSchema,
} from '../schemas/crm';
import {
  createStaffAccountRequestSchema,
  registerRequestSchema,
  sessionUserSchema,
  updateProfileRequestSchema,
  userSchema,
} from '../schemas/identity';
import { updateTenantRequestSchema } from '../schemas/tenant';

/** Numéro national : valide au comptoir, non normalisable sans deviner un pays. */
const NATIONAL = '0341234567';

describe('phoneSchema — le plancher de saisie', () => {
  it.each([
    ['+261 34 12 345 67'],
    ['+261341234567'],
    [NATIONAL],
    // Séparateurs d'un numéro dicté au comptoir : ils ne comptent pas dans les
    // chiffres, mais ils ne disqualifient pas la saisie.
    ['020 (22) 123-45'],
    // Le plancher exact : trois chiffres, séparateurs exclus.
    ['123'],
  ])('accepte « %s »', (input) => {
    expect(phoneSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    // Les trois formes que le motif seul laissait passer, et qui ne portent
    // aucun chiffre composable.
    ['+'],
    ['()'],
    ['+ ()'],
    // Un chiffre isolé, puis deux : sous le plancher d'E.164 lui-même.
    ['0'],
    ['12'],
    // Des séparateurs qui font le compte de caractères, jamais celui des
    // chiffres — c'est bien sur les chiffres que le plancher porte.
    ['+1-2-'],
  ])('refuse « %s »', (input) => {
    expect(phoneSchema.safeParse(input).success).toBe(false);
  });

  it('conserve la saisie telle qu’elle a été tapée, espaces intérieurs compris', () => {
    expect(phoneSchema.parse('  +261 34 12 345 67  ')).toBe('+261 34 12 345 67');
  });

  it('nomme le nombre de chiffres attendu dans son message', () => {
    const result = phoneSchema.safeParse('+1');

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain(
      String(PHONE_MIN_DIGITS),
    );
  });
});

describe('e164PhoneSchema — la frontière du canal SMS', () => {
  it('ramène les écritures internationales à une seule forme', () => {
    expect(e164PhoneSchema.parse('+261 34 12 345 67')).toBe('+261341234567');
    expect(e164PhoneSchema.parse('00261341234567')).toBe('+261341234567');
  });

  it('refuse un numéro national — le compléter reviendrait à deviner un pays', () => {
    expect(e164PhoneSchema.safeParse(NATIONAL).success).toBe(false);
  });
});

/**
 * Les surfaces d'entrée du contrat qui portent un numéro, et ce qu'elles en
 * font. `parse` reçoit le numéro et rend le verdict du schéma sur un corps par
 * ailleurs valide.
 */
const FREE_FORM_SURFACES = [
  {
    // Fiche cliente saisie au comptoir : le front-desk recopie ce qu'une cliente
    // dicte, y compris un numéro national qu'elle est seule à savoir compléter.
    nom: 'createCustomerRequestSchema',
    parse: (phone: string) =>
      createCustomerRequestSchema.safeParse({
        email: 'camille@example.test',
        firstName: 'Camille',
        lastName: 'Rakoto',
        phone,
      }),
  },
  {
    nom: 'updateCustomerRequestSchema',
    parse: (phone: string) => updateCustomerRequestSchema.safeParse({ phone }),
  },
  {
    // Inscription et profil : mêmes formulaires publics, même arbitrage.
    nom: 'registerRequestSchema',
    parse: (phone: string) =>
      registerRequestSchema.safeParse({
        email: 'camille@example.test',
        password: 'un-mot-de-passe-assez-long',
        firstName: 'Camille',
        lastName: 'Rakoto',
        phone,
      }),
  },
  {
    nom: 'updateProfileRequestSchema',
    parse: (phone: string) => updateProfileRequestSchema.safeParse({ phone }),
  },
  {
    nom: 'createStaffAccountRequestSchema',
    parse: (phone: string) =>
      createStaffAccountRequestSchema.safeParse({
        email: 'praticienne@example.test',
        role: 'staff',
        firstName: 'Hanta',
        lastName: 'Rasoa',
        phone,
      }),
  },
  {
    // Numéro de l'établissement : affiché à la cliente, jamais composé par SNS.
    // Le normaliser retirerait les espaces d'un numéro fait pour être lu.
    nom: 'updateTenantRequestSchema.contactPhone',
    parse: (phone: string) => updateTenantRequestSchema.safeParse({ contactPhone: phone }),
  },
] as const;

describe('carte des règles téléphoniques', () => {
  it('le tunnel invité est la seule saisie normalisée en E.164', () => {
    // La règle y est appliquée par `guestContactSchema` (#45), dont
    // `guest-booking.spec.ts` couvre le détail. Ce qui se verrouille ici est la
    // frontière elle-même : le schéma transforme, il ne se contente pas de valider.
    expect(e164PhoneSchema.parse('+261 34 12 345 67')).not.toBe('+261 34 12 345 67');
  });

  it.each(FREE_FORM_SURFACES)(
    '$nom conserve le format libre — un numéro national y est accepté',
    ({ parse }) => {
      expect(parse(NATIONAL).success).toBe(true);
    },
  );

  it.each(FREE_FORM_SURFACES)('$nom applique tout de même le plancher de chiffres', ({ parse }) => {
    expect(parse('+').success).toBe(false);
  });
});

/**
 * Le stock, et pourquoi le plancher s'y arrête.
 *
 * Toute réponse de l'API portant un numéro est validée par ces schémas dans
 * `apps/web/lib/api-client.ts`, qui lève un `INTERNAL_ERROR` et fait échouer la
 * page entière au moindre refus. Les numéros écrits avant #66 — `+` était
 * accepté par le formulaire, et l'est toujours par les DTO `class-validator` de
 * l'API — doivent donc continuer à se lire, sans quoi durcir la saisie rendrait
 * illisibles la fiche cliente, la page publique du salon et jusqu'à la réponse
 * de connexion.
 */
const STORED_SURFACES = [
  {
    nom: 'customerSummarySchema.phone',
    parse: (phone: string) =>
      customerSummarySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        firstName: 'Camille',
        lastName: 'Rakoto',
        email: 'camille@example.test',
        phone,
        isActive: true,
      }),
  },
  {
    nom: 'sessionUserSchema.phone',
    parse: (phone: string) =>
      sessionUserSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'camille@example.test',
        role: 'client',
        firstName: 'Camille',
        lastName: 'Rakoto',
        phone,
      }),
  },
  {
    nom: 'userSchema.phone',
    parse: (phone: string) =>
      userSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'camille@example.test',
        role: 'staff',
        firstName: 'Hanta',
        lastName: 'Rasoa',
        phone,
        isActive: true,
        createdAt: '2026-09-07T08:00:00Z',
      }),
  },
] as const;

describe('le plancher ne remonte pas jusqu’au stock', () => {
  it('storedPhoneSchema accepte ce que phoneSchema refuse désormais', () => {
    expect(storedPhoneSchema.safeParse('+').success).toBe(true);
    expect(phoneSchema.safeParse('+').success).toBe(false);
  });

  it('storedPhoneSchema garde le motif — une saisie qui n’a jamais été un numéro reste refusée', () => {
    expect(storedPhoneSchema.safeParse('appelle-moi').success).toBe(false);
  });

  it.each(STORED_SURFACES)('$nom lit un numéro antérieur au plancher', ({ parse }) => {
    expect(parse('+').success).toBe(true);
  });
});
