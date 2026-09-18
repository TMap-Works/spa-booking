import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { getTenantId } from '../../common/tenant/tenant-context';
import { SalonBookingClosedError, SubscriptionRequiredError } from './identity.errors';
import { TenantBillingGate } from './tenant-billing.gate';

/**
 * Les deux portes que ferme un abonnement inactif — ADR 0016.
 *
 * - `TenantBillingGuard` : le back-office. Posée par `Auth`, `AuthAtLeast` et
 *   `AuthWith` juste après `JwtAuthGuard`, qui a résolu la portée. Rend **402**
 *   `SUBSCRIPTION_REQUIRED`.
 * - `BookableSalonGuard` : la réservation publique — créneaux et prise de
 *   rendez-vous. Rend **409** `SALON_BOOKING_CLOSED`. La vitrine, elle, reste
 *   lisible : l'écran de connexion du back-office en a besoin pour que
 *   l'administrateur puisse venir rétablir l'abonnement.
 */

const ALLOW_UNPAID_TENANT = Symbol('ALLOW_UNPAID_TENANT');

/**
 * Laisse passer une route authentifiée même quand l'abonnement est inactif :
 * l'écran d'abonnement lui-même, et `GET /auth/me`, dont le back-office a besoin
 * pour savoir qu'il est fermé.
 */
export function AllowUnpaidTenant(): MethodDecorator & ClassDecorator {
  return SetMetadata(ALLOW_UNPAID_TENANT, true);
}

@Injectable()
export class TenantBillingGuard implements CanActivate {
  public constructor(
    private readonly gate: TenantBillingGate,
    private readonly reflector: Reflector,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_UNPAID_TENANT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed === true) {
      return true;
    }

    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // `JwtAuthGuard` pose la portée avant cette garde ; son absence est une
      // route mal décorée, pas un salon fermé.
      return true;
    }

    if (!(await this.gate.isOpen(tenantId))) {
      throw new SubscriptionRequiredError();
    }
    return true;
  }
}

@Injectable()
export class BookableSalonGuard implements CanActivate {
  public constructor(private readonly gate: TenantBillingGate) {}

  public async canActivate(): Promise<boolean> {
    const tenantId = getTenantId();
    if (tenantId !== undefined && !(await this.gate.isOpen(tenantId))) {
      throw new SalonBookingClosedError();
    }
    return true;
  }
}

/** Ferme une route publique de réservation quand le salon n'est plus abonné. */
export function RequireBookableSalon(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(BookableSalonGuard));
}
