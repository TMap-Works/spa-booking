/**
 * Primitives d'identification et de coordonnées.
 *
 * Toutes les longueurs viennent de `../constants/limits` — jamais d'un littéral
 * recopié ici : une borne écrite à deux endroits finit par diverger, et c'est
 * l'écart entre la borne du front et la largeur de la colonne qui produit un
 * 500 là où l'utilisateur attendait un message de champ.
 */

import { z } from 'zod';

import {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_ADDRESS_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  SLUG_MAX_LENGTH,
} from '../constants/limits';

/**
 * Identifiant de ressource — UUID v4 généré côté application.
 *
 * Le choix de l'UUID sur un entier séquentiel n'est pas esthétique : un
 * identifiant énumérable est un vecteur de fuite inter-tenant à part entière.
 * Avec `/appointments/1`, `/appointments/2`, il suffit d'incrémenter pour
 * sonder l'existence des rendez-vous des autres établissements.
 */
export const uuidSchema = z.string().uuid({ message: 'identifiant attendu au format UUID' });

export type Uuid = z.infer<typeof uuidSchema>;

/**
 * Slug d'URL — label DNS minuscule, utilisé par les pages de réservation
 * publiques (`{slug}.exemple.test` ou `/{slug}`).
 *
 * Ni tiret en tête ni tiret en fin : `-salon` n'est pas un label DNS valide, et
 * la page publique du tenant deviendrait injoignable.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug attendu en minuscules, chiffres et tirets simples',
  });

export type Slug = z.infer<typeof slugSchema>;

/**
 * Adresse e-mail, **canonisée ici** : espaces retirés, casse abaissée.
 *
 * Le faire dans le schéma partagé et non dans chaque appelant est ce qui rend
 * l'unicité `(tenant_id, email)` fiable. La contrainte de base porte sur les
 * octets : sans normalisation en amont, `Alice@Example.test` et
 * `alice@example.test` cohabiteraient dans le même salon et la recherche à la
 * connexion n'en trouverait qu'une — l'autre compte deviendrait inatteignable
 * sans jamais avoir déclenché la moindre erreur.
 *
 * ## Les deux bornes de longueur de la RFC 5321 — #314
 *
 * `.email()` de Zod ne juge aucune longueur : il accepte une partie locale de
 * trois cents caractères, et une adresse aussi longue que la chaîne le permet.
 * Les DTO de l'API, eux, valident avec `@IsEmail()`, dont validator.js porte les
 * deux bornes de la RFC en dur — **254 octets** pour l'adresse entière
 * (§4.5.3.1.3), **64** pour la partie locale (§4.5.3.1.1).
 *
 * Sans elles, le contrat serait **plus permissif que l'API qu'il décrit**, et
 * c'est le sens dangereux de l'écart : un formulaire qui valide avec ce schéma
 * déclarerait l'adresse bonne, l'enverrait, et récolterait un 400 qu'il vient
 * lui-même d'annoncer impossible. Le sens inverse — un contrat plus strict — ne
 * coûte qu'un refus plus tôt, du bon côté de l'écran. C'est pourquoi la borne
 * appliquée ici est `EMAIL_ADDRESS_MAX_LENGTH` (254) et non `EMAIL_MAX_LENGTH`
 * (320), qui est la largeur de la colonne.
 *
 * Le motif n'est pas une seconde validation d'adresse : il ne juge que la
 * position du premier `@`, `.email()` gardant tout le reste. Son alternative
 * `[^@]*$` est ce qui l'empêche de **doubler** le refus de `.email()` sur une
 * chaîne sans `@` : deux checks qui échouent produisent deux `issues` de même
 * message, et un formulaire qui les rend toutes affiche « adresse e-mail
 * invalide » deux fois sous le même champ.
 *
 * Ce que ces bornes ne couvrent **pas**, et qui reste à l'avantage de l'API :
 * validator.js refuse aussi un label de domaine de plus de 63 octets. Le
 * reproduire ici demanderait de redécouper le domaine, c'est-à-dire de valider
 * l'adresse une seconde fois — l'écart est laissé en l'état, un tel domaine
 * n'étant pas enregistrable.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_ADDRESS_MAX_LENGTH)
  .email({ message: 'adresse e-mail invalide' })
  .regex(/^(?:[^@]{0,64}@|[^@]*$)/, { message: 'adresse e-mail invalide' });

export type Email = z.infer<typeof emailSchema>;

/**
 * Numéro de téléphone — format libre borné à ce stade du MVP.
 *
 * Volontairement permissif : la validation stricte d'un numéro dépend du pays et
 * demande une table de plans de numérotation. Refuser un numéro pourtant valide
 * empêche une réservation ; en accepter un douteux ne coûte qu'un SMS non
 * délivré, que la chaîne de notifications sait déjà journaliser.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(PHONE_MAX_LENGTH)
  .regex(/^[+0-9][0-9\s().-]*$/, { message: 'numéro de téléphone invalide' });

export type Phone = z.infer<typeof phoneSchema>;

/**
 * Motif E.164 — `+`, un indicatif de pays qui ne commence pas par zéro, et
 * quinze chiffres significatifs au plus (recommandation UIT-T E.164).
 */
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Ce qu'un humain intercale dans un numéro et qui ne porte aucune information :
 * espaces, points, tirets, parenthèses d'indicatif régional.
 */
