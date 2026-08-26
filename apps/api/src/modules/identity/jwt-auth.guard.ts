import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';

import { getTenantId, setRequestTenantId } from '../../common/tenant';
import type { AuthenticatedUser } from './identity.types';
import { TokenService } from './token.service';

/**
 * Garde d'authentification par jeton d'accès.
 *
 * C'est **le** point où l'identité entre dans l'application, et il ne lit qu'une
 * chose : l'en-tête `Authorization: Bearer`. Le jeton est vérifié — signature et
 * expiration — avant que la moindre de ses revendications ne soit utilisée. Une
 * revendication d'un jeton non vérifié n'est qu'une chaîne fournie par le client.
 *
 * ## Ce que la garde fait du `tenantId`
 *
 * Elle le pose dans le contexte de requête (`setRequestTenantId`), ce qui arme le
 * scoping automatique de Prisma pour toute la suite : contrôleur, service,
 * repository. Le tenant vient donc d'une revendication **signée**, jamais d'un
 * en-tête, d'un paramètre ou d'un corps — c'est la garantie que
 * tenant-isolation §2 exige, et elle tient ici par construction : aucune autre
 * ligne de ce fichier ne lit la requête.
 *
 * Le middleware `TenantScopeMiddleware` a déjà ouvert une portée **vide** : la
 * garde la renseigne, elle ne l'ouvre pas. Une garde qui ouvrirait la portée la
 * refermerait en rendant la main, et le contrôleur s'exécuterait hors contexte.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  public constructor(private readonly tokens: TokenService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = JwtAuthGuard.bearerToken(request);
    if (token === null) {
      throw new UnauthorizedException('Jeton d’accès absent ou mal formé.');
    }

    const claims = await this.tokens.verifyAccessToken(token);
    if (claims === null) {
      // Un seul message pour « signature invalide », « expiré » et « mauvais
      // type » : la nuance renseignerait le porteur d'un jeton volé.
      throw new UnauthorizedException('Jeton d’accès invalide ou expiré.');
    }

    const user: AuthenticatedUser = {
      userId: claims.sub,
      tenantId: claims.tenantId,
      role: claims.role,
    };

    if (getTenantId() === undefined) {
      setRequestTenantId(claims.tenantId);
    } else if (getTenantId() !== claims.tenantId) {
      // La portée a déjà été résolue sur un autre établissement — par la
      // résolution publique par slug, par exemple. Poursuivre choisirait
      // silencieusement l'un des deux ; refuser est la seule issue sûre.
      throw new UnauthorizedException('Le jeton ne correspond pas à l’établissement de la requête.');
    }

    setAuthenticatedUser(request, user);
    return true;
  }

  /**
   * Extrait le jeton de l'en-tête `Authorization`.
   *
   * Le schéma est comparé sans tenir compte de la casse (`Bearer`, `bearer`), et
   * la valeur doit être non vide — `Authorization: Bearer ` sans jeton ne doit pas
   * produire une chaîne vide qui irait jusqu'au vérificateur.
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
 * Emplacement de l'identité sur la requête.
 *
 * Un `Symbol` plutôt que `request.user` : la propriété `user` est convoitée par
 * beaucoup de bibliothèques, et une collision silencieuse remplacerait l'identité
 * vérifiée par autre chose. Le symbole n'est pas énumérable dans un
 * `JSON.stringify(request)`, ce qui évite aussi de le voir partir dans un log.
 */
const AUTHENTICATED_USER = Symbol('AUTHENTICATED_USER');

interface RequestWithUser extends Request {
  [AUTHENTICATED_USER]?: AuthenticatedUser;
}

function setAuthenticatedUser(request: Request, user: AuthenticatedUser): void {
  (request as RequestWithUser)[AUTHENTICATED_USER] = user;
}

export function getAuthenticatedUser(request: Request): AuthenticatedUser | undefined {
  return (request as RequestWithUser)[AUTHENTICATED_USER];
}

/**
 * L'identité vérifiée, injectée dans un paramètre de contrôleur.
 *
 * Lève si la garde n'a pas tourné : un contrôleur qui réclame l'utilisateur sans
 * être gardé est un défaut de câblage, et le silence y répondrait `undefined` —
 * qui finirait en `where: { id: undefined }`, c'est-à-dire en « n'importe quelle
 * ligne ».
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request>();
    const user = getAuthenticatedUser(request);
    if (user === undefined) {
      throw new UnauthorizedException('Route non authentifiée.');
    }
    return user;
  },
);
