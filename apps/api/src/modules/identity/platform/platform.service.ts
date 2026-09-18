import { Injectable } from '@nestjs/common';
import { isReservedTenantSlug, tenantPublicUrl } from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizeEmail } from '../email';
import { PasswordHasher } from '../password.hasher';
import { TokenService } from '../token.service';
import {
  InvalidPlatformCredentialsError,
  TenantAdminMissingError,
  TenantSlugTakenError,
} from './platform.errors';
import { PlatformRepository } from './platform.repository';
import { PlatformTokenService } from './platform-token.service';
import type {
  AuthenticatedOperator,
  PlatformSession,
  ProvisionedTenant,
  ProvisionedTenantRecord,
  ReissuedTenantInvitation,
  TenantAccessLinks,
  TenantPage,
} from './platform.types';
import { verifyTotp } from './totp';

/**
 * La console de l'éditeur — ouvrir un salon, le retrouver, réinviter son
 * administrateur (#806).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Le contexte de journalisation
 *
 * Le critère 6 demande que la création soit journalisée : « qui, quand, quel
 * établissement ». Les trois sont écrits **deux fois**, et ce n'est pas une
 * redite : la ligne `platform_tenant_provisionings` est la trace durable et
 * interrogeable, le log est la trace d'exploitation qui arrive dans CloudWatch
 * au moment où cela se produit. L'une survit au processus, l'autre alerte.
 *
 * **Aucun de ces journaux ne porte de jeton.** Ni l'invitation, ni le jeton de
 * console, ni un lien qui en contiendrait un — c'est le dernier point de
 * vigilance de #806, et la seule façon de le tenir est de ne jamais passer
 * `links` à un logger.
 */
