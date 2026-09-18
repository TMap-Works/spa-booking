import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantBillingStatus } from '@spa/shared';

import { runWithTenant } from '../../../common/tenant';
import type { IdentityRepository } from '../identity.repository';
import { SalonBookingClosedError, SubscriptionRequiredError } from '../identity.errors';
import { TenantBillingGate } from '../tenant-billing.gate';
import { AllowUnpaidTenant, BookableSalonGuard, TenantBillingGuard } from '../tenant-billing.guard';

/**
 * La porte que ferme un abonnement inactif — ADR 0016.
 *
 * Trois propriétés : seuls `pending` et `canceled` ferment ; la route
 * d'abonnement reste ouverte à un salon fermé ; la lecture est mise en cache et
 * se vide sur demande.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function repositoryReturning(status: TenantBillingStatus | null): {
  repository: IdentityRepository;
  reads: () => number;
} {
  let reads = 0;
  const repository = {
    findCurrentTenantBilling: () => {
      reads += 1;
      return Promise.resolve(status === null ? null : { status, trialEndsAt: null });
    },
  } as unknown as IdentityRepository;
  return { repository, reads: () => reads };
}

class ProbeController {
  public screen(): void {
    /* sonde */
  }

  @AllowUnpaidTenant()
  public billingScreen(): void {
    /* sonde */
  }
}

function contextFor(handler: keyof ProbeController): ExecutionContext {
  return {
    getHandler: () => ProbeController.prototype[handler],
    getClass: () => ProbeController,
  } as unknown as ExecutionContext;
}

describe('TenantBillingGate', () => {
  it.each<[TenantBillingStatus, boolean]>([
    ['managed', true],
    ['trialing', true],
    ['active', true],
    ['past_due', true],
    ['pending', false],
    ['canceled', false],
  ])('un salon « %s » est ouvert : %s', async (status, open) => {
    const gate = new TenantBillingGate(repositoryReturning(status).repository);

    await expect(runWithTenant(TENANT, () => gate.isOpen(TENANT))).resolves.toBe(open);
  });

  it('laisse ouvert un salon introuvable plutôt que de fermer sur un doute', async () => {
    const gate = new TenantBillingGate(repositoryReturning(null).repository);

    await expect(runWithTenant(TENANT, () => gate.isOpen(TENANT))).resolves.toBe(true);
  });

  it('garde la lecture en cache, et la relit après invalidation', async () => {
    const { repository, reads } = repositoryReturning('active');
    const gate = new TenantBillingGate(repository);

    await runWithTenant(TENANT, () => gate.isOpen(TENANT));
    await runWithTenant(TENANT, () => gate.isOpen(TENANT));
    expect(reads()).toBe(1);

    gate.invalidate(TENANT);
    await runWithTenant(TENANT, () => gate.isOpen(TENANT));
    expect(reads()).toBe(2);
  });
});

describe('TenantBillingGuard', () => {
  it('rend 402 SUBSCRIPTION_REQUIRED sur un salon fermé', async () => {
    const guard = new TenantBillingGuard(
      new TenantBillingGate(repositoryReturning('canceled').repository),
      new Reflector(),
    );

    await expect(
      runWithTenant(TENANT, () => guard.canActivate(contextFor('screen'))),
    ).rejects.toBeInstanceOf(SubscriptionRequiredError);
  });

  it('laisse passer l’écran d’abonnement d’un salon fermé', async () => {
    const guard = new TenantBillingGuard(
      new TenantBillingGate(repositoryReturning('pending').repository),
      new Reflector(),
    );

    await expect(
      runWithTenant(TENANT, () => guard.canActivate(contextFor('billingScreen'))),
    ).resolves.toBe(true);
  });

  it('laisse passer un salon ouvert', async () => {
    const guard = new TenantBillingGuard(
      new TenantBillingGate(repositoryReturning('trialing').repository),
      new Reflector(),
    );

    await expect(
      runWithTenant(TENANT, () => guard.canActivate(contextFor('screen'))),
    ).resolves.toBe(true);
  });
});

describe('BookableSalonGuard', () => {
  it('refuse la réservation publique d’un salon fermé', async () => {
    const guard = new BookableSalonGuard(
      new TenantBillingGate(repositoryReturning('canceled').repository),
    );

    await expect(runWithTenant(TENANT, () => guard.canActivate())).rejects.toBeInstanceOf(
      SalonBookingClosedError,
    );
  });

  it('laisse réserver chez un salon géré par la plateforme', async () => {
    const guard = new BookableSalonGuard(
      new TenantBillingGate(repositoryReturning('managed').repository),
    );

    await expect(runWithTenant(TENANT, () => guard.canActivate())).resolves.toBe(true);
  });
});
