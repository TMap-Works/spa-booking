import { Inject, Injectable } from '@nestjs/common';
import type { TenantBillingStatus as PrismaBillingStatus } from '@prisma/client';
import type { Locale, TenantBillingStatus } from '@spa/shared';

import {
  PRISMA,
  type ScopedPrismaClient,
} from '../../../infrastructure/database/prisma-clients';
import { toAccountLocale, toTenantLocale } from '../../identity/locale';

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
  /**
   * La langue de l'établissement — le repli quand le gérant n'a exprimé aucune
   * préférence (#1231). Toujours rendue : la colonne est `NOT NULL`, et
   * `toTenantLocale` couvre la valeur qui aurait échappé à sa contrainte.
   */
  readonly defaultLocale: Locale;
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
  defaultLocale: true,
} as const;

@Injectable()
export class BillingRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  public async findCurrent(): Promise<BillingRecord | null> {
    const row = await this.prisma.tenant.findFirst({ select: BILLING_SELECT });

    if (row === null) {
      return null;
    }

    const { billingStatus, defaultLocale, ...rest } = row;
    return {
      ...rest,
      status: billingStatus.toLowerCase() as TenantBillingStatus,
      defaultLocale: toTenantLocale(defaultLocale),
    };
  }

  /**
   * La langue que **ce compte** a choisie, ou `null` — « aucune préférence
   * enregistrée » (#1231).
   *
   * `null` n'est pas un défaut déguisé : c'est l'appelant qui retombe alors sur
   * `defaultLocale` de l'établissement, déjà lu par `findCurrent`. Les confondre
   * ferait paraître choisie une langue que personne n'a demandée — l'invariant
   * de #844, tenu ici par `toAccountLocale`.
   *
   * Le client est scopé : le compte d'un établissement voisin est introuvable,
   * et se lit donc « aucune préférence », jamais la préférence du voisin.
   */
  public async findAccountLocale(userId: string): Promise<Locale | null> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { locale: true },
    });

    return toAccountLocale(row?.locale ?? null);
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
