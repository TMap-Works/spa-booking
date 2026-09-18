import { Injectable } from '@nestjs/common';
import { isBillingOpen } from '@spa/shared';

import { IdentityRepository } from './identity.repository';
import type { TenantBillingRecord } from './identity.types';

/**
 * Le salon est-il ouvert ? — ADR 0016.
 *
 * Un salon inscrit seul reste ouvert tant que son abonnement est en essai,
 * payé ou en relance de paiement ; il se ferme quand le paiement n'a jamais
 * abouti ou que l'abonnement est résilié. Les salons ouverts par la console
 * (`managed`) ne sont pas facturés et restent ouverts.
 *
 * ## Un cache court, et pourquoi il suffit
 *
 * La garde s'exécute sur **chaque** requête authentifiée du back-office : une
 * lecture de base par requête pour une valeur qui change quelques fois par an
 * serait un coût sans objet. La réponse est gardée vingt secondes par
 * établissement, et invalidée sur place quand ce processus écrit la
 * facturation (`invalidate`). Une autre instance verra le changement au plus
 * vingt secondes plus tard — pour une résiliation, c'est sans conséquence.
 *
 * La lecture passe par le client **scopé** : la portée doit donc déjà être
 * posée sur l'établissement demandé, ce que font `JwtAuthGuard` et le
 * middleware de résolution publique avant toute garde.
 */

const CACHE_TTL_MS = 20_000;

interface CachedBilling {
  readonly record: TenantBillingRecord | null;
  readonly expiresAt: number;
}

@Injectable()
export class TenantBillingGate {
  private readonly cache = new Map<string, CachedBilling>();

  public constructor(private readonly repository: IdentityRepository) {}

  /** L'état de facturation du salon courant, `null` s'il est introuvable. */
  public async billingOf(tenantId: string): Promise<TenantBillingRecord | null> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);

    if (cached !== undefined && cached.expiresAt > now) {
      return cached.record;
    }

    const record = await this.repository.findCurrentTenantBilling();
    this.cache.set(tenantId, { record, expiresAt: now + CACHE_TTL_MS });
    return record;
  }

  /**
   * `true` si le salon est ouvert. Un salon introuvable est **ouvert** ici : la
   * garde n'est pas le lieu où l'on découvre qu'un établissement n'existe pas —
   * la résolution de portée l'a déjà refusé en amont, et fermer sur un doute
   * transformerait une panne de lecture en 402 pour tout le monde.
   */
  public async isOpen(tenantId: string): Promise<boolean> {
    const billing = await this.billingOf(tenantId);
    return billing === null || isBillingOpen(billing.status);
  }

  /** À appeler par qui vient d'écrire la facturation d'un salon. */
  public invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
