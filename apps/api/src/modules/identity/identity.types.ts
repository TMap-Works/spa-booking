import type { UserRole } from './roles';

/**
 * Formes de données du module `identity`.
 *
 * TODO(#26) : `AuthenticatedUser`, `UserProfile` et `UserRole` appartiennent au
 * contrat d'API et devront être réexportés depuis `@spa/shared` — le front ne
 * redéclare jamais un type que l'API expose (CLAUDE.md). Le paquet expose déjà
 * ces rôles (`packages/shared/src/constants/roles.ts`) ; l'import se substituera
 * à la déclaration locale le jour où `apps/api` dépendra du paquet partagé, ce
 * qui touche `apps/api/package.json` — hors du périmètre de fichiers de #22.
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
