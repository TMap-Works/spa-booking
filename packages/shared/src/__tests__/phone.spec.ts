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
 * 3. **Le pays par défaut** (#824). Ce qu'un numéro national devient, et ce
 *    qu'il reste quand aucun pays n'est connu. C'est la moitié de la règle que
 *    ni #66 ni #404 n'avaient à leur disposition : le pays de l'établissement.
 *
 * Un cas de la seconde partie qui échoue n'est donc pas forcément une
 * régression : c'est peut-être la migration de #404 qui commence. Elle se fait
 * alors d'un seul tenant — schéma de requête, DTO `class-validator` d'`apps/api`
 * et formulaire d'`apps/web` —, et ces cas se retournent avec elle.
 */

import {
  e164PhoneSchema,
  e164PhoneSchemaFor,
  normalizeToE164,
  phoneSchema,
  storedPhoneSchema,
} from '../common/identifiers';
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

  it('refuse un numéro national — sans pays, le compléter reviendrait à en deviner un', () => {
    expect(e164PhoneSchema.safeParse(NATIONAL).success).toBe(false);
  });
});

/**
 * Le pays par défaut — le sixième critère de #824, cas par cas.
 *
 * Ce qui se verrouille ici est la différence entre les deux bibliothèques de
 * validation possibles : un **motif** juge la syntaxe d'E.164 et laisse passer
 * `+12345678901234`, qui n'est le numéro de personne ; `isValidPhoneNumber`
 * confronte le numéro au plan de numérotation de son pays — longueur *et*
 * préfixe d'attribution. C'est la seule vérification qui distingue un numéro
 * joignable d'une suite de chiffres bien formée, et c'est elle qui décide si un
 * rappel J-1 part ou se perd.
 */
describe('e164PhoneSchemaFor — le pays par défaut complète le national', () => {
  it.each([
    // France : les trois écritures d'un même mobile.
    ['FR', '06 12 34 56 78', '+33612345678'],
    ['FR', '+33 6 12 34 56 78', '+33612345678'],
    ['FR', '0033612345678', '+33612345678'],
    // Madagascar : mobile national et international.
    ['MG', '034 12 345 67', '+261341234567'],
    ['MG', '+261 34 12 345 67', '+261341234567'],
    // Un fixe, et non un mobile : le canal SMS n'en fera rien, mais une fiche
    // cliente a le droit de porter le numéro du domicile — le refuser aurait
    // été refuser la moitié de la clientèle d'un salon de quartier.
    ['FR', '01 42 33 44 55', '+33142334455'],
    ['MG', '020 22 123 45', '+261202212345'],
  ])('%s : « %s » devient %s', (country, input, expected) => {
    expect(e164PhoneSchemaFor(country).parse(input)).toBe(expected);
  });

  it.each([
    // Trop court pour le plan français, alors que le motif d'E.164 s'en
    // contenterait.
    ['FR', '06 12 34'],
    // Un mobile malgache lu avec le pays français : le préfixe `034` n'est
    // attribué à personne en France. C'est exactement ce qu'un motif ne voit
    // pas, et ce qui produirait un SMS envoyé à un inconnu.
    ['FR', '0349999'],
    // Syntaxiquement E.164, attribué à aucun pays.
    ['FR', '+12345678901234'],
    // Une lettre n'est pas un chiffre, même dans un numéro « vanity ».
    ['MG', '+261 34 SPA 4567'],
    ['MG', ''],
    ['MG', '+'],
  ])('%s : refuse « %s »', (country, input) => {
    expect(e164PhoneSchemaFor(country).safeParse(input).success).toBe(false);
  });

  it('ignore le pays par défaut quand le numéro est déjà international', () => {
    // Le pays sert à **compléter**, jamais à contredire : un numéro malgache
    // saisi dans un salon français reste malgache.
    expect(e164PhoneSchemaFor('FR').parse('+261341234567')).toBe('+261341234567');
  });

  it.each([
    // Le pays est lu en base, où il n'est pas encore contraint en casse, et sur
    // une colonne nullable. Aucune de ces trois formes ne doit lever.
    [undefined],
    [null],
    ['ZZ'],
  ])('sans pays exploitable (%s), un national est refusé plutôt que deviné', (country) => {
    expect(normalizeToE164(NATIONAL, country)).toBeNull();
  });

  it('accepte un code pays en minuscules — la colonne n’en garantit pas la casse', () => {
    expect(normalizeToE164('0612345678', 'fr')).toBe('+33612345678');
  });

  it('dit comment corriger, et le message dépend de ce qu’on sait du pays', () => {
    const avecPays = e164PhoneSchemaFor('FR').safeParse('06 12 34');
    const sansPays = e164PhoneSchemaFor().safeParse('06 12 34');

    // Avec un pays, le national est une correction possible : l'annoncer évite
    // d'envoyer quelqu'un chercher un indicatif dont il n'a pas besoin.
    expect(avecPays.success === false && avecPays.error.issues[0]?.message).toContain(
      'format national',
    );
    // Sans pays, seule la forme internationale est complétable — promettre
    // autre chose enverrait corriger un numéro que rien ne pourra accepter.
    // L'exemple cité est donc international, et aucune forme nationale n'est
    // proposée.
    expect(sansPays.success === false && sansPays.error.issues[0]?.message).toContain(
      'format international',
    );
    expect(sansPays.success === false && sansPays.error.issues[0]?.message).not.toContain(
      'format national',
    );
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
        dataConsent: true,
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
    '$nom accepte un numéro national — c’est le serveur qui le complète (#824)',
    ({ parse }) => {
      // Le contrat décrit la **forme** de la saisie, et s'arrête là : le pays
      // qui permet de compléter ce numéro est `tenants.country_code`, une donnée
      // de requête qu'un schéma monté à l'amorçage ne voit pas. Le dernier mot
      // appartient donc au service (`apps/api/src/modules/identity/phone.ts`),
      // qui instancie `e164PhoneSchemaFor(pays)`.
      //
      // Resserrer ces schémas-ci sur `e164PhoneSchema` — sans pays, donc — ne
      // serait pas un progrès : ce serait refuser dans le navigateur le
      // « 06 12 34 56 78 » que le serveur sait maintenant accepter, c'est-à-dire
      // reproduire exactement le défaut que #824 corrige.
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
        // Toujours émise depuis #844, `null` quand aucune préférence.
        locale: null,
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
