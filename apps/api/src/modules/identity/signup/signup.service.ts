import { Injectable } from '@nestjs/common';
import { isReservedTenantSlug } from '@spa/shared';

import { BusinessRuleError } from '../../../common/errors';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { AuthService } from '../auth.service';
import { normalizeEmail } from '../email';
import type { AuthenticationResult } from '../identity.types';
import { PasswordHasher } from '../password.hasher';
import { TenantSlugTakenError } from '../platform/platform.errors';
import { SignupRepository } from './signup.repository';

/**
 * L'inscription d'un salon en libre-service — ADR 0016.
 *
 * Crée le salon (fermé, `PENDING`) et son administrateur, puis ouvre la session
 * de celui-ci : le front enchaîne aussitôt sur le paiement de l'essai
 * (`POST /billing/checkout`), qui se fait sous cette session.
 *
 * Le salon reste fermé tant que Stripe n'a pas confirmé l'essai : un visiteur
 * qui s'inscrit sans payer n'obtient qu'un back-office réduit à l'écran
 * d'abonnement, et aucune page de réservation.
 */
@Injectable()
export class SignupService {
  public constructor(
    private readonly repository: SignupRepository,
    private readonly passwords: PasswordHasher,
    private readonly auth: AuthService,
    private readonly logger: StructuredLogger,
  ) {}

  public async signup(input: {
    slug: string;
    name: string;
    timezone: string;
    defaultCurrency: string;
    countryCode: string;
    addressLine1: string;
    addressLine2: string | null;
    postalCode: string | null;
    city: string;
    adminEmail: string;
    adminFirstName: string;
    adminLastName: string;
    password: string;
    dataConsent: boolean;
  }): Promise<AuthenticationResult> {
    if (!input.dataConsent) {
      // Seconde barrière derrière le contrat, comme à l'inscription d'une
      // cliente : c'est ce service qui décide de ce qui entre en base.
      throw new BusinessRuleError(
        'Le traitement des données doit être accepté pour créer un compte.',
      );
    }

    if (isReservedTenantSlug(input.slug)) {
      throw new TenantSlugTakenError(input.slug);
    }

    const passwordHash = await this.passwords.hash(input.password);

    const created = await this.repository.createSelfServiceTenant({
      slug: input.slug,
      name: input.name,
      timezone: input.timezone,
      defaultCurrency: input.defaultCurrency,
      countryCode: input.countryCode,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      postalCode: input.postalCode,
      city: input.city,
      adminEmail: normalizeEmail(input.adminEmail),
      adminFirstName: input.adminFirstName.trim(),
      adminLastName: input.adminLastName.trim(),
      passwordHash,
      // L'horloge du serveur, jamais une date reçue (RGPD art. 7.1).
      dataConsentAt: new Date(),
    });

    // Ni l'adresse du gérant ni le nom du salon : le slug et l'identifiant
    // suffisent au diagnostic, et un journal n'a pas à porter de donnée
    // personnelle (tenant-isolation §5).
    this.logger.log('Inscription d’un salon en libre-service.', {
      tenantId: created.tenantId,
      tenantSlug: input.slug,
      context: SignupService.name,
    });

    return this.auth.openSessionForNewTenant(created.tenantId, created.adminUserId);
  }
}
