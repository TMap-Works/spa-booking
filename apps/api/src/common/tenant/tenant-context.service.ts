import { Injectable } from '@nestjs/common';

import {
  getTenantId,
  hasTenantScope,
  requireTenantId,
  runInTenantScope,
  runWithTenant,
  setRequestTenantId,
} from './tenant-context';

/**
 * Façade injectable du contexte de tenant.
 *
 * Les fonctions de `tenant-context.ts` sont la mécanique ; celle-ci est la
 * surface que le reste de l'application utilise. Un service métier injecte
 * `TenantContextService` plutôt que d'importer des fonctions de module : c'est
 * la convention Nest, et c'est surtout ce qui permet à un test unitaire de
 * substituer le contexte sans toucher à un état global.
 *
 * Elle ne porte **aucun état** — tout vit dans le store `AsyncLocalStorage`,
 * partagé. Deux instances de ce service (module réimporté, test qui en
 * construit une) verraient donc le même contexte, ce qui est précisément la
 * propriété qu'on veut.
 */
@Injectable()
export class TenantContextService {
  /** Ouvre une portée vide — le middleware HTTP, à chaque requête entrante. */
  public runInScope<T>(fn: () => T): T {
    return runInTenantScope(fn);
  }

  /** Ouvre une portée déjà résolue — traitement hors requête, tenant explicite. */
  public runWithTenant<T>(tenantId: string, fn: () => T): T {
    return runWithTenant(tenantId, fn);
  }

  /**
   * Résout le tenant de la requête en cours — **une fois**, depuis une source
   * vérifiée côté serveur (claim d'un JWT validé, slug résolu contre la table
   * `tenants`). Jamais depuis un corps, un paramètre d'URL ou un en-tête.
   */
  public setTenantId(tenantId: string): void {
    setRequestTenantId(tenantId);
  }

  /** Le tenant courant, ou `undefined`. */
  public getTenantId(): string | undefined {
    return getTenantId();
  }

  /** Le tenant courant, ou `MissingTenantContextError`. */
  public requireTenantId(): string {
    return requireTenantId();
  }

  /** `true` si une portée est ouverte, résolue ou non. */
  public hasScope(): boolean {
    return hasTenantScope();
  }
}
