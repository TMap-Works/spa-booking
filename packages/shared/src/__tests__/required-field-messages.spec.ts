/**
 * Ce qu'un champ obligatoire laissé vide affiche — #613.
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
 * ## Ce qu'elle tient — et ce qu'elle ne peut pas tenir
 *
 * Ce qui est tenu ici, ce sont les **primitives** : trois schémas, et le message
 * qu'ils posent. Trois des huit écrans montent bien le contrat tel quel par
 * `zodResolver` (tunnel de réservation, inscription, connexion) ; les cinq
 * autres montent leur propre schéma de saisie — `profileFormSchema`,
 * `settingsFormSchema`, `serviceFormSchema`, `categoryFormSchema` et
 * `inviteStaffAccountRequestSchema` (`apps/web/lib/admin/staff-contract.ts`) —
 * parce que la chaîne vide y est licite là où un champ est facultatif. Ces
 * cinq-là n'affichent la phrase écrite ici que **parce qu'ils reprennent
 * `nameSchema` et `displayNameSchema`** au lieu de réécrire un `.min(1)`.
 *
 * Les cas « écran » ci-dessous rejouent donc le contrat d'entrée de chaque
 * geste, pas le schéma monté par le composant : ils prouvent que le contrat
 * refuse en français, et non que tel composant l'a bien repris. Ce second
 * maillon appartient aux tests de `apps/web`.
 *
 * ## Le plancher et le plafond
 *
 * Les deux bornes sont couvertes. Un `.max()` sans message a le même défaut
 * qu'un `.min()` sans message, et il est atteignable : les champs ne portent pas
 * d'attribut `maxLength` et les formulaires sont en `noValidate`, si bien qu'un
 * nom collé depuis une autre fiche sort une phrase anglaise sous un libellé
 * français.
 */

import type { z } from 'zod';

import { displayNameSchema, nameSchema, submittedPasswordSchema } from '../common/identifiers';
import {
  DISPLAY_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../constants/limits';
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

const CHAMP_REQUIS = 'ce champ est obligatoire';
const MOT_DE_PASSE_REQUIS = 'mot de passe attendu';

/** Message posé par le schéma sur `champ`, ou `undefined` si le champ passe. */
function messageDuChamp(schema: Contrat, saisie: unknown, champ: string): string | undefined {
  const refus = schema.safeParse(saisie);

  if (refus.success) {
    return undefined;
  }

  return refus.error.issues.find((issue) => issue.path[0] === champ)?.message;
}

describe('primitives de saisie obligatoire', () => {
  it.each([
    ['nameSchema', nameSchema],
    ['displayNameSchema', displayNameSchema],
  ])('%s refuse le vide par une phrase française', (_nom, schema) => {
    const refus = schema.safeParse('');

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).toBe(CHAMP_REQUIS);
  });

  it.each([
    ['nameSchema', nameSchema],
    ['displayNameSchema', displayNameSchema],
  ])('%s refuse de même une saisie qui n’est que des espaces', (_nom, schema) => {
    // `.trim()` s'applique avant le plancher : une saisie d'espaces arrive vide
    // au `.min(1)`, et doit y trouver le même message qu'un champ jamais touché.
    const refus = schema.safeParse('   ');

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).toBe(CHAMP_REQUIS);
  });

  it('submittedPasswordSchema nomme ce qui est attendu', () => {
    const refus = submittedPasswordSchema.safeParse('');

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).toBe(MOT_DE_PASSE_REQUIS);
    // Rien de la politique de longueur : la doctrine de ce schéma interdit de la
    // divulguer à la connexion, message de champ compris.
    expect(refus.error?.issues[0]?.message).not.toMatch(/caractères/);
  });
});

describe('primitives de saisie trop longue', () => {
  it.each<readonly [string, Contrat, number]>([
    ['nameSchema', nameSchema, NAME_MAX_LENGTH],
    ['displayNameSchema', displayNameSchema, DISPLAY_NAME_MAX_LENGTH],
  ])('%s refuse le dépassement par une phrase française', (_nom, schema, borne) => {
    const refus = schema.safeParse('a'.repeat(borne + 1));

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).toBe(`ce champ fait au plus ${String(borne)} caractères`);
  });

  it('submittedPasswordSchema nomme le plafond', () => {
    // Le plancher se tait sur la politique, le plafond la nomme : c'est une
    // borne de coût argon2id, que le refus révèle de toute façon — et la même
    // phrase que `passwordSchema`, puisque c'est la même borne.
    const refus = submittedPasswordSchema.safeParse('m'.repeat(PASSWORD_MAX_LENGTH + 1));

    expect(refus.success).toBe(false);
    expect(refus.error?.issues[0]?.message).toBe(
      `le mot de passe fait au plus ${String(PASSWORD_MAX_LENGTH)} caractères`,
    );
  });
});

describe('les huit écrans soumis à vide', () => {
  it.each<readonly [string, Contrat, Record<string, unknown>, readonly string[], string]>([
    [
      'réservation — coordonnées de la cliente',
      guestContactSchema,
      { firstName: '', lastName: '', email: 'ida@exemple.test' },
      ['firstName', 'lastName'],
      CHAMP_REQUIS,
    ],
    [
      'inscription',
      registerRequestSchema,
      { email: 'ida@exemple.test', password: 'correct horse battery', firstName: '', lastName: '' },
      ['firstName', 'lastName'],
      CHAMP_REQUIS,
    ],
    [
      'coordonnées du compte',
      updateProfileRequestSchema,
      { firstName: '', lastName: '' },
      ['firstName', 'lastName'],
      CHAMP_REQUIS,
    ],
    [
      'connexion du back-office',
      loginRequestSchema,
      { email: 'ida@exemple.test', password: '' },
      ['password'],
      MOT_DE_PASSE_REQUIS,
    ],
    [
      'catalogue — nouvelle prestation',
      createServiceRequestSchema,
      { name: '', durationMinutes: 30, price: { amountMinor: 1000, currency: 'EUR' } },
      ['name'],
      CHAMP_REQUIS,
    ],
    [
      'catalogue — rubriques',
      createServiceCategoryRequestSchema,
      { name: '' },
      ['name'],
      CHAMP_REQUIS,
    ],
    [
      'invitation du personnel',
      createStaffAccountRequestSchema,
      { email: 'ida@exemple.test', role: 'staff', firstName: '', lastName: '' },
      ['firstName', 'lastName'],
      CHAMP_REQUIS,
    ],
    ['réglages de l’établissement', updateTenantRequestSchema, { name: '' }, ['name'], CHAMP_REQUIS],
  ])('%s affiche un message français sur son champ', (_ecran, schema, saisie, champs, attendu) => {
    for (const champ of champs) {
      const message = messageDuChamp(schema, saisie, champ);

      expect(message).toBe(attendu);
    }
  });
});
