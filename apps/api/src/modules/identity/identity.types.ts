import type { UserRole } from './roles';

/**
 * Formes de données du module `identity`.
 *
 * Écart assumé, tranché en #554 : `UserRole` appartient au contrat d'API, et #510 n'a pas pu l'y
 * prendre — c'est son premier point de vigilance, sur le vocabulaire le plus
 * chargé du dépôt. `USER_ROLES` de `@spa/shared` porte les quatre mêmes rôles en
 * **minuscules** (`client`, `staff`, `manager`, `admin`), là où `roles.ts` de ce
 * module porte la casse de l'énumération PostgreSQL, celle que Prisma génère et
 * que les *claims* des jetons d'accès transportent. Substituer l'import
 * n'échangerait pas une déclaration contre une autre : il **invaliderait tous
 * les jetons en circulation**, puisque `RolesGuard` compare la revendication du
 * jeton à cette liste, et rendrait faux le `USER_ROLE_RANK` que la garde lit.
 *
 * Reste à faire, et c'est une décision de contrat doublée d'une migration :
 * unifier les deux casses, ou déclarer côté contrat la conversion que la couche
 * repository fait déjà — `receivedUserRoleSchema` est écrit pour que ce soit
 * possible en un seul endroit. `UserProfile` et `AuthenticatedUser` suivront,
 * les deux portant ce type.
 *
 * Le vocabulaire des rôles et leur hiérarchie vivent dans `roles.ts` : ils sont
 * consommés par la garde de permissions autant que par ces formes de données, et
 * les rassembler ici mélangerait une décision d'autorisation à une description
 * de charge utile.
 */

export type { UserRole };

/**
 * L'identité que la garde attache à la requête, **entièrement** issue d'un jeton
 * dont la signature a été vérifiée. Aucun de ces champs ne provient d'un en-tête,
 * d'un paramètre ou d'un corps.
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: UserRole;
}

/**
 * Le compte tel que l'API le rend.
 *
 * **Sans `tenantId` et sans `passwordHash`** : le premier est une information
 * interne qui n'apporte rien au consommateur et invite aux essais
 * (tenant-isolation §4), le second ne sort jamais du serveur. C'est pour cela
 * qu'aucune entité Prisma n'est renvoyée telle quelle (api-module §4).
 */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
}

/**
 * Le compte du personnel **avec** son état d'activation — #55.
 *
 * Forme propre à `PATCH /users/:id/status`, et non un élargissement de
 * `UserProfile` : ce dernier est la charge utile de `GET /users`,
 * `GET /users/:id` et `/auth/me`, que le front lit par un schéma partagé.
 * Y ajouter `isActive` élargirait trois contrats pour le besoin d'un seul, et
 * dirait à la clientèle qu'un compte a été fermé, ce qui ne la regarde pas.
 */
export interface StaffAccountState extends UserProfile {
  readonly isActive: boolean;
}

/**
 * Ce que l'API rend à l'administrateur qui invite un membre du personnel (#55).
 *
 * ## Pourquoi le jeton figure ici
 *
 * Parce que le module `notifications` (CDC §2.3) n'existe pas encore dans
 * `apps/api/src/modules/` : il n'y a aujourd'hui aucune chaîne d'envoi à qui
 * confier le lien, et le créer sortirait de l'empreinte de #55. Le jeton part
 * donc **une fois**, dans la réponse faite à l'administrateur — qui vient de
 * créer ce compte et a déjà tout pouvoir dessus, y compris celui de réémettre
 * l'invitation. Il ne franchit aucune frontière que le rôle `ADMIN` ne franchisse
 * déjà.
 *
 * C'est un dispositif de transition, et il est écrit pour disparaître : le jour
 * où `notifications` expédie le lien, ce champ quitte la réponse et l'invitation
 * ne transite plus que par la boîte mail de la personne invitée. Une issue de
 * suivi le porte.
 */
export interface StaffInvitation {
  readonly user: UserProfile;
  /** À usage unique — accepter renseigne `password_hash`, ce qui le périme. */
  readonly invitationToken: string;
  /** Secondes de validité restantes à l'émission. */
  readonly expiresIn: number;
}

/** Ce qu'une connexion réussie rend au client, hors cookie de rafraîchissement. */
export interface AuthenticationResult {
  readonly accessToken: string;
  /** Secondes — le front n'a pas à décoder le jeton pour savoir quand le renouveler. */
  readonly expiresIn: number;
  readonly user: UserProfile;
  /** Posé en cookie `httpOnly` par le contrôleur, jamais rendu dans le corps. */
  readonly refreshToken: string;
  readonly refreshTokenMaxAge: number;
}
