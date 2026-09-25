/**
 * Ce qu'un champ obligatoire laissé vide affiche — #613, repris par #1232.
 *
 * ## Pourquoi cette suite existe
 *
 * `nameSchema`, `displayNameSchema` et `submittedPasswordSchema` étaient des
 * `.min(1)` **sans message** : Zod rendait alors son libellé par défaut, « String
 * must contain at least 1 character(s) », sur huit écrans par ailleurs
 * entièrement français — à côté d'« adresse e-mail invalide » dans le même
 * formulaire. Un message manquant ne se voit ni au typage ni à la compilation :
 * le schéma refuse bien ce qu'il doit refuser, seule la phrase est étrangère.
 *
 * ## Ce que #1232 change à ce qu'elle mesure
 *
 * #613 avait refermé l'écart en écrivant la phrase **dans le schéma**. Le remède
 * portait sa propre rechute : un message posé sur un check l'emporte sur toute
 * carte d'erreurs, par conception de zod, si bien que la phrase française
 * s'affichait telle quelle sous les écrans anglais — et qu'aucune traduction ne
 * pouvait la rattraper.
 *
 * Les schémas ne portent donc plus de phrase, et cette suite ne mesure plus une
 * phrase **française** : elle mesure que le refus se lit dans la langue qu'on
 * demande, et que ce n'est jamais le libellé brut de zod. C'est le premier
 * critère d'acceptation de #1232, pris au niveau du contrat.
 *
 * ## Ce qu'elle tient — et ce qu'elle ne peut pas tenir
 *
 * Ce qui est tenu ici, ce sont les **primitives** : trois schémas, et le refus
 * qu'ils posent. Trois des huit écrans montent bien le contrat tel quel par
 * `zodResolver` (tunnel de réservation, inscription, connexion) ; les cinq
 * autres montent leur propre schéma de saisie — `profileFormSchema`,
 * `settingsFormSchema`, `serviceFormSchema`, `categoryFormSchema` et
 * `inviteStaffAccountRequestSchema` (`apps/web/lib/admin/staff-contract.ts`) —
 * parce que la chaîne vide y est licite là où un champ est facultatif. Ces
 * cinq-là n'affichent la phrase attendue ici que **parce qu'ils reprennent
 * `nameSchema` et `displayNameSchema`** au lieu de réécrire un `.min(1)`.
 *
 * Les cas « écran » ci-dessous rejouent donc le contrat d'entrée de chaque
 * geste, pas le schéma monté par le composant : ils prouvent que le contrat
 * refuse dans la langue demandée, et non que tel composant a bien passé la
 * carte. Ce second maillon appartient aux tests de `apps/web`.
 *
 * ## Le plancher et le plafond
 *
 * Les deux bornes sont couvertes. Un `.max()` sans phrase a le même angle mort
 * qu'un `.min()` sans phrase, et il est atteignable : les champs ne portent pas
 * d'attribut `maxLength` et les formulaires sont en `noValidate`, si bien qu'un
 * nom collé depuis une autre fiche sort une phrase étrangère sous son libellé.
 */

import type { z } from 'zod';

