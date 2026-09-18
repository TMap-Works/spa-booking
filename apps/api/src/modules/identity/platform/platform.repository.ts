import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  PRISMA_UNSCOPED,
  type UnscopedPrismaClient,
} from '../../../infrastructure/database/prisma-clients';
import { TenantSlugTakenError } from './platform.errors';
import type {
  PlatformOperatorRecord,
  ProvisionTenantInput,
  ProvisionedTenantRecord,
  TenantSummary,
} from './platform.types';

/**
 * Seul point de la console qui connaît le schéma (api-module §2).
 *
 * ## Pourquoi le client **non scopé**, et pourquoi c'est légitime ici
 *
 * `prisma-clients.ts` nomme ce cas en toutes lettres parmi les dérogations
 * prévues : « création d'un établissement (aucun tenant courant n'existe
 * encore) ». C'est exactement ce que fait ce dépôt, et c'est structurel — une
 * requête de console arrive avec une portée **vide** (`PlatformAuthGuard` n'en
 * pose aucune, et refuse d'agir si une autre l'a fait), si bien que le client
 * scopé refuserait toute opération avant même de regarder la table.
 *
 * Les trois obligations de `prisma-clients.ts` sont tenues :
 *
 * 1. le champ se nomme `prismaUnscoped` — le lint `tenant/unscoped-prisma-name`
 *    l'exige, et c'est ce qui rend le `grep` exhaustif ;
 * 2. ce commentaire dit pourquoi le scoping ne s'applique pas ;
 * 3. **chaque requête qui vise un établissement porte son filtre à la main.**
 *    Aucune méthode de ce fichier ne lit une donnée *de* salon : elle lit des
 *    lignes `tenants` — la racine, que la console est faite pour énumérer — et
 *    le compte administrateur du salon qu'elle vient de nommer, filtré sur son
 *    `tenantId` explicite.
 *
 * Les deux tables de l'espace plateforme, elles, n'ont pas de filtre à porter :
 * elles n'appartiennent à aucun établissement (ADR 0012), et
 * `tenant-scope.extension.ts` les **refuse** au client scopé pour cette raison
 * même — elles ne sont atteignables que d'ici.
 */

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = 'P2002';

/** Ce que la console rend d'un établissement — jamais la ligne entière. */
const TENANT_SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  timezone: true,
  defaultCurrency: true,
  isActive: true,
  billingStatus: true,
  trialEndsAt: true,
  createdAt: true,
} as const;

/** La ligne telle que Prisma la rend, avant la casse du contrat. */
type TenantSummaryRow = Prisma.TenantGetPayload<{ select: typeof TENANT_SUMMARY_SELECT }>;

/** Le statut de facturation passe en minuscules, comme toutes les énumérations du contrat. */
function toTenantSummary(row: TenantSummaryRow): TenantSummary {
  return {
    ...row,
    billingStatus: row.billingStatus.toLowerCase() as TenantSummary['billingStatus'],
  };
}

/**
 * La projection d'un opérateur — empreinte et secret compris.
 *
 * Ils y figurent parce que c'est la connexion qui les lit, et elle seule : le
 * service ne les fait sortir nulle part, `PlatformSession` ne les nomme pas, et
 * aucun DTO ne les porte. La projection explicite est ce qui rend la garantie
 * vérifiable à la lecture.
 */
const OPERATOR_SELECT = {
  id: true,
  email: true,
  passwordHash: true,
  totpSecret: true,
  firstName: true,
  lastName: true,
  isActive: true,
} as const;

/**
 * L'administrateur d'un établissement, tel que la réémission le lit.
 *
 * **Sans son empreinte** : la réémission ne la regarde pas — un compte déjà
 * activé reçoit un lien inopérant plutôt qu'un refus (voir `PlatformService`) —,
 * et un champ qu'aucun appelant ne lit n'a aucune raison de sortir de la base.
 */
export interface TenantAdminRecord {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** Ce qu'un rejeu d'idempotence retrouve. */
export interface ProvisioningRecord {
  readonly operatorId: string;
  readonly createdTenantId: string;
  readonly createdAt: Date;
}

/** Vrai si l'erreur Prisma est une violation d'unicité sur l'un de ces champs. */
function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_VIOLATION) {
    return false;
  }
  const target = error.meta?.['target'];
  // Prisma rend soit un tableau de colonnes, soit le nom de l'index — les deux
  // formes selon le connecteur et la version. On accepte les deux plutôt que de
  // supposer celle du jour : une erreur mal reconnue sortirait en 500.
  if (Array.isArray(target)) {
    return target.includes(field);
  }
  return typeof target === 'string' && target.includes(field);
}

