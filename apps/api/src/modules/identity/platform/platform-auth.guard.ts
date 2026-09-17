import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { getTenantId } from '../../../common/tenant';
import { PlatformRepository } from './platform.repository';
import { PlatformTokenService } from './platform-token.service';
import type { AuthenticatedOperator } from './platform.types';

/**
 * Garde de la console plateforme — le pendant de `JwtAuthGuard`, et son
 * contraire sur le point qui compte.
 *
 * `JwtAuthGuard` lit un `tenantId` signé et le pose dans le contexte de requête,
 * ce qui **arme** le scoping Prisma pour toute la suite. Celle-ci ne pose rien :
 * un opérateur plateforme n'a pas d'établissement (ADR 0012), et la portée reste
 * donc **vide** pour toute la durée de la requête. C'est ce qui garantit le
 * second sens du critère 5 — un jeton plateforme ne peut pas lire les données
 * d'un salon, parce que le client scopé refuserait toute opération hors portée.
 *
 * ## Elle refuse une portée déjà résolue
 *
 * `TenantScopeMiddleware` ouvre une portée vide, que la résolution publique par
 * slug peut avoir renseignée — une requête reçue sur `maison-lotus.exemple.test`
 * par exemple. Une route de console atteinte dans ce contexte serait une route
 * de plateforme servie sous l'identité d'un salon : on refuse plutôt que
 * d'arbitrer, exactement comme `JwtAuthGuard` refuse un jeton qui contredit la
 * portée déjà posée.
 *
 * ## Elle relit l'opérateur en base, contrairement à sa jumelle
 *
 * `JwtAuthGuard` se contente des revendications signées : relire le compte à
 * chaque requête coûterait une lecture par appel sur la totalité du trafic d'un
 * salon, pour fermer une fenêtre de quinze minutes. Le calcul s'inverse ici. Le
 * trafic d'une console d'éditeur se compte en dizaines de requêtes par jour, et
 * ce qu'un jeton encore valide laisse faire — ouvrir des établissements au nom
 * de la plateforme — ne se rattrape pas. Un opérateur désactivé perd donc son
 * accès **immédiatement**, et non à l'expiration de son jeton.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  public constructor(
    private readonly tokens: PlatformTokenService,
    private readonly repository: PlatformRepository,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = PlatformAuthGuard.bearerToken(request);
    if (token === null) {
      throw new UnauthorizedException('Jeton de console absent ou mal formé.');
    }

    const claims = await this.tokens.verifyAccessToken(token);
    if (claims === null) {
      // Un seul message pour « signature invalide », « expiré », « mauvais
      // type » — et pour un jeton d'établissement présenté ici. La nuance
      // renseignerait le porteur d'un jeton volé.
      throw new UnauthorizedException('Jeton de console invalide ou expiré.');
    }

    if (getTenantId() !== undefined) {
      throw new UnauthorizedException(
        'Une route de console ne se sert pas sous l’identité d’un établissement.',
      );
    }

    const operator = await this.repository.findActiveOperatorById(claims.sub);
    if (operator === null) {
      // Compte supprimé ou désactivé entre l'émission du jeton et maintenant.
      // Même message que ci-dessus : l'état d'un compte d'opérateur ne s'apprend
      // pas d'un refus.
      throw new UnauthorizedException('Jeton de console invalide ou expiré.');
    }

    setAuthenticatedOperator(request, { operatorId: operator.id, email: operator.email });
    return true;
  }

  /**
   * Extrait le jeton de l'en-tête `Authorization`, schéma comparé sans tenir
   * compte de la casse et valeur non vide — la lecture de `JwtAuthGuard`, à
   * l'identique.
   */
  private static bearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      return null;
    }
    const separator = header.indexOf(' ');
    if (separator === -1) {
      return null;
    }
    if (header.slice(0, separator).toLowerCase() !== 'bearer') {
      return null;
    }
    const token = header.slice(separator + 1).trim();
    return token === '' ? null : token;
  }
}

/**
 * Emplacement de l'opérateur sur la requête — un `Symbol`, pour la raison qui
 * vaut côté établissement : `request.user` est convoitée par beaucoup de
 * bibliothèques, et elle n'est pas énumérable dans un `JSON.stringify`.
 */
const AUTHENTICATED_OPERATOR = Symbol('AUTHENTICATED_OPERATOR');

interface RequestWithOperator extends Request {
  [AUTHENTICATED_OPERATOR]?: AuthenticatedOperator;
}

function setAuthenticatedOperator(request: Request, operator: AuthenticatedOperator): void {
  (request as RequestWithOperator)[AUTHENTICATED_OPERATOR] = operator;
}

/**
 * L'opérateur vérifié, injecté dans un paramètre de contrôleur.
 *
 * Lève si la garde n'a pas tourné : un contrôleur qui réclame l'opérateur sans
 * être gardé est un défaut de câblage, et le silence répondrait `undefined` — qui
 * finirait en `where: { id: undefined }`, c'est-à-dire en « n'importe quelle
 * ligne ».
 */
export const CurrentOperator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedOperator => {
    const request = context.switchToHttp().getRequest<Request>();
    const operator = (request as RequestWithOperator)[AUTHENTICATED_OPERATOR];
    if (operator === undefined) {
      throw new UnauthorizedException('Route de console non authentifiée.');
    }
    return operator;
  },
);

/**
 * Déclaration d'accès d'une route de console, en un seul décorateur.
 *
 * Même raison d'être que `@Auth()` côté établissement : il rend impossible
 * d'écrire une route de console sans monter la garde qui la protège. Il n'y a
 * pas de variante par rôle — l'espace plateforme n'a qu'un rang, et en inventer
 * un second serait une décision d'ADR, pas un argument de décorateur.
 */
export function PlatformAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    UseGuards(PlatformAuthGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description:
        'Jeton de console absent, invalide ou expiré — y compris un jeton ' +
        'd’établissement, quel que soit son rôle.',
    }),
  );
}