import { displayNameSchema, nameSchema, submittedPasswordSchema } from '../common/identifiers';
import {
  DISPLAY_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../constants/limits';
import { validationPhrases, zodErrorMap } from '../errors/index';
import { LOCALES, type Locale } from '../locale/index';
import { guestContactSchema } from '../schemas/appointment';
import { createServiceCategoryRequestSchema, createServiceRequestSchema } from '../schemas/catalog';
import {
  createStaffAccountRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  updateProfileRequestSchema,
} from '../schemas/identity';
import { updateTenantRequestSchema } from '../schemas/tenant';

/** Un schéma quelconque du contrat, vu comme une frontière de validation. */
type Contrat = z.ZodType<unknown, z.ZodTypeDef, unknown>;

/** Le premier message posé par `schema`, dans la langue demandée. */
function premierRefus(schema: Contrat, saisie: unknown, locale: Locale): string | undefined {
  const refus = schema.safeParse(saisie, { errorMap: zodErrorMap(locale) });

  return refus.success ? undefined : refus.error.issues[0]?.message;
}

/** Message posé par `schema` sur `champ`, ou `undefined` si le champ passe. */
function messageDuChamp(
  schema: Contrat,
  saisie: unknown,
  champ: string,
  locale: Locale,
): string | undefined {
  const refus = schema.safeParse(saisie, { errorMap: zodErrorMap(locale) });

  if (refus.success) {
    return undefined;
  }

  return refus.error.issues.find((issue) => issue.path[0] === champ)?.message;
}

describe('primitives de saisie obligatoire', () => {
  it.each([
    ['nameSchema', nameSchema],
    ['displayNameSchema', displayNameSchema],
    ['submittedPasswordSchema', submittedPasswordSchema],
  ])('%s refuse le vide dans la langue demandée', (_nom, schema) => {
    for (const locale of LOCALES) {
      expect(premierRefus(schema, '', locale)).toBe(validationPhrases(locale).required);
    }
  });

  it.each([
    ['nameSchema', nameSchema],
    ['displayNameSchema', displayNameSchema],
  ])('%s refuse de même une saisie qui n’est que des espaces', (_nom, schema) => {
    // `.trim()` s'applique avant le plancher : une saisie d'espaces arrive vide
    // au `.min(1)`, et doit y trouver le même message qu'un champ jamais touché.
    for (const locale of LOCALES) {
      expect(premierRefus(schema, '   ', locale)).toBe(validationPhrases(locale).required);
    }
  });

  it('ne rend jamais le libellé par défaut de zod', () => {
    // La garde de #613, reformulée : ce qui remontait à l'écran était « String
    // must contain at least 1 character(s) ». Le repli global de
    // `zod-messages.ts` couvre même l'appelant qui ne passe aucune langue.
    expect(nameSchema.safeParse('').error?.issues[0]?.message).not.toMatch(/String must contain/);
  });

  it('submittedPasswordSchema ne divulgue pas la politique de longueur', () => {
    // La doctrine de ce schéma interdit de distinguer « trop court » de « faux »
    // à la connexion, message de champ compris.
    expect(premierRefus(submittedPasswordSchema, '', 'fr')).not.toMatch(/caractères/);
    expect(premierRefus(submittedPasswordSchema, '', 'en')).not.toMatch(/characters/);
  });
});

describe('primitives de saisie trop longue', () => {
  it.each<readonly [string, Contrat, number]>([
    ['nameSchema', nameSchema, NAME_MAX_LENGTH],
    ['displayNameSchema', displayNameSchema, DISPLAY_NAME_MAX_LENGTH],
    ['submittedPasswordSchema', submittedPasswordSchema, PASSWORD_MAX_LENGTH],
  ])('%s nomme le plafond dans la langue demandée', (_nom, schema, borne) => {
    for (const locale of LOCALES) {
      // La borne est **interpolée** : « faites plus court » sans dire combien
      // oblige à tâtonner caractère par caractère.
      expect(premierRefus(schema, 'a'.repeat(borne + 1), locale)).toBe(
        validationPhrases(locale).tooLong(borne),
      );
    }
  });
});

describe('les huit écrans soumis à vide', () => {
  it.each<readonly [string, Contrat, Record<string, unknown>, readonly string[]]>([
    [
      'réservation — coordonnées de la cliente',
      guestContactSchema,
      { firstName: '', lastName: '', email: 'ida@exemple.test' },
      ['firstName', 'lastName'],
    ],
    [
      'inscription',
      registerRequestSchema,
      {
        email: 'ida@exemple.test',
        password: 'correct horse battery',
        firstName: '',
        lastName: '',
        // Coché : ce que cet écran mesure, c'est le message d'un champ laissé
        // vide, pas celui d'une case laissée décochée — qui a le sien (#880).
        dataConsent: true,
      },
      ['firstName', 'lastName'],
    ],
    [
      'coordonnées du compte',
      updateProfileRequestSchema,
      { firstName: '', lastName: '' },
      ['firstName', 'lastName'],
    ],
    [
      'connexion du back-office',
      loginRequestSchema,
      { email: 'ida@exemple.test', password: '' },
      ['password'],
    ],
    [
      'catalogue — nouvelle prestation',
      createServiceRequestSchema,
      { name: '', durationMinutes: 30, price: { amountMinor: 1000, currency: 'EUR' } },
      ['name'],
    ],
    ['catalogue — rubriques', createServiceCategoryRequestSchema, { name: '' }, ['name']],
    [
      'invitation du personnel',
      createStaffAccountRequestSchema,
      { email: 'ida@exemple.test', role: 'staff', firstName: '', lastName: '' },
      ['firstName', 'lastName'],
    ],
    ['réglages de l’établissement', updateTenantRequestSchema, { name: '' }, ['name']],
  ])('%s pose sur son champ un message dans les deux langues', (_ecran, schema, saisie, champs) => {
    for (const champ of champs) {
      for (const locale of LOCALES) {
        expect(messageDuChamp(schema, saisie, champ, locale)).toBe(
          validationPhrases(locale).required,
        );
      }
    }
  });

  it('ne dit pas la même chose en français et en anglais', () => {
    // Le quatrième critère de #1232, à la racine : deux langues, deux phrases.
    // Sans cela, la suite ci-dessus passerait encore avec un catalogue recopié.
    expect(validationPhrases('fr').required).not.toBe(validationPhrases('en').required);
  });
});
