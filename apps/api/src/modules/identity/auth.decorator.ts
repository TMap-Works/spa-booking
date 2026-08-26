import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { JwtAuthGuard } from './jwt-auth.guard';
import { Roles, RolesGuard } from './roles.guard';
import { rolesAtLeast, USER_ROLES, type UserRole } from './roles';

/**
 * Déclaration d'accès d'un endpoint, en un seul décorateur.
 *
 * ```ts
 * @Auth()                    // toute identité vérifiée, quel que soit le rôle
 * @Auth('ADMIN')             // ces rôles exactement
 * @AuthAtLeast('STAFF')      // ce rôle et tous ceux au-dessus
 * ```
 *
 * Pourquoi un composite plutôt que trois décorateurs à recopier : parce qu'il
 * rend impossible d'annoter un rôle sans monter la garde qui le fait respecter.
 * `@Roles('ADMIN')` posé seul serait un commentaire — la route resterait ouverte
 * à tous, et rien ne le signalerait. Ici les deux gardes viennent avec
 * l'annotation, dans l'ordre qui compte : `JwtAuthGuard` établit l'identité,
 * `RolesGuard` la juge. L'inverse jugerait une identité qui n'existe pas encore.
 *
 * La documentation OpenAPI suit la même déclaration : une route protégée annonce
 * son schéma d'authentification et ses réponses d'échec sans qu'on ait à y
 * penser. Un contrat qui ment sur ses codes d'erreur coûte au front autant qu'un
 * bug.
 */
export function Auth(...roles: readonly UserRole[]): MethodDecorator & ClassDecorator {
  const allowed = roles.length === 0 ? USER_ROLES : roles;
  const restricted = allowed.length < USER_ROLES.length;

  return applyDecorators(
    Roles(...allowed),
    UseGuards(JwtAuthGuard, RolesGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Jeton d’accès absent, invalide ou expiré.' }),
    // Annoncé seulement là où il peut réellement tomber : une route ouverte à
    // tous les rôles ne renverra jamais 403, et le prétendre inviterait le front
    // à écrire une branche morte.
    ...(restricted
      ? [
          ApiForbiddenResponse({
            description: `Réservé aux rôles : ${allowed.join(', ')}.`,
          }),
        ]
      : []),
  );
}

/**
 * `@Auth` par seuil, pour la hiérarchie strictement emboîtée du MVP.
 *
 * La liste des rôles est résolue **à la déclaration** de la route et non à
 * chaque requête : la garde ne fait qu'une appartenance à une liste, et le jour
 * où les rôles cesseront d'être comparables (ADR), c'est ici qu'on verra les
 * appels à reprendre.
 */
export function AuthAtLeast(minimum: UserRole): MethodDecorator & ClassDecorator {
  return Auth(...rolesAtLeast(minimum));
}
