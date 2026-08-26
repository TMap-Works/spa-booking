import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { NotFoundError } from '../errors';
import { AppConfigService } from '../../config/app-config.service';
import {
  describePublicTenantRequest,
  publicBaseHost,
  type PublicTenantDesignation,
} from './public-tenant-request';
import { PUBLIC_TENANT_RESOLVER, type PublicTenantResolver } from './public-tenant.resolver';
import { runInTenantScope, setRequestTenantId } from './tenant-context';

/** Toute désignation publique sauf « ce n'est pas une route publique ». */
type DesignatedPublicTenant = Exclude<PublicTenantDesignation, { kind: 'none' }>;

/**
 * Un seul message pour les quatre refus. Il ne nomme pas le slug : ce corps
 * d'erreur finit dans les journaux du front, et le renvoyer en ferait un miroir
 * pour qui sonde des noms d'établissements.
 */
const TENANT_NOT_FOUND_MESSAGE = 'Établissement introuvable.';

/**
 * Ouvre la portée de tenant de chaque requête HTTP, et la **résout** pour les
 * pages de réservation publiques.
 *
 * ## Pourquoi un middleware, et pas une garde
 *
 * Le cycle de Nest est : middleware → garde → intercepteur → pipe → gestionnaire.
 * La portée doit être ouverte **avant** la garde d'authentification (#21), parce
 * que c'est elle qui la renseignera sur les routes authentifiées :
 * `setRequestTenantId` refuse d'écrire hors portée. Une garde qui ouvrirait
 * elle-même la portée avec `storage.run(…)` la refermerait en rendant la main —
 * le contrôleur s'exécuterait hors contexte.
 *
 * C'est aussi ce qui donne au refus public sa propriété la plus importante : un
 * slug inconnu est refusé **ici**, donc avant la garde, avant le pipe, avant le
 * contrôleur. Aucun code métier ne s'exécute pour un établissement qui n'existe
 * pas, et il n'y a donc aucun endroit où l'on aurait pu oublier de vérifier.
 *
 * ## Les deux façons dont le tenant entre dans la requête
 *
 * | Route | Qui résout | Depuis quoi |
 * |---|---|---|
 * | `/api/v1/public/…` | ce middleware | sous-domaine ou slug d'URL, résolu en base |
 * | authentifiée | `JwtAuthGuard` (#21) | la revendication d'un jeton vérifié |
 * | `/api/v1/auth/login` | `AuthService` (#21) | le slug du corps, résolu en base |
 *
 * Dans les trois cas, ce qui entre dans le contexte est un identifiant **lu en
 * base**, jamais la chaîne fournie par le client. Le slug ne donne aucun accès :
 * il désigne un établissement, et tout ce qui n'est pas public y reste gardé —
 * `JwtAuthGuard` refuse (401) un jeton dont le tenant contredit la portée déjà
 * résolue, et n'en accorde aucun en son absence.
 *
 * ## Pourquoi la résolution publique ne s'applique qu'à l'espace public
 *
 * L'en-tête `Host` est fourni par le client. Le lire sur une route authentifiée
 * laisserait un tiers pré-remplir la portée de la requête d'autrui. Sur l'espace
 * public, la même manœuvre ne rend que ce qui est déjà public — et le désaccord
 * avec le slug d'URL est refusé (`public-tenant-request.ts`). Hors de cet
 * espace, le middleware ne lit ni l'hôte ni le chemin : la portée s'ouvre vide,
 * exactement comme avant #23.
 *
 * ## Portée vide plutôt que pas de portée
 *
 * Une requête non résolue — `/health`, une route authentifiée avant sa garde —
 * traverse ce middleware comme les autres. Elle obtient une portée ouverte mais
 * vide, ce qui n'est pas un état dégradé : toute opération de données y échoue
 * (`MissingTenantContextError`), là où l'absence totale de portée aurait le même
 * effet en masquant la cause. La distinction se lit dans `hasTenantScope()`.
 */
@Injectable()
export class TenantScopeMiddleware implements NestMiddleware {
  /**
   * Le domaine sous lequel un sous-domaine désigne un établissement, calculé une
   * fois : `APP_URL` est figée au démarrage, et reparser une URL à chaque requête
   * pour en tirer la même chaîne serait payé sur le chemin le plus chaud de
   * l'API.
   */
  private readonly baseHost: string | null;

  public constructor(
    config: AppConfigService,
    @Inject(PUBLIC_TENANT_RESOLVER) private readonly tenants: PublicTenantResolver,
  ) {
    this.baseHost = publicBaseHost(config.appUrl);
  }

  public use(request: Request, _response: Response, next: NextFunction): void | Promise<void> {
    // `originalUrl` et non `url` : Express réécrit le second selon le point de
    // montage du middleware.
    const designation = describePublicTenantRequest(
      request.originalUrl,
      request.headers.host,
      this.baseHost,
    );

    if (designation.kind === 'none') {
      // Route non publique : rien à résoudre, et surtout rien à lire dans la
      // requête. `next()` est appelé **dans** la portée, donc tout ce que la
      // suite de la chaîne démarre — gardes, contrôleur, repositories,
      // `Promise.all` — en hérite. `AsyncLocalStorage` propage le store aux
      // continuations asynchrones : la portée ne se referme pas au retour de
      // `run`.
      runInTenantScope(() => {
        next();
      });
      return undefined;
    }

    // La portée est ouverte **avant** la résolution, et la résolution a lieu
    // dedans : `setRequestTenantId` n'a de sens qu'en portée ouverte, et le
    // store suit la continuation du `await`.
    return runInTenantScope(async () => {
      setRequestTenantId(await this.resolveOrRefuse(designation));
      next();
    });
  }

  /**
   * L'identifiant de l'établissement désigné, ou un 404 qui arrête la requête.
   *
   * L'exception traverse `use` — Nest enveloppe chaque middleware dans un proxy
   * qui attend son retour et confie ce qu'il rejette aux filtres d'exception
   * (`RouterProxy`). `DomainExceptionFilter` la rend donc en
   * `{ code: "NOT_FOUND", … }`, la forme d'erreur de toute l'API, et `next()`
   * n'est jamais appelé : la chaîne s'arrête avant la garde et le contrôleur.
   *
   * **404 et non 403** : un 403 confirmerait qu'un établissement porte ce slug
   * (tenant-isolation §4). Et un seul et même 404 couvre « slug inconnu »,
   * « établissement désactivé », « slug mal formé » et « sous-domaine en
   * désaccord » — quatre refus qu'il n'y a aucune raison de laisser distinguer,
   * puisque la différence ne renseignerait que celui qui sonde.
   */
  private async resolveOrRefuse(designation: DesignatedPublicTenant): Promise<string> {
    if (designation.kind === 'unresolvable') {
      throw new NotFoundError(TENANT_NOT_FOUND_MESSAGE);
    }

    const tenantId = await this.tenants.findTenantIdBySlug(designation.slug);
    if (tenantId === null) {
      throw new NotFoundError(TENANT_NOT_FOUND_MESSAGE);
    }
    return tenantId;
  }
}
