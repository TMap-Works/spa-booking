/**
 * Identity — comptes, authentification, rôles (#21, #22).
 *
 * Deux invariants se lisent directement dans les types de ce fichier, et c'est
 * délibéré :
 *
 * 1. **Aucun schéma de sortie ne porte `passwordHash`.** Renvoyer une entité
 *    Prisma brute est le chemin le plus court pour l'exposer (api-module §4) ;
 *    `userSchema` est la forme autorisée, et elle ne l'a pas.
 * 2. **Aucun schéma d'entrée ne porte `tenantId` ni `role`.** Le tenant est
 *    résolu depuis la requête ; le rôle est attribué par l'établissement, jamais
 *    choisi à l'inscription. Le `.strict()` des schémas d'entrée transforme une
 *    tentative d'injection en 422 nommant le champ, au lieu d'un champ ignoré en
 *    silence — comportement voulu, identique à
 *    `ValidationPipe({ forbidNonWhitelisted: true })`.
 */

import { z } from 'zod';

import {
  emailSchema,
  nameSchema,
  opaqueTokenSchema,
  passwordSchema,
  phoneSchema,
  slugSchema,
  submittedPasswordSchema,
  uuidSchema,
} from '../common/identifiers';
import { utcInstantSchema } from '../common/time';
import { USER_ROLES } from '../constants/roles';

export const userRoleSchema = z.enum(USER_ROLES);

/**
 * Compte tel que l'API le renvoie.
 *
 * `phone` est optionnel et `lastLoginAt` aussi : un client saisi au comptoir par
 * le staff existe sans avoir jamais eu ni téléphone renseigné ni session.
 */
export const userSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  role: userRoleSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneSchema.optional(),
  isActive: z.boolean(),
  lastLoginAt: utcInstantSchema.optional(),
  createdAt: utcInstantSchema,
});

export type User = z.infer<typeof userSchema>;

/**
 * Forme réduite d'un compte, telle qu'elle apparaît **imbriquée** dans un autre
 * objet — le client d'un rendez-vous, le destinataire d'une notification.
 *
 * Elle existe pour ne pas diffuser l'état d'activation et la dernière connexion
 * d'un compte à chaque fois qu'on cite son nom.
 */
export const userSummarySchema = userSchema.pick({
  id: true,
  firstName: true,
  lastName: true,
});

export type UserSummary = z.infer<typeof userSummarySchema>;

/** Inscription d'un client depuis le parcours public. */
export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.optional(),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Connexion. `password` est un `submittedPasswordSchema` et **non** le schéma de
 * création : une politique de longueur appliquée ici verrouillerait les comptes
 * antérieurs à son durcissement, et le message de refus renseignerait sur la
 * politique au lieu du `INVALID_CREDENTIALS` indistinct qu'exige le contrat.
 */
export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: submittedPasswordSchema,
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshTokenRequestSchema = z
  .object({
    refreshToken: opaqueTokenSchema,
  })
  .strict();

export type RefreshTokenRequest = z.infer<typeof refreshTokenRequestSchema>;

/**
 * Jetons délivrés par l'API.
 *
 * `expiresIn` est une **durée en secondes**, pas une date d'expiration : une
 * date absolue obligerait le client à faire confiance à sa propre horloge, qui
 * peut dériver de plusieurs minutes. Une durée relative se compte à partir de la
 * réception, ce que le client mesure correctement.
 *
 * Les jetons sont opaques pour le contrat. Le front ne décode **pas** le jeton
 * d'accès pour y lire un rôle : il lit `user.role` du corps de la réponse. Un
 * claim décodé côté client n'est pas une autorisation, seulement un affichage.
 */
export const authTokensSchema = z.object({
  accessToken: opaqueTokenSchema,
  refreshToken: opaqueTokenSchema,
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});

export type AuthTokens = z.infer<typeof authTokensSchema>;

/** Réponse d'une connexion, d'une inscription ou d'un rafraîchissement. */
export const authSessionSchema = z.object({
  user: userSchema,
  tokens: authTokensSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

/** Modification de son propre profil. Ni `email`, ni `role` : les deux ont leur procédure. */
export const updateProfileRequestSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.nullable(),
  })
  .strict()
  .partial();

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// ---------------------------------------------------------------------------
// Ce que les routes de session rendent réellement — #47
// ---------------------------------------------------------------------------

/**
 * Rôle **tel qu'il arrive du fil**, ramené au vocabulaire du contrat.
 *
 * L'API émet `CLIENT` — la casse de l'énumération PostgreSQL que Prisma
 * génère — là où ce contrat nomme le même rôle `client`. La conversion se fait
 * donc **une fois, à la frontière**, exactement comme
 * `receivedAppointmentStatusSchema` le fait pour les statuts de rendez-vous : au
 * delà, plus aucun écran n'a à se demander dans quelle casse il compare un rôle.
 *
 * Ce n'est pas la forme d'arrivée définitive : le jour où `apps/api` importera
 * ce paquet — le TODO(#26) que portent ses DTO —, les deux vocabulaires se
 * rejoindront et ce schéma pourra redevenir `userRoleSchema` tout court. Le
 * laisser ici plutôt que d'écrire un `.toLowerCase()` dans un composant est ce
 * qui rend cette suppression possible en un seul endroit.
 */
