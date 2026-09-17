import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@spa/shared';
import type { Request } from 'express';

import { ForbiddenError } from '../../common/errors';
import { getAuthenticatedUser } from './jwt-auth.guard';
import { roleHasAnyPermission } from './permissions';

/**
 * Garde de **permission**, déclarée par endpoint — #812, ADR 0013.
 *
 * Elle est à `RolesGuard` ce que la matrice est au rang : la même mécanique, une
 * question différente. Là où `RolesGuard` demande « ce rôle est-il dans la liste
 * des rôles admis ? », celle-ci demande « ce rôle porte-t-il l'un des droits que
 * la route exige ? » — et la seconde question sait exprimer ce que la première
 * ne savait pas : que `STAFF` ait `agenda:read:own` sans avoir `agenda:read:all`
 * alors qu'il est *sous* `MANAGER`, qui a les deux.
 *
 * ## Elle ne consulte aucune ressource, et c'est la partie importante
 *
 * Exactement pour la raison qu'expose `roles.guard.ts` : son 403 porte sur la
 * **route**, jamais sur l'objet visé, et il est donc rigoureusement identique
 * pour un identifiant du tenant courant, un identifiant d'un autre tenant et un
 * identifiant qui n'existe nulle part. Rien dans sa réponse ne permet de
 * distinguer les trois — elle n'a pas l'information (tenant-isolation §4).
 *
 * Le refus qui porte, lui, sur un objet précis — « ce rendez-vous n'est pas le
 * vôtre » — n'est pas de son ressort : c'est `OwnScopeOnlyError`, levée par les
 * services, sur une ressource du **même** établissement dont l'appelant connaît
 * déjà l'existence.
 *
 * ## Sémantique « au moins une »
 *
 * `@RequirePermissions('customers:read:own', 'customers:read:all')` ouvre la
 * route aux deux, et c'est le service qui restreint ensuite ce qu'il rend. Le
 * choix est délibéré : une route à double portée doit s'ouvrir aux deux publics,
 * et exiger « toutes » aurait fermé le fichier client au praticien qu'on veut
 * justement y laisser entrer — avec moins de lignes.
 *
 * Deux déclarations, l'une sur la classe et l'autre sur la méthode, se lisent
 * dans le même ordre que pour les rôles : la méthode l'emporte, et un
 * `@RequirePermissions()` vide n'écrase rien.
 *
 * ## Défaut fermé
 *
 * Sans métadonnée, la garde n'ouvre pas la route à tout le monde : elle exige
 * malgré tout une identité vérifiée. Une route qui la monterait sans
 * `@AuthWith(...)` — un défaut de câblage — reste donc fermée aux anonymes au
 * lieu de s'ouvrir en silence.
 */

/**
 * Clé de métadonnée. Un `Symbol` plutôt qu'une chaîne, pour la raison
 * qu'expose `ROLES_METADATA` : deux modules ne peuvent pas se marcher dessus.
 */
export const PERMISSIONS_METADATA = Symbol('identity:required-permissions');

/**
 * Exige d'une route — ou d'un contrôleur — au moins une des permissions citées.
 *
 * S'utilise seule uniquement dans un test de garde ; sur une vraie route,
 * `@AuthWith(...)` la pose en même temps que `JwtAuthGuard`, `RolesGuard`,
 * `PermissionsGuard` et les décorateurs Swagger — ce qui rend impossible
 * d'annoter une permission sans monter la garde qui la fait respecter.
 */
export const RequirePermissions = (
  ...permissions: readonly Permission[]
): MethodDecorator & ClassDecorator =>
  SetMetadata<symbol, readonly Permission[]>(PERMISSIONS_METADATA, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  public constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    // `getAll` et non `getAllAndOverride`, pour la raison de sécurité que
    // `RolesGuard` détaille : un tableau vide est *défini*, et
    // `getAllAndOverride` le retiendrait — un `@RequirePermissions()` posé sur
    // une méthode rouvrirait alors une classe restreinte, sans que rien ne le
    // signale à la lecture. En ne retenant que la première déclaration **non
    // vide**, un tel oubli laisse la restriction de classe en place.
    const declarations = this.reflector.getAll<(readonly Permission[] | undefined)[]>(
      PERMISSIONS_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const required = declarations.find(
      (permissions): permissions is readonly Permission[] =>
        permissions !== undefined && permissions.length > 0,
    );

    const request = context.switchToHttp().getRequest<Request>();
    const user = getAuthenticatedUser(request);

    if (user === undefined) {
      // `JwtAuthGuard` n'a pas tourné, ou a laissé passer sans identité. 401 et
      // non 403 : il n'y a personne à qui refuser un droit.
      throw new UnauthorizedException('Route non authentifiée.');
    }

    // Aucune exigence déclarée : la route n'a pas de permission à faire
    // respecter, elle garde son exigence d'authentification.
    if (required === undefined) {
      return true;
    }

    if (!roleHasAnyPermission(user.role, required)) {
      // `details` ne cite que ce que la **route** exige — une information déjà
      // publiée par le document OpenAPI. Ni le rôle du porteur, ni ses
      // permissions effectives : le premier confirmerait au voleur d'un jeton ce
      // qu'il vient de dérober, la seconde lui dresserait la carte de ce qu'il
      // peut encore essayer.
      throw new ForbiddenError('Droits insuffisants pour cette opération.', {
        requiredPermissions: [...required],
      });
    }

    return true;
  }
}
