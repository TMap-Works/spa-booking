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
  storedPhoneSchema,
  submittedPasswordSchema,
  uuidSchema,
} from '../common/identifiers';
import { utcInstantSchema } from '../common/time';
import { PERMISSIONS } from '../constants/permissions';
import { USER_ROLES } from '../constants/roles';

export const userRoleSchema = z.enum(USER_ROLES);

/**
 * Une permission nommée — le vocabulaire de `constants/permissions.ts`, rendu
 * lisible par un schéma (#812, ADR 0013).
 */
export const permissionSchema = z.enum(PERMISSIONS);

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
  phone: storedPhoneSchema.optional(),
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

/**
 * L'accord au traitement des données donné **à la création de compte** —
 * obligatoire, et refusant `false` (#880, CDC §5.1, RGPD art. 7.1).
 *
 * ## Pourquoi obligatoire plutôt que facultatif
 *
 * Parce que la case est bloquante à l'écran depuis #734, et qu'une barrière qui
 * ne tient que dans le navigateur n'est pas une barrière : un appel direct à
 * `POST /auth/register` la contournerait, et l'établissement garderait une fiche
 * cliente — nom, adresse, téléphone, historique de rendez-vous — sans rien
 * pouvoir produire de ce qui l'autorise à la constituer. Le facultatif aurait
 * par ailleurs rendu le champ indistinct : « absent » se serait lu tantôt
 * « pas encore demandé », tantôt « refusé ».
 *
 * ## Pourquoi un schéma à part, et non `dataConsentSchema` de `./appointment`
 *
 * Les deux disent la même règle et n'ont pas le même message, parce qu'ils ne
 * refusent pas le même geste : celui-là s'affiche sur un tunnel de réservation,
 * celui-ci sur un formulaire d'inscription, et « pour réserver » y serait faux.
 * Le message d'un refus est lu par la cliente ; le partager aurait économisé
 * trois lignes au prix d'une phrase qui ne décrit pas l'écran où elle
 * apparaît.
 *
 * `refine` plutôt que `z.literal(true)` pour la même raison que son voisin : le
 * refus littéral de Zod 3 s'annonce « Invalid literal value, expected true », et
 * ce message-là remonterait jusqu'au formulaire.
 */
export const accountDataConsentSchema = z.boolean().refine((accepted) => accepted, {
  message: 'le traitement des données doit être accepté pour créer un compte',
});

/**
 * Inscription d'un client depuis le parcours public.
 *
 * `dataConsent` est le seul champ qui ne décrit pas le compte : il décrit ce qui
 * autorise l'établissement à le tenir. Le serveur en **date** la réception —
 * `users.data_consent_at` — et n'accepte aucune date de l'appelant : RGPD art.
 * 7.1 met la preuve à la charge du responsable du traitement, et une preuve
 * horodatée par celui qu'elle engage n'en est pas une. Le `.strict()` ci-dessous
 * est ce qui refuse un `dataConsentAt` glissé dans le corps.
 */
