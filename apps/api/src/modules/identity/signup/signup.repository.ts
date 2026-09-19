import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@spa/shared';

import {
  PRISMA_UNSCOPED,
  type UnscopedPrismaClient,
} from '../../../infrastructure/database/prisma-clients';
import { TenantSlugTakenError } from '../platform/platform.errors';

/**
 * L'écriture d'un salon inscrit seul — ADR 0016.
 *
 * ## Pourquoi le client non scopé
 *
 * Même dérogation que l'ouverture par la console (`PlatformRepository`) : la
 * requête n'a pas d'établissement courant, elle en **crée** un. Le client scopé
 * refuserait l'écriture faute de portée. Le `tenantId` du compte est posé à la
 * main, depuis la ligne qu'on vient d'écrire — jamais depuis la requête.
 *
 * ## Ce qui distingue cette écriture de celle de la console
 *
 * - le salon naît `PENDING` : il est fermé tant que le paiement de l'essai n'a
 *   pas abouti ;
 * - le gérant choisit son mot de passe lui-même, et coche lui-même l'accord sur
 *   ses données : l'empreinte et la date d'accord sont donc posées ici, là où la
 *   console crée un compte sans mot de passe ni accord, à activer par invitation.
 */

const UNIQUE_VIOLATION = 'P2002';

export interface SelfServiceTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  /**
   * La langue d'ouverture du salon — **résolue** par le service, jamais
   * facultative ici (#844).
   *
   * Le défaut (`en`) se décide en un seul endroit, et ce n'est pas celui-ci : un
   * `?? DEFAULT_LOCALE` dans le dépôt en aurait fait un second avis sur la
   * question, à côté de celui du service, et les deux auraient divergé le jour
   * où la décision du PO change.
   */
  readonly defaultLocale: Locale;
  readonly countryCode: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string;
  readonly adminEmail: string;
  readonly adminFirstName: string;
  readonly adminLastName: string;
  readonly passwordHash: string;
  readonly dataConsentAt: Date;
}

export interface SelfServiceTenantRecord {
  readonly tenantId: string;
  readonly adminUserId: string;
}

function isSlugViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_VIOLATION) {
    return false;
  }
  const target = error.meta?.['target'];
  return Array.isArray(target)
    ? target.includes('slug')
    : typeof target === 'string' && target.includes('slug');
}

@Injectable()
export class SignupRepository {
  public constructor(
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /** Le salon et son administrateur, dans une seule transaction. */
  public async createSelfServiceTenant(
    input: SelfServiceTenantInput,
  ): Promise<SelfServiceTenantRecord> {
    try {
      return await this.prismaUnscoped.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.name,
            timezone: input.timezone,
            defaultCurrency: input.defaultCurrency,
            defaultLocale: input.defaultLocale,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2,
            postalCode: input.postalCode,
            city: input.city,
            countryCode: input.countryCode,
            contactEmail: input.adminEmail,
            billingStatus: 'PENDING',
          },
          select: { id: true },
        });

        const admin = await tx.user.create({
          data: {
            tenantId: tenant.id,
            email: input.adminEmail,
            role: 'ADMIN',
            passwordHash: input.passwordHash,
            firstName: input.adminFirstName,
            lastName: input.adminLastName,
            phone: null,
            dataConsentAt: input.dataConsentAt,
          },
          select: { id: true },
        });

        return { tenantId: tenant.id, adminUserId: admin.id };
      });
    } catch (error: unknown) {
      if (isSlugViolation(error)) {
        throw new TenantSlugTakenError(input.slug);
      }
      throw error;
    }
  }
}
