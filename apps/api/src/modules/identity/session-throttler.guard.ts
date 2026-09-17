import { Injectable, SetMetadata, type CustomDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';

import { readRefreshCookie } from './refresh-cookie';
import { TokenService } from './token.service';

/**
 * Limitation de débit comptée **par session** là où l'adresse IP ne dit plus
 * rien (#860).
 *
 * ## Le défaut corrigé
 *
 * `ThrottlerGuard` compte par `req.ip`, et c'est le bon compteur tant que
 * l'adresse désigne quelqu'un. Sur `POST /auth/refresh`, elle ne désigne
 * personne : **aucun navigateur n'appelle cette route**. Le jeton de
 * rafraîchissement est un cookie `httpOnly` posé sur le domaine du front, et
 * c'est le serveur Next qui le relaie à l'API (`apps/web/lib/api-client.ts`).
 * Tous les renouvellements de tous les établissements partent donc de la même
 * adresse — celle de la tâche ECS du front —, et `trust proxy` n'y changerait
 * rien puisqu'il n'y a pas de mandataire : c'est un appel serveur à serveur.
 *
 * Les trente renouvellements par minute étaient donc trente pour **tout le
 * produit**. Un salon un peu actif suffisait à refuser les renouvellements des
 * autres, et le front lisait ce refus comme une déconnexion.
 *
 * ## Ce qui remplace l'adresse : le `sid` du jeton
 *
 * Le jeton de rafraîchissement porte l'identifiant de **session** (`sid`,
 * `token.service.ts`), et cet identifiant est le seul qui tienne : il est stable
 * d'une rotation à l'autre — contrairement au `jti`, neuf à chaque émission,
 * dont un compteur repartirait de zéro à chaque renouvellement réussi et ne
 * limiterait donc rien.
 *
 * Le jeton est **vérifié** avant d'en tirer le compteur, et ce n'est pas une
 * précaution de forme. Un `sid` lu sans vérifier la signature serait une valeur
 * que l'appelant choisit : il lui suffirait d'en tirer une neuve à chaque
 * requête pour n'être jamais compté, et chaque valeur inventée créerait une
 * entrée de plus dans le stockage du limiteur — un quota contournable, doublé
 * d'une consommation mémoire sans borne. La vérification est un HMAC-SHA256 sur
 * quelques centaines d'octets, que le service refait de toute façon juste
 * après.
 *
 * ## Le repli, et pourquoi il reste l'adresse IP
 *
 * Sans cookie, ou avec un jeton que la signature refuse, la requête ne prouve
 * aucune session : elle retombe sur `req.ip`, c'est-à-dire sur le comportement
 * d'origine. C'est le cas d'un attaquant — qui reste borné par l'adresse d'où il
 * tire — et celui d'une session réellement morte, qui recevra un 401 au premier
 * essai et ne réessaiera pas : le front efface alors ses cookies (#856).
 *
 * ## Pourquoi une garde et non l'option `getTracker` de `@Throttle`
 *
 * `@Throttle({ default: { getTracker } })` accepte bien une fonction par route,
 * mais une fonction posée dans un décorateur n'est pas un fournisseur : elle n'a
 * pas `TokenService`, donc pas le secret, donc pas de vérification possible.
 * D'où une garde, qui est le seul endroit où l'injection existe.
 */

/**
 * Marque une route dont le quota se compte par session.
 *
 * Le marquage est explicite plutôt que déduit de la présence du cookie : le
 * cookie de rafraîchissement est posé sur `/api/v1/auth`, donc joint aussi à
 * `/auth/login`, et y compter par session rendrait le forçage de mots de passe
 * **amplifiable** — une session ouverte donne un compteur neuf, et l'on ouvre
 * une session avec le compte que l'on possède déjà. Le quota de la connexion
 * doit rester attaché à l'origine de l'appel.
 */
export const THROTTLE_BY_SESSION = 'identity/throttle-by-session';

/** @see THROTTLE_BY_SESSION */
export const ThrottleBySession = (): CustomDecorator<string> =>
  SetMetadata(THROTTLE_BY_SESSION, true);

@Injectable()
export class SessionThrottlerGuard extends ThrottlerGuard {
  public constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokenService,
  ) {
    super(options, storage, reflector);
  }

  /**
   * Le compteur de cette requête.
   *
   * `context` est déclaré **facultatif** bien qu'il soit toujours passé : le
   * type public `ThrottlerGetTrackerFunction` le prévoit — `(req, context)` — et
   * la garde l'appelle bien avec deux arguments, mais la méthode de la classe de
   * base, elle, n'en déclare qu'un. Une redéfinition qui exigerait le second ne
   * serait pas assignable à celle qu'elle remplace, et TypeScript la refuserait.
   */
  protected override async getTracker(
    request: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<string> {
    if (context !== undefined && this.tracksBySession(context)) {
      const session = await this.sessionTracker(request as unknown as Request);

      if (session !== null) {
        return session;
      }
    }

    return super.getTracker(request);
  }

  /** La route demande-t-elle un compteur par session ? */
  private tracksBySession(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(THROTTLE_BY_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /**
   * La session que cette requête prouve, ou `null` si elle n'en prouve aucune.
   *
   * Préfixé : le compteur est une chaîne libre, et deux sources qui s'y
   * mélangeraient — un `sid` et une adresse IP — se confondraient un jour.
   */
  private async sessionTracker(request: Request): Promise<string | null> {
    const token = readRefreshCookie(request);

    if (token === null) {
      return null;
    }

    try {
      const { sid } = await this.tokens.verifyRefreshToken(token);
      return `session:${sid}`;
    } catch {
      // Jeton contrefait, expiré ou illisible : il ne désigne aucune session, et
      // le laisser en désigner une serait rendre le quota contournable.
      return null;
    }
  }
}