const PHONE_SEPARATORS = /[\s().-]/g;

/**
 * Ramène un numéro saisi à sa forme E.164, ou rend `null` s'il n'y a pas de
 * forme E.164 déductible **sans deviner un pays**.
 *
 * Deux écritures internationales entrent : `+261341234567` et `00261341234567`
 * — le préfixe `00` est la forme que composent la plupart des plans de
 * numérotation, `+` celle qu'exige E.164. Les séparateurs sont retirés.
 *
 * Ce qui n'entre **pas**, et c'est le point : un numéro national comme
 * `0341234567`. Le compléter demanderait de connaître le pays de la personne,
 * que rien dans la requête ne dit — ni le fuseau du salon, qui n'est pas un
 * pays, ni la langue du navigateur. Deviner produirait un numéro
 * syntaxiquement valide et faux, c'est-à-dire un SMS de rappel envoyé à
 * quelqu'un d'autre. Refuser laisse la correction à la seule personne qui
 * connaisse la réponse, et le formulaire l'annonce dans son libellé d'aide.
 */
export function normalizeToE164(value: string): string | null {
  const compact = value.trim().replace(PHONE_SEPARATORS, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  return E164_PATTERN.test(withPlus) ? withPlus : null;
}

/**
 * Numéro de téléphone **normalisé en E.164**, pour les surfaces où le numéro
 * sert à joindre quelqu'un plutôt qu'à être affiché tel qu'il a été tapé.
 *
 * Distinct de `phoneSchema`, et la distinction n'est pas cosmétique :
 *
 * - `phoneSchema` est **permissif et conservateur** — il accepte la saisie d'un
 *   comptoir, qui recopie ce qu'une cliente dicte, et la garde telle quelle ;
 * - `e164PhoneSchema` **transforme** — passé la frontière, le numéro a une seule
 *   écriture, celle qu'attend un opérateur SMS. `+261 34 12 345 67`,
 *   `+261-34-12-345-67` et `00261341234567` y deviennent le même numéro, donc
 *   le même destinataire et la même clé de déduplication d'envoi.
 *
 * Le plafond de longueur porte sur la saisie **avant** normalisation : c'est
 * elle qui doit tenir dans `VARCHAR(32)` si un appelant la conserve, et la forme
 * normalisée est de toute façon plus courte.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH)
  .transform((value, ctx): string => {
    const normalized = normalizeToE164(value);

    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'numéro attendu au format international, indicatif compris — par exemple +261 34 12 345 67',
      });

      return z.NEVER;
    }

    return normalized;
  });

export type E164Phone = z.infer<typeof e164PhoneSchema>;

/** Prénom, nom, catégorie — `VARCHAR(80)`. */
export const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);

/** Nom d'établissement, de prestation, nom public de praticien — `VARCHAR(160)`. */
export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH);

/** Description, biographie, note de rendez-vous — `VARCHAR(2000)`. */
export const longTextSchema = z.string().trim().max(LONG_TEXT_MAX_LENGTH);

/** Motif d'annulation, cause d'échec d'envoi — `VARCHAR(500)`. */
export const reasonSchema = z.string().trim().max(REASON_MAX_LENGTH);

/**
 * Mot de passe en clair — **uniquement en entrée**, jamais en sortie.
 *
 * Aucun schéma de réponse de ce paquet ne porte ce champ, ni `passwordHash` :
 * c'est une propriété qu'on veut pouvoir vérifier en lisant les types, pas
 * seulement en relisant les contrôleurs.
 *
 * Pas de `.trim()` ici, contrairement aux autres chaînes : une espace en tête ou
 * en fin fait partie du secret choisi par l'utilisateur. La retirer en silence
 * rendrait le mot de passe irreproductible depuis un gestionnaire de mots de
 * passe qui, lui, ne la retire pas.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `le mot de passe fait au moins ${String(PASSWORD_MIN_LENGTH)} caractères`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `le mot de passe fait au plus ${String(PASSWORD_MAX_LENGTH)} caractères`,
  });

/**
 * Mot de passe **soumis à vérification** — la connexion, la confirmation du mot
 * de passe courant. Distinct de `passwordSchema`, et la distinction n'est pas
 * cosmétique :
 *
 * - la politique de longueur s'applique au moment où le secret est **choisi**,
 *   pas à celui où il est **vérifié**. Relever `PASSWORD_MIN_LENGTH` un jour
 *   verrouillerait sinon définitivement tout compte dont le secret est
 *   antérieur au durcissement : sa connexion sortirait en 422 sans qu'aucun
 *   chemin ne lui permette de se réauthentifier pour en changer ;
 * - un refus de longueur à la connexion **divulgue la politique** et distingue
 *   un mot de passe mal formé d'un mot de passe faux, là où le contrat exige un
 *   `INVALID_CREDENTIALS` indistinct.
 *
 * Le plafond, lui, reste : c'est une borne de coût argon2id, pas une règle de
 * composition.
 */
export const submittedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/**
 * Jeton opaque — jeton d'accès, de rafraîchissement, ou secret client d'un
 * paiement. Non introspecté par le contrat : sa structure appartient à son
 * émetteur.
 */
export const opaqueTokenSchema = z.string().min(1);