export const receivedUserRoleSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(userRoleSchema);

/**
 * Le compte tel que `GET /auth/me`, `PATCH /users/me` et les trois routes de
 * session le rendent.
 *
 * Distinct d'`userSchema`, et la distinction n'est pas cosmétique : celui-ci
 * décrit la **ligne** (avec `isActive`, `createdAt`, `lastLoginAt`), celui-là
 * décrit ce qui franchit la frontière HTTP. L'API n'émet ni l'état d'activation
 * — il dit qu'un compte a été fermé, et à qui le demande — ni les horodatages
 * techniques, dont aucun écran n'a l'usage.
 *
 * `phone` y est `.nullable()` et non `.optional()` : l'API émet toujours le
 * champ, à `null` quand il n'est pas renseigné. Même convention que
 * `bookedAppointmentSchema`, et pour la même raison — un front qui distingue
 * « absent » de « vide » finit par afficher `undefined`.
 *
 * Non `.strict()`, comme tous les schémas de sortie du contrat.
 */
export const sessionUserSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  role: receivedUserRoleSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneSchema.nullable(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Ce que rendent `POST /auth/register`, `POST /auth/login` et
 * `POST /auth/refresh`.
 *
 * **Le jeton de rafraîchissement n'y figure pas**, et c'est tout le propos : il
 * part en cookie `httpOnly`, donc hors de portée de JavaScript. Le porter dans
 * ce schéma reviendrait à annoncer un champ qu'un client chercherait à ranger
 * quelque part — et ce quelque part est `localStorage` neuf fois sur dix.
 *
 * Distinct d'`authTokensSchema` et d'`authSessionSchema`, qui décrivent la forme
 * générique d'une paire de jetons : ceux-ci portent `refreshToken` et
 * `tokenType`, que cette API n'émet pas. Ce schéma-ci décrit la réponse réelle,
 * et c'est lui que le front rejoue.
 */
export const authSessionResponseSchema = z.object({
  accessToken: opaqueTokenSchema,
  /** Secondes — voir l'en-tête d'`authTokensSchema`. */
  expiresIn: z.number().int().positive(),
  user: sessionUserSchema,
});

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/**
 * Connexion **à un établissement donné**.
 *
 * `tenantSlug` n'est pas une entorse à l'invariant « aucun schéma d'entrée ne
 * porte `tenantId` » : c'est un slug public, celui de l'URL de réservation, et
 * il **désigne** un établissement sans en accorder l'accès. Le serveur le résout
 * contre la table `tenants` puis vérifie les identifiants dans cette portée-là ;
 * un slug d'un autre salon ne fait que rendre `INVALID_CREDENTIALS`.
 *
 * Il est obligatoire parce que la même adresse e-mail désigne deux comptes
 * distincts dans deux salons — `@@unique([tenantId, email])` l'autorise
 * délibérément. Sans lui, la connexion n'aurait aucun moyen de savoir lequel des
 * deux ouvrir.
 */
export const tenantScopedLoginRequestSchema = loginRequestSchema.extend({
  tenantSlug: slugSchema,
});

export type TenantScopedLoginRequest = z.infer<typeof tenantScopedLoginRequestSchema>;

/** Inscription cliente **dans un établissement donné** — même raison que ci-dessus. */
export const tenantScopedRegisterRequestSchema = registerRequestSchema.extend({
  tenantSlug: slugSchema,
});

export type TenantScopedRegisterRequest = z.infer<typeof tenantScopedRegisterRequestSchema>;

/**
 * Changement de mot de passe. Le mot de passe courant est exigé même sur une
 * session valide : c'est ce qui empêche un poste laissé ouvert de devenir une
 * prise de contrôle définitive du compte.
 *
 * `currentPassword` est vérifié, `newPassword` est choisi : seul le second porte
 * la politique de longueur. Sans quoi le durcissement de cette politique
 * interdirait justement d'en sortir aux comptes qui ne la respectent plus.
 */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: submittedPasswordSchema,
    newPassword: passwordSchema,
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * Création d'un compte staff par un administrateur — le seul endroit du contrat
 * où `role` est une entrée, et il est réservé au back-office.
 */
export const createStaffAccountRequestSchema = z
  .object({
    email: emailSchema,
    role: userRoleSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.optional(),
  })
  .strict();

export type CreateStaffAccountRequest = z.infer<typeof createStaffAccountRequestSchema>;