@Injectable()
export class PlatformService {
  public constructor(
    private readonly repository: PlatformRepository,
    private readonly hasher: PasswordHasher,
    private readonly platformTokens: PlatformTokenService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Connexion d'un opérateur — mot de passe **et** second facteur.
   *
   * ## Un seul refus, et il coûte toujours le même temps
   *
   * Les quatre causes — adresse inconnue, mot de passe faux, code faux, compte
   * désactivé — rendent la même erreur. Le mot de passe est vérifié **avant** le
   * code, et un compte introuvable consomme quand même le temps d'un bcrypt
   * (`burnComparableTime`) : sans cela, la durée de la réponse dirait si
   * l'adresse existe, et l'annuaire des opérateurs d'une plateforme est court
   * assez pour que cela compte.
   *
   * Le code MFA n'est vérifié que si le mot de passe est juste. L'ordre inverse
   * aurait fait du formulaire un oracle sur le secret TOTP, testable sans
   * connaître le premier facteur.
   */
  public async login(input: {
    email: string;
    password: string;
    totpCode: string;
  }): Promise<PlatformSession> {
    const email = normalizeEmail(input.email);
    const operator = await this.repository.findActiveOperatorByEmail(email);

    if (operator === null) {
      await this.hasher.burnComparableTime(input.password);
      throw new InvalidPlatformCredentialsError();
    }

    const passwordMatches = await this.hasher.verify(input.password, operator.passwordHash);
    if (!passwordMatches) {
      throw new InvalidPlatformCredentialsError();
    }

    if (!verifyTotp(operator.totpSecret, input.totpCode, Date.now())) {
      throw new InvalidPlatformCredentialsError();
    }

    const accessToken = await this.platformTokens.signAccessToken(operator.id);
    await this.repository.touchOperatorLastLogin(operator.id);

    this.logger.log('Connexion d’un opérateur plateforme.', {
      operatorId: operator.id,
      context: 'PlatformService',
    });

    return {
      accessToken,
      expiresIn: this.platformTokens.accessTokenTtlSeconds,
      operator: {
        id: operator.id,
        email: operator.email,
        firstName: operator.firstName,
        lastName: operator.lastName,
      },
    };
  }

  /**
   * Ouvre un établissement et invite son administrateur — critères 2, 3 et 6.
   *
   * ## L'idempotence, et pourquoi elle se lit avant d'écrire *et* après l'échec
   *
   * La lecture préalable répond au cas courant — l'opérateur rejoue une requête
   * dont il n'a pas vu la réponse — sans rien tenter d'écrire. Elle ne suffit
   * pas : deux requêtes concurrentes portant la même clé la passent toutes les
   * deux, et c'est l'unique en base qui tranche. La perdante retombe alors sur
   * la **même** relecture, et rend l'établissement que la gagnante vient
   * d'ouvrir. C'est le seul ordre qui ne crée jamais deux salons pour une clé.
   *
   * ## Le slug réservé et le slug pris rendent le même 409
   *
   * La forme du slug est déjà bornée par le DTO (label DNS, 63 caractères). Ce
   * qui se décide ici est l'appartenance à la liste de noms réservés de #837 —
   * la **même** liste qui refuse de résoudre `www.exemple.test` côté public. La
   * refuser ici transforme un salon créable puis injoignable en un message de
   * formulaire (`slugSchema`, `@spa/shared`).
   */
  public async provisionTenant(input: {
    operator: AuthenticatedOperator;
    idempotencyKey: string;
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
  }): Promise<ProvisionedTenant> {
    const replay = await this.repository.findProvisioningByIdempotencyKey(input.idempotencyKey);
    if (replay !== null) {
      return this.replayOf(replay.createdTenantId);
    }

    if (isReservedTenantSlug(input.slug)) {
      throw new TenantSlugTakenError(input.slug);
    }

    const adminEmail = normalizeEmail(input.adminEmail);

    let provisioned: ProvisionedTenantRecord;
    try {
      provisioned = await this.repository.provisionTenant({
        operatorId: input.operator.operatorId,
        idempotencyKey: input.idempotencyKey,
        slug: input.slug,
        name: input.name,
        timezone: input.timezone,
        defaultCurrency: input.defaultCurrency,
        countryCode: input.countryCode,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        postalCode: input.postalCode,
        city: input.city,
        adminEmail,
        adminFirstName: input.adminFirstName,
        adminLastName: input.adminLastName,
      });
    } catch (error: unknown) {
      if (PlatformRepository.isIdempotencyReplay(error)) {
        // Course perdue : une requête concurrente portant la même clé a déjà
        // ouvert le salon. On rend le sien plutôt qu'un conflit — c'est ce que
        // « idempotent » veut dire.
        const winner = await this.repository.findProvisioningByIdempotencyKey(
          input.idempotencyKey,
        );
        if (winner !== null) {
          return this.replayOf(winner.createdTenantId);
        }
      }
      throw error;
    }

    // « Qui, quand, quel établissement » — critère 6. Ni le jeton d'invitation
    // ni le lien qui le porte n'y figurent (point de vigilance de #806).
    this.logger.log('Ouverture d’un établissement depuis la console plateforme.', {
      operatorId: input.operator.operatorId,
      tenantId: provisioned.tenantId,
      tenantSlug: provisioned.slug,
      context: 'PlatformService',
    });

    const links = await this.linksFor({
      tenantId: provisioned.tenantId,
      slug: provisioned.slug,
      adminUserId: provisioned.adminUserId,
    });

    return {
      tenant: {
        id: provisioned.tenantId,
        slug: provisioned.slug,
        name: provisioned.name,
        timezone: provisioned.timezone,
        defaultCurrency: provisioned.defaultCurrency,
        isActive: true,
        // La console ouvre des salons hors facturation (ADR 0016).
        billingStatus: 'managed',
        trialEndsAt: null,
        createdAt: provisioned.createdAt,
      },
      admin: {
        id: provisioned.adminUserId,
        email: provisioned.adminEmail,
        firstName: input.adminFirstName,
        lastName: input.adminLastName,
      },
      links,
      replayed: false,
    };
  }

  /** Les établissements de la plateforme, page par page — critère 4. */
  public async listTenants(input: { page: number; pageSize: number }): Promise<TenantPage> {
    const { items, totalItems } = await this.repository.listTenants(input);

    return {
      items,
      page: input.page,
      pageSize: input.pageSize,
      totalItems,
      // `0` sur un ensemble vide — « page 1 sur 0 » et non « page 1 sur 1 »,
      // la convention déjà retenue par la pagination du fichier client.
      totalPages: Math.ceil(totalItems / input.pageSize),
    };
  }

  /**
   * Réémet l'invitation de l'administrateur d'un établissement — critère 4.
   *
   * Sans elle, une invitation expirée condamnerait le salon : son administrateur
   * n'a pas de mot de passe, et le périmètre MVP ne prévoit aucune
   * réinitialisation. C'est la conduite de `POST /users/:id/invitation` (#55),
   * portée ici parce que l'éditeur est le seul à pouvoir agir sur un salon dont
   * personne ne peut encore se connecter.
   *
   * **Un compte déjà activé n'arrête rien**, contrairement à la réémission côté
   * établissement. L'invitation ne vaut que pour poser le **premier** mot de
   * passe (`setInitialPassword` exige une empreinte encore nulle) : sur un
   * compte activé, le lien rendu est inopérant et ne le rouvre pas. Refuser
   * aurait obligé l'éditeur à distinguer deux cas pour une action qui, dans les
   * deux, ne donne accès à rien de neuf — et l'aurait privé du lien de
   * connexion, qui est l'autre moitié de ce que cette route rend.
   */
  public async reissueAdminInvitation(input: {
    operator: AuthenticatedOperator;
    tenantId: string;
  }): Promise<ReissuedTenantInvitation> {
    const tenant = await this.repository.findTenantById(input.tenantId);
    if (tenant === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    const admin = await this.repository.findTenantAdmin(tenant.id);
    if (admin === null) {
      throw new TenantAdminMissingError();
    }

    this.logger.log('Réémission de l’invitation administrateur d’un établissement.', {
      operatorId: input.operator.operatorId,
      tenantId: tenant.id,
      context: 'PlatformService',
    });

    return {
      tenantId: tenant.id,
      admin: { id: admin.id, email: admin.email },
      links: await this.linksFor({
        tenantId: tenant.id,
        slug: tenant.slug,
        adminUserId: admin.id,
      }),
    };
  }

  /**
   * La réponse d'un rejeu : l'établissement déjà ouvert, et des liens **frais**.
   *
   * Le jeton d'invitation est réémis plutôt que retrouvé : rien en base ne le
   * garde — c'est le propos de #55, « l'unicité d'usage ne vient pas d'une ligne
   * qu'on marquerait consommée » —, et un rejeu reçu huit jours plus tard doit
   * rendre un lien qui fonctionne encore. Les deux invitations ouvrent le même
   * compte et meurent ensemble à la première acceptée.
   */
  private async replayOf(tenantId: string): Promise<ProvisionedTenant> {
    const tenant = await this.repository.findTenantById(tenantId);
    if (tenant === null) {
      // La ligne de journal désigne un établissement qui n'existe plus. Rien
      // dans le MVP ne supprime un tenant (`onDelete: Restrict` partout) : c'est
      // une incohérence de base, pas un cas d'usage, et la taire rendrait un
      // corps vide en 201.
      throw new NotFoundError('Établissement introuvable.');
    }

    const admin = await this.repository.findTenantAdmin(tenant.id);
    if (admin === null) {
      throw new TenantAdminMissingError();
    }

    return {
      tenant,
      admin: {
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
      },
      links: await this.linksFor({
        tenantId: tenant.id,
        slug: tenant.slug,
        adminUserId: admin.id,
      }),
      replayed: true,
    };
  }

  /**
   * Les trois liens du critère 2, composés par `tenantPublicUrl` (#837).
   *
   * Le constructeur partagé plutôt qu'une concaténation locale : c'est lui qui
   * applique à l'**écriture** la règle d'hôte de base que `publicBaseHost`
   * applique à la **lecture** d'une requête entrante. Deux implémentations
   * auraient fini par diverger sur le `www.`, et le symptôme aurait été un lien
   * remis au gérant que le middleware ne sait pas relire.
   *
   * Le mode reste `auto`, comme pour les liens d'e-mail : sur un hôte qui ne
   * peut porter aucune étiquette — `127.0.0.1`, `localhost` —, le constructeur
   * retombe de lui-même sur la forme par chemin, et le lien reste cliquable en
   * recette.
   */
  private async linksFor(input: {
    tenantId: string;
    slug: string;
    adminUserId: string;
  }): Promise<TenantAccessLinks> {
    const invitation = await this.tokens.signInvitationToken({
      userId: input.adminUserId,
      tenantId: input.tenantId,
    });

    const baseUrl = this.config.appUrl;
    const query = new URLSearchParams({ token: invitation.token });

    return {
      bookingUrl: tenantPublicUrl(input.slug, '/reservation', { baseUrl }),
      adminInvitationUrl: tenantPublicUrl(input.slug, `/admin/invitation?${query.toString()}`, {
        baseUrl,
      }),
      adminLoginUrl: tenantPublicUrl(input.slug, '/admin/connexion', { baseUrl }),
      invitationExpiresIn: invitation.expiresIn,
    };
  }
}