export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.optional(),
    dataConsent: accountDataConsentSchema,
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
 * Ce n'est pas la forme d'arrivée définitive, et ce qui l'en sépare n'est plus
 * la dépendance — `apps/api` valide déjà ses entrées avec ce paquet
 * ([ADR 0008](../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * C'est la **casse émise** : unifier les deux vocabulaires change le format du
 * fil, et casserait tout lecteur qui n'aurait pas bougé en même temps. C'est le
 * premier point de vigilance de #510 ; le jour où il sera tranché, ce schéma
 * pourra redevenir `userRoleSchema` tout court. Le laisser ici plutôt que
 * d'écrire un `.toLowerCase()` dans un composant est ce qui rend cette
 * suppression possible en un seul endroit.
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
  phone: storedPhoneSchema.nullable(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Le compte du personnel tel que le **back-office** le lit — `GET /users`,
 * `GET /users/:id` et `PATCH /users/:id/status`.
 *
 * C'est `sessionUserSchema` plus l'état d'activation, et l'extension est ce qui
 * distingue les deux surfaces : l'espace client n'a pas à savoir qu'un compte a
 * été fermé, l'administration des droits ne peut pas s'en passer. Sans ce champ,
 * la liste du personnel ne pouvait ni signaler un compte désactivé, ni proposer
 * de le rouvrir autrement qu'à l'aveugle (#695) — elle affichait « Désactiver »
 * sur une ligne déjà fermée.
 *
 * Les trois routes qui le portent sont gardées au rang `STAFF` au minimum ;
 * `/auth/me` et `PATCH /users/me`, qui servent aussi la clientèle, gardent
 * `sessionUserSchema`.
 *
 * Non `.strict()`, comme tous les schémas de sortie du contrat.
 */
export const staffAccountStateSchema = sessionUserSchema.extend({
  isActive: z.boolean(),
});

export type StaffAccountState = z.infer<typeof staffAccountStateSchema>;

/**
 * Le compte connecté **et ce qu'il a le droit de faire** — ce que rend
 * `GET /api/v1/auth/me` depuis #812 (ADR 0013).
 *
 * ## Pourquoi une extension de `sessionUserSchema`, et non le schéma lui-même
 *
 * Parce que les trois routes de session — connexion, inscription,
 * rafraîchissement — rendent `sessionUserSchema` **imbriqué** dans
 * `authSessionResponseSchema`, et qu'y ajouter les permissions les ferait
 * voyager dans le corps d'une réponse d'authentification. Elles n'y ont rien à
 * faire : le rail se construit après la connexion, sur un appel qui a déjà lieu
 * (`GET /auth/me`, fait par le layout du back-office), et un droit qu'on
 * découvre au même instant que son jeton invite à le mettre en cache avec lui —
 * c'est-à-dire à le garder après qu'un administrateur l'a retiré.
 *
 * ## Pourquoi la liste est **émise** plutôt que déduite
 *
 * C'est le cinquième critère de #812 : « le front construit son rail à partir de
 * cette liste au lieu de recopier la matrice ». Une matrice recopiée dans
 * `apps/web` aurait deux écritures pour une seule décision, et elles auraient
 * divergé au premier ticket — la trajectoire exacte des seuils du sommaire du
 * back-office (#458, #480, #484), corrigés trois fois pour la même cause.
 *
 * La liste ne **protège** rien pour autant : un sommaire qui affiche une entrée
 * de trop n'ouvre aucune donnée, la seule frontière étant la garde de l'API.
 *
 * Non `.strict()`, comme tous les schémas de sortie du contrat.
 */
export const authenticatedAccountSchema = sessionUserSchema.extend({
  /**
   * Les permissions **effectives** du compte, dans l'ordre du vocabulaire.
   *
   * Toujours émise, éventuellement vide : un compte `client` connecté au
   * back-office n'en a aucune, et le tableau vide est la réponse — pas l'absence
   * du champ, qu'un front distinguerait mal d'une version d'API plus ancienne.
   */
  permissions: z.array(permissionSchema),
});

export type AuthenticatedAccount = z.infer<typeof authenticatedAccountSchema>;

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

/**
 * Borne d'un jeton opaque **reçu dans un corps de requête** — 4096 octets.
 *
 * `opaqueTokenSchema` décrit un jeton que l'API **rend** : sa longueur est celle
 * qu'elle a elle-même produite, et la borner n'apprendrait rien. Un jeton reçu
 * est une entrée arbitraire, et il ne doit pas atteindre une vérification de
 * signature sans avoir été borné — un corps d'un mégaoctet coûterait le HMAC
 * qu'il ne mérite pas.
 *
 * Quatre kilo-octets sont larges : un JWT d'invitation ou de réinitialisation de
 * ce produit tient en quelques centaines d'octets. C'est la borne que
 * `AcceptInvitationDto` applique déjà en `class-validator`, écrite ici pour que
 * le contrat la porte à son tour.
 */
const receivedTokenSchema = opaqueTokenSchema.max(4096, { message: 'jeton trop long' });

/**
 * Demande de réinitialisation d'un mot de passe oublié — #809, premier critère.
 *
 * `tenantSlug` est exigé pour la raison qui vaut déjà pour la connexion : la
 * même adresse désigne deux comptes distincts dans deux salons
 * (`@@unique([tenantId, email])`), et sans lui la demande n'aurait aucun moyen
 * de savoir lequel des deux récupérer. Il **désigne** un établissement sans en
 * accorder l'accès — ce n'est donc pas une entorse à l'invariant 2 de l'en-tête.
 *
 * La réponse est **toujours 202**, que l'adresse soit connue ou non : un refus
 * distinct ferait de ce formulaire un annuaire de la clientèle du salon, et
 * l'énumération que `INVALID_CREDENTIALS` interdit à la connexion se referait
 * ici. Le contrat n'a donc aucun schéma de réponse à déclarer — il n'y a pas de
 * corps à lire.
 */
export const passwordResetRequestSchema = z
  .object({
    tenantSlug: slugSchema,
    email: emailSchema,
  })
  .strict();

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/**
 * Choix du nouveau mot de passe, jeton en main — #809, troisième critère.
 *
 * ## Aucun `tenantSlug`, contrairement à la demande
 *
 * L'établissement est une revendication **signée** du jeton, comme il l'est du
 * jeton de rafraîchissement et de celui d'invitation. Le réclamer en plus
 * donnerait au client une seconde source pour la même information — donc un
 * désaccord possible, qu'il faudrait arbitrer sur la foi d'une entrée
 * utilisateur.
 *
 * ## `passwordSchema` et non `submittedPasswordSchema`
 *
 * Le mot de passe est **choisi** ici, pas vérifié : la politique de longueur
 * s'applique, exactement comme à l'inscription. C'est le sens du « il applique
 * la politique de mot de passe » du critère.
 */
export const passwordResetConfirmRequestSchema = z
  .object({
    token: receivedTokenSchema,
    password: passwordSchema,
  })
  .strict();

export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmRequestSchema>;

/**
 * Activation d'un compte invité — `POST /auth/invitations/accept` (#55).
 *
 * Même forme que la réinitialisation, et pour la même raison : l'établissement
 * et le compte sont des revendications **signées** du jeton, le corps n'a rien
 * d'autre à dire que le mot de passe choisi.
 */
export const acceptInvitationRequestSchema = z
  .object({
    token: receivedTokenSchema,
    password: passwordSchema,
  })
  .strict();

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
