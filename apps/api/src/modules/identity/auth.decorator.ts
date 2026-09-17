import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Permission } from '@spa/shared';

import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions.guard';
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

/**
 * `@Auth` par **permission** — la forme qui remplace `@AuthAtLeast` partout où
 * le rang a cessé d'être vrai (#812, ADR 0013).
 *
 * ```ts
 * @AuthWith('agenda:read:all')                               // une seule
 * @AuthWith('customers:read:own', 'customers:read:all')      // l'une ou l'autre
 * ```
 *
 * Les permissions citées sont **alternatives**, jamais cumulatives : la garde
 * laisse passer qui en porte au moins une. C'est ce que réclame une route à
 * double portée — le fichier client s'ouvre au praticien comme au gérant, et
 * c'est ensuite le service qui décide, selon la permission retenue, s'il rend
 * dix-sept fiches ou trois.
 *
 * ## Pourquoi ce composite et non `@RequirePermissions` seul
 *
 * Pour la raison exacte qui a fait naître `@Auth` : `@RequirePermissions('…')`
 * posé seul serait un commentaire — la route resterait ouverte, et rien ne le
 * signalerait. Ici les trois gardes viennent avec l'annotation, dans l'ordre qui
 * compte : `JwtAuthGuard` établit l'identité, `RolesGuard` écarte les anonymes
 * et les rôles inconnus, `PermissionsGuard` juge le droit.
 *
 * ## Pourquoi `RolesGuard` reste monté
 *
 * Parce qu'il tient le **défaut fermé** de la couche : il exige une identité
 * vérifiée même sans métadonnée de rôle, et son absence ferait dépendre cette
 * garantie du seul `PermissionsGuard`. Les deux se montent donc ensemble, et le
 * coût est nul — aucun des deux ne lit la base.
 *
 * ## Ce que le document OpenAPI en dit
 *
 * La route annonce ses permissions plutôt que ses rôles. C'est ce qui compte
 * pour un intégrateur : un rôle est une commodité d'administration, un droit est
 * ce qui décide de la réponse. Un contrat qui mentirait sur ses codes d'erreur
 * coûte au front autant qu'un bug.
 */
export function AuthWith(
  ...permissions: readonly Permission[]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    // Les quatre rôles : c'est la permission qui tranche, pas le rang. Déclarer
    // ici une liste restreinte reviendrait à écrire la matrice deux fois — et la
    // seconde écriture est celle qui diverge.
    Roles(...USER_ROLES),
    RequirePermissions(...permissions),
    UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Jeton d’accès absent, invalide ou expiré.' }),
    ApiForbiddenResponse({
      description:
        `Exige l’une des permissions : ${permissions.join(', ')}. ` +
        'Le corps porte `code: "FORBIDDEN"` et `details.requiredPermissions`.',
    }),
  );
}