@Injectable()
export class PlatformRepository {
  public constructor(
    // Dérogation au scoping, argumentée dans l'en-tête de ce fichier : une
    // requête de console n'a pas d'établissement courant — elle en crée un, ou
    // les énumère tous.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /** L'opérateur actif que désigne cette adresse — la lecture de la connexion. */
  public async findActiveOperatorByEmail(email: string): Promise<PlatformOperatorRecord | null> {
    return this.prismaUnscoped.platformOperator.findFirst({
      where: { email, isActive: true },
      select: OPERATOR_SELECT,
    });
  }

  /** L'opérateur actif que désigne ce jeton — la relecture de la garde. */
  public async findActiveOperatorById(
    id: string,
  ): Promise<{ id: string; email: string } | null> {
    return this.prismaUnscoped.platformOperator.findFirst({
      where: { id, isActive: true },
      select: { id: true, email: true },
    });
  }

  public async touchOperatorLastLogin(id: string): Promise<void> {
    await this.prismaUnscoped.platformOperator.updateMany({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  /** Le salon déjà ouvert sous cette clé d'idempotence, s'il y en a un. */
  public async findProvisioningByIdempotencyKey(key: string): Promise<ProvisioningRecord | null> {
    return this.prismaUnscoped.platformTenantProvisioning.findUnique({
      where: { idempotencyKey: key },
      select: { operatorId: true, createdTenantId: true, createdAt: true },
    });
  }

  /**
   * Ouvre un établissement, son compte administrateur et la ligne de journal —
   * **en une seule transaction**, comme le critère 2 l'exige.
   *
   * Les trois écritures sont indissociables : un établissement sans
   * administrateur serait un salon que personne ne peut ouvrir, et un
   * administrateur sans ligne de journal serait une ouverture non tracée, donc
   * rejouable à l'infini par la même clé.
   *
   * ## Ce que la base tranche, et que le service ne surveille pas
   *
   * - `tenants_slug_key` refuse un slug déjà pris — traduit en 409
   *   `TENANT_SLUG_TAKEN`. Une lecture préalable ne suffirait pas : deux
   *   ouvertures concurrentes sur le même nom la passeraient toutes les deux.
   * - `platform_tenant_provisionings_idempotency_key_key` refuse un rejeu.
   *   L'erreur **remonte telle quelle** : c'est le service qui décide qu'un
   *   rejeu se répond par la ressource déjà créée, pas le dépôt.
   *
   * Le compte administrateur naît **sans mot de passe** (`passwordHash: null`),
   * exactement comme un membre du personnel invité (#55) : c'est la personne qui
   * pose son premier mot de passe, jamais l'éditeur. `dataConsentAt` est `null`
   * pour la même raison qu'à l'invitation — personne n'a rien coché, et dater un
   * accord que nul n'a donné serait fabriquer une preuve (#880, RGPD art. 7.1).
   */
  public async provisionTenant(input: ProvisionTenantInput): Promise<ProvisionedTenantRecord> {
    try {
      return await this.prismaUnscoped.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.name,
            timezone: input.timezone,
            defaultCurrency: input.defaultCurrency,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2,
            postalCode: input.postalCode,
            city: input.city,
            countryCode: input.countryCode,
          },
          select: { id: true, createdAt: true },
        });

        const admin = await tx.user.create({
          // `tenantId` est posé **explicitement** : l'extension de scoping, qui
          // le poserait depuis le contexte, n'est pas dans le chemin de ce
          // client. C'est la troisième obligation de `prisma-clients.ts`, et
          // l'identifiant vient de la ligne qu'on vient d'écrire — jamais d'une
          // entrée de la requête.
          data: {
            tenantId: tenant.id,
            email: input.adminEmail,
            role: 'ADMIN',
            passwordHash: null,
            firstName: input.adminFirstName,
            lastName: input.adminLastName,
            phone: null,
            dataConsentAt: null,
          },
          select: { id: true, email: true },
        });

        await tx.platformTenantProvisioning.create({
          data: {
            operatorId: input.operatorId,
            createdTenantId: tenant.id,
            idempotencyKey: input.idempotencyKey,
          },
          select: { id: true },
        });

        return {
          tenantId: tenant.id,
          slug: input.slug,
          name: input.name,
          timezone: input.timezone,
          defaultCurrency: input.defaultCurrency,
          adminUserId: admin.id,
          adminEmail: admin.email,
          createdAt: tenant.createdAt,
        };
      });
    } catch (error: unknown) {
      if (isUniqueViolationOn(error, 'slug')) {
        throw new TenantSlugTakenError(input.slug);
      }
      throw error;
    }
  }

  /** Vrai si l'erreur est le rejeu d'une clé d'idempotence déjà consommée. */
  public static isIdempotencyReplay(error: unknown): boolean {
    return isUniqueViolationOn(error, 'idempotency_key');
  }

  public async findTenantById(id: string): Promise<TenantSummary | null> {
    const row = await this.prismaUnscoped.tenant.findUnique({
      where: { id },
      select: TENANT_SUMMARY_SELECT,
    });
    return row === null ? null : toTenantSummary(row);
  }

  /**
   * Une page d'établissements — critère 4.
   *
   * Triés par date de création décroissante : la console sert à suivre les
   * ouvertures, et le salon qu'on vient d'ouvrir est celui qu'on cherche. Le
   * `id` départage deux créations de la même milliseconde, sans quoi deux
   * lectures de la même page pourraient ne pas rendre les mêmes lignes.
   */
  public async listTenants(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: TenantSummary[]; totalItems: number }> {
    const [items, totalItems] = await this.prismaUnscoped.$transaction([
      this.prismaUnscoped.tenant.findMany({
        select: TENANT_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.prismaUnscoped.tenant.count(),
    ]);

    return { items: items.map(toTenantSummary), totalItems };
  }

  /**
   * L'administrateur d'un établissement — le plus ancien, quand il y en a
   * plusieurs.
   *
   * « Le plus ancien » et non « n'importe lequel » : c'est celui que la console a
   * créé en ouvrant le salon, et la réémission doit viser ce compte-là plutôt
   * qu'un administrateur nommé depuis. Le filtre par `tenantId` est écrit à la
   * main — troisième obligation du client non scopé.
   */
  public async findTenantAdmin(tenantId: string): Promise<TenantAdminRecord | null> {
    return this.prismaUnscoped.user.findFirst({
      where: { tenantId, role: 'ADMIN' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, email: true, firstName: true, lastName: true },
    });
  }
}
