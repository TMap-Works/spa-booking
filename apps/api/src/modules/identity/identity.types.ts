import type { UserRole } from '@prisma/client';

/**
 * Formes de données du module `identity`.
 *
 * TODO(#26) : `AuthenticatedUser`, `UserProfile` et `UserRole` appartiennent au
 * contrat d'API et devront être réexportés depuis `@spa/shared` — le front ne
 * redéclare jamais un type que l'API expose (CLAUDE.md). Le paquet est tenu par
 * #26 en parallèle ; les définir ici évite d'écrire dans son empreinte.
 */

export type { UserRole };

/** Les trois publics du CDC §2.4, tels que le schéma les énumère. */
export const USER_ROLES: readonly UserRole[] = ['CLIENT', 'STAFF', 'ADMIN'];

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
