import { Inject, Injectable } from '@nestjs/common';
import type { TenantBillingStatus as PrismaBillingStatus } from '@prisma/client';
import type { TenantBillingStatus } from '@spa/shared';

import {
  PRISMA,
  type ScopedPrismaClient,
} from '../../../infrastructure/database/prisma-clients';

/**
 * La facturation du salon **courant** — ADR 0016.
 *
 * Client scopé et sans `where` : l'extension borne le modèle racine sur son
 * `id`, depuis la portée que la garde d'authentification (ou le webhook, par
 * `runWithTenant`) a posée. Aucune méthode ne prend d'identifiant de salon.
 */

export interface BillingRecord {
  readonly slug: string;
  readonly name: string;
  readonly contactEmail: string | null;
  readonly status: TenantBillingStatus;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEndsAt: Date | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeCheckoutSessionId: string | null;
}

export interface BillingChanges {
  readonly status?: TenantBillingStatus;
  readonly trialEndsAt?: Date | null;
  readonly currentPeriodEndsAt?: Date | null;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly stripeCheckoutSessionId?: string | null;
}

const BILLING_SELECT = {
  slug: true,
  name: true,
  contactEmail: true,
  billingStatus: true,
  trialEndsAt: true,
  currentPeriodEndsAt: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  stripeCheckoutSessionId: true,
} as const;

@Injectable()
export class BillingRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  public async findCurrent(): Promise<BillingRecord | null> {
    const row = await this.prisma.tenant.findFirst({ select: BILLING_SELECT });

    if (row === null) {
      return null;
    }

    const { billingStatus, ...rest } = row;
    return { ...rest, status: billingStatus.toLowerCase() as TenantBillingStatus };
  }

  public async updateCurrent(changes: BillingChanges): Promise<void> {
    const { status, ...rest } = changes;

    await this.prisma.tenant.updateMany({
      data: {
        ...rest,
        ...(status === undefined
          ? {}
          : { billingStatus: status.toUpperCase() as PrismaBillingStatus }),
      },
    });
  }
}
