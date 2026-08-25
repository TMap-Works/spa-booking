import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runInTenantScope } from './tenant-context';

/**
 * Ouvre une portée de tenant **vide** pour la durée de chaque requête HTTP.
 *
 * ## Pourquoi un middleware, et pas une garde
 *
 * Le cycle de Nest est : middleware → garde → intercepteur → pipe → gestionnaire.
 * La portée doit être ouverte **avant** la garde d'authentification (#21), parce
 * que c'est la garde qui la renseignera : `setRequestTenantId` refuse d'écrire
 * hors portée. Une garde qui ouvrirait elle-même la portée avec
 * `storage.run(…)` la refermerait en rendant la main — le contrôleur
 * s'exécuterait hors contexte.
 *
 * Cette classe est le seul endroit de l'application qui reçoit un objet
 * `Request` et touche au contexte de tenant, et elle n'en lit **rien** : ni
 * en-tête, ni paramètre, ni corps. La portée s'ouvre vide, et seul un résolveur
 * serveur — claim d'un JWT vérifié (#21), slug résolu contre la table `tenants`
 * (#23) — la renseigne ensuite. C'est ce qui rend vrai le critère « le
 * `tenantId` ne peut jamais venir d'un body, d'un query param ou d'un en-tête » :
 * aucun chemin de code ne relie l'un à l'autre.
 *
 * ## Portée vide plutôt que pas de portée
 *
 * Une requête non authentifiée — `/health`, une page publique avant résolution —
 * traverse ce middleware comme les autres. Elle obtient une portée ouverte mais
 * non résolue, ce qui n'est pas un état dégradé : toute opération de données y
 * échoue (`MissingTenantContextError`), là où l'absence totale de portée aurait
 * le même effet en masquant la cause. La distinction se lit dans
 * `hasTenantScope()`, et sert au diagnostic : « personne n'a résolu le tenant »
 * n'est pas le même défaut que « le middleware n'est pas branché ».
 */
@Injectable()
export class TenantScopeMiddleware implements NestMiddleware {
  public use(_request: Request, _response: Response, next: NextFunction): void {
    // `next()` est appelé **dans** la portée : tout ce que la suite de la chaîne
    // démarre — gardes, contrôleur, repositories, `Promise.all` — en hérite.
    // `AsyncLocalStorage` propage le store aux continuations asynchrones, la
    // portée ne se referme donc pas au retour de `run`.
    runInTenantScope(() => {
      next();
    });
  }
}
