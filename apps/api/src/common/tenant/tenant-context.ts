import { AsyncLocalStorage } from 'node:async_hooks';

import {
  InvalidTenantIdError,
  MissingTenantContextError,
  TenantAlreadyResolvedError,
  TenantScopeNotOpenError,
} from './tenant-context.errors';

/**
 * Le tenant courant, porté par la requête et non par un paramètre.
 *
 * Répéter `where: { tenantId }` dans chaque requête finit toujours par un
 * oubli, et un oubli est une fuite entre salons concurrents (tenant-isolation
 * §3). Le passer de main en main jusqu'au repository n'est pas mieux : la
 * signature qui l'oublie compile, et le premier service qui appelle Prisma sans
 * l'avoir reçu lit tout.
 *
 * `AsyncLocalStorage` résout les deux : le tenant suit la requête à travers
 * toutes ses continuations asynchrones — contrôleur, service, repository,
 * `Promise.all`, `setImmediate` — sans qu'aucune signature n'ait à le nommer, et
 * sans qu'aucune requête concurrente ne puisse voir celui d'une autre.
 *
 * ## Pourquoi un singleton de module et non un champ d'instance
 *
 * Le store vit ici, en constante de module, et non dans `TenantContextService`.
 * Trois appelants doivent le lire et n'ont pas tous accès à l'injection de
 * dépendances : l'extension Prisma (construite par une fabrique), le décorateur
 * `@CurrentTenant()` (`createParamDecorator` n'injecte rien), et le middleware.
 * Un champ d'instance obligerait à les recâbler tous, et deux instances du
 * service — un module réimporté sans être `@Global`, un test qui en construit
 * une — verraient deux contextes différents. Le pire mode de défaillance de ce
 * fichier serait un lecteur qui, silencieusement, ne trouve rien.
 *
 * ## Ce que le store ne contient pas
 *
 * Rien d'autre que le tenant. Pas d'utilisateur, pas de rôle, pas de trace : un
 * contexte fourre-tout devient vite le chemin le plus court pour faire voyager
 * une donnée personnelle jusqu'à un log.
 */

/**
 * Portée d'une requête. `tenantId` est **mutable** : la portée s'ouvre vide dès
 * l'entrée HTTP, et le résolveur (garde d'authentification #21, résolution par
 * slug public #23) la renseigne ensuite, une fois. Ouvrir la portée au plus tôt
 * garantit qu'aucune continuation ne s'échappe du store ; la renseigner plus
 * tard laisse le résolveur faire son travail — lire un jeton, interroger la
 * table `tenants` — dans la portée elle-même.
 */
interface TenantScope {
  tenantId: string | undefined;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Rejette au plus tôt ce qui ne peut pas être un identifiant de tenant. */
function normalize(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new InvalidTenantIdError();
  }
  return tenantId;
}

/**
 * Ouvre une portée de tenant **vide** pour la durée de `fn`.
 *
 * C'est ce que fait le middleware HTTP sur chaque requête entrante. La portée
 * vide n'est pas un état dégradé : tant que personne n'a résolu le tenant,
 * toute opération de données échoue — ce qui est le comportement voulu.
 */
export function runInTenantScope<T>(fn: () => T): T {
  return storage.run({ tenantId: undefined }, fn);
}

/**
 * Ouvre une portée **déjà résolue** — pour un traitement hors requête HTTP :
 * consommateur SQS, tâche planifiée, script de reprise. Chaque appel désigne un
 * tenant explicitement, ce qui reste vrai à la relecture six mois plus tard.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId: normalize(tenantId) }, fn);
}

/**
 * Renseigne le tenant de la requête en cours. **Seul point d'écriture du
 * contexte** : c'est ici que passeront la claim du JWT (#21) et la résolution
 * par slug des pages publiques (#23), et nulle part ailleurs.
 *
 * L'appelant est toujours du code serveur qui a *vérifié* sa source. Ni un
 * corps JSON, ni un paramètre d'URL, ni un en-tête ne parviennent jusqu'ici :
 * aucune fonction de ce fichier ne lit la requête HTTP.
 */
export function setRequestTenantId(tenantId: string): void {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new TenantScopeNotOpenError();
  }
  if (scope.tenantId !== undefined) {
    throw new TenantAlreadyResolvedError();
  }
  scope.tenantId = normalize(tenantId);
}

/** Le tenant courant, ou `undefined` — pour qui sait quoi faire de l'absence. */
export function getTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/** `true` si une portée est ouverte, résolue ou non. Diagnostic, pas décision. */
export function hasTenantScope(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Le tenant courant, ou une erreur. **Jamais `undefined`, jamais « tous les
 * tenants »** : c'est cette fonction que l'extension Prisma appelle avant
 * chaque opération, et son refus est ce qui tient l'isolation.
 */
export function requireTenantId(model?: string, operation?: string): string {
  const tenantId = getTenantId();
  if (tenantId === undefined) {
    throw new MissingTenantContextError(model, operation);
  }
  return tenantId;
}
