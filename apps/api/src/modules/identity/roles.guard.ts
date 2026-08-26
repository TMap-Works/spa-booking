import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ForbiddenError } from '../../common/errors';
import { getAuthenticatedUser } from './jwt-auth.guard';
import { USER_ROLES, type UserRole } from './roles';

/**
 * Garde de permissions, déclarée par endpoint.
 *
 * Elle ne décide **que** de l'accès à la route, à partir du seul rôle porté par
 * un jeton dont `JwtAuthGuard` a déjà vérifié la signature. Elle ne lit ni
 * paramètre, ni corps, ni en-tête : un rôle qui viendrait de l'un des trois ne
 * serait qu'une chaîne fournie par le client.
 *
 * ## Ce qu'elle ne fait pas, et pourquoi c'est la partie importante
 *
 * Elle ne consulte **aucune ressource**. C'est ce qui la rend compatible avec la
 * règle « une ressource d'un autre tenant renvoie 404, jamais 403 »
 * (tenant-isolation §4) : son 403 porte sur la route, pas sur l'objet visé, et
 * il est donc rigoureusement identique pour un identifiant du tenant courant, un
 * identifiant d'un autre tenant et un identifiant qui n'existe nulle part. Rien
 * dans sa réponse ne permet de distinguer les trois — elle n'a pas l'information.
 *
 * L'appartenance au tenant, elle, n'est jamais tranchée ici : elle l'est par le
 * scoping du client Prisma, qui rend `null` hors de l'établissement courant, et
 * ce `null` devient un `NotFoundError`. Une garde qui aurait vérifié le tenant
 * elle-même aurait eu à choisir entre 403 et 404 — et le 403 est précisément la
 * fuite qu'on refuse.
 *
 * ## Défaut fermé
 *
 * Sans métadonnée de rôle, la garde n'autorise pas tout le monde : elle exige
 * malgré tout une identité vérifiée. Une route qui la monterait sans
 * `@Auth(...)` — un défaut de câblage — reste donc fermée aux anonymes au lieu
 * de s'ouvrir en silence.
 */

/**
 * Clé de métadonnée. Un `Symbol` plutôt qu'une chaîne : deux modules ne peuvent
 * pas se marcher dessus, et la clé n'est pas devinable depuis un autre paquet.
 */
export const ROLES_METADATA = Symbol('identity:allowed-roles');

/**
 * Restreint une route — ou tout un contrôleur — à une liste de rôles.
 *
 * S'utilise seule uniquement dans un test de garde ; sur une vraie route,
 * `@Auth(...)` la pose en même temps que `JwtAuthGuard`, `RolesGuard` et les
 * décorateurs Swagger, ce qui rend impossible d'annoter un rôle sans monter la
 * garde qui le fait respecter.
 */
export const Roles = (
  ...roles: readonly UserRole[]
): MethodDecorator & ClassDecorator =>
  SetMetadata<symbol, readonly UserRole[]>(ROLES_METADATA, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  public constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    // La déclaration de la méthode l'emporte sur celle du contrôleur : un
    // contrôleur réservé aux `ADMIN` peut rouvrir une de ses routes au `STAFF`
    // sans que l'ordre de lecture soit à deviner.
    //
    // `getAll` et non `getAllAndOverride`, et la nuance est une décision de
    // sécurité. `getAllAndOverride` retient la **première valeur définie**, or un
    // tableau vide est défini : `@Roles()` posé sur une méthode d'un contrôleur
    // `@Roles('ADMIN')` écraserait la restriction de classe et rouvrirait la
    // route à tous les rôles authentifiés, `CLIENT` compris — un élargissement
    // que rien ne signale à la lecture. En ne retenant que la première
    // déclaration **non vide**, un tel oubli laisse la restriction de classe en
    // place : le défaut penche du côté fermé.
    const declarations = this.reflector.getAll<(readonly UserRole[] | undefined)[]>(
      ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const declared = declarations.find(
      (roles): roles is readonly UserRole[] => roles !== undefined && roles.length > 0,
    );

    // Aucune déclaration non vide nulle part : la route n'a pas de restriction de
    // rôle, elle garde son exigence d'authentification. `@Auth()` sans argument
    // ne passe pas par là — il déclare explicitement les quatre rôles — mais un
    // `@UseGuards(RolesGuard)` posé sans `@Roles`, si.
    const allowed: readonly UserRole[] = declared ?? USER_ROLES;

    const request = context.switchToHttp().getRequest<Request>();
    const user = getAuthenticatedUser(request);

    if (user === undefined) {
      // `JwtAuthGuard` n'a pas tourné, ou a laissé passer sans identité. 401 et
      // non 403 : il n'y a personne à qui refuser un droit.
      throw new UnauthorizedException('Route non authentifiée.');
    }

    if (!allowed.includes(user.role)) {
      // `details` ne cite que la **route** — les rôles qu'elle exige, une
      // information déjà publiée par le document OpenAPI. Aucun identifiant de
      // ressource, aucun rôle du porteur : le premier dirait ce qui existe, le
      // second confirmerait au voleur d'un jeton ce qu'il vient de dérober.
      throw new ForbiddenError('Droits insuffisants pour cette opération.', {
        requiredRoles: [...allowed],
      });
    }

    return true;
  }
}
