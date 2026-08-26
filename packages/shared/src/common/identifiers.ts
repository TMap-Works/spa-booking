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
  EMAIL_MAX_LENGTH,
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
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH)
  .email({ message: 'adresse e-mail invalide' });

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
