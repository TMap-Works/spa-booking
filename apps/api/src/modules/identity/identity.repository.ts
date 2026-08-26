import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import { EmailAlreadyRegisteredError } from './identity.errors';
import type { UserProfile, UserRole } from './identity.types';
import { STAFF_ROLES } from './roles';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une seule requête
 * d'ici ait à le répéter — donc sans qu'aucune puisse l'oublier.
 *
 * Une exception, nommée et argumentée : `findTenantIdBySlug`. Voir son
 * commentaire.
 */

/** Le compte tel que le service en a besoin — empreinte comprise. */
export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Projection du compte, écrite une fois.
 *
 * `passwordHash` n'est jamais dans un `select` destiné à sortir du module, et
 * `tenantId` non plus : le `select` explicite est ce qui rend cette garantie
 * vérifiable à la lecture, là où un `findUnique` nu ramènerait tout.
 */
const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  passwordHash: true,
  firstName: true,
  lastName: true,
  phone: true,
  isActive: true,
} as const;

/**
 * Projection sans l'empreinte, pour les lectures qui n'ont pas à la vérifier.
 *
 * Une liste de comptes n'a aucune raison de ramener une empreinte par ligne :
 * `toProfile` la retirerait à la sortie, mais elle aurait quand même traversé le
 * réseau, la mémoire du processus et, sur un chemin d'erreur, un log. La bonne
 * défense est de ne pas la lire.
 */
const PROFILE_SELECT = {
  id: true,
  email: true,
  role: true,
  firstName: true,
  lastName: true,
  phone: true,
} as const;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Le type généré par Prisma exige `tenantId` : il décrit la colonne, et la
 * colonne est `NOT NULL`. Or le repository ne doit justement **pas** le fournir —
 * c'est l'extension de scoping qui le pose, depuis le contexte de requête, et qui
 * écrase ce qui s'y trouverait (`tenant-scope.extension.ts`).
 *
 * Les deux vérités ne se rencontrent pas dans le système de types : `$extends` ne
 * réécrit pas les types d'entrée de Prisma. La conversion est donc nécessaire, et
 * elle est **concentrée ici** — une fonction, un commentaire, deux sites d'appel —
 * plutôt que dispersée en autant de `as` que de créations.
 *
 * Ce qui la rend sûre n'est pas une promesse : c'est que l'extension refuse toute
 * opération sans contexte de tenant, et que la colonne est `NOT NULL` sans valeur
 * par défaut. Si l'extension venait à être contournée, l'insertion échouerait en
 * base — bruyamment, jamais en silence.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = 'P2002';

/** `UserRecord` sans son empreinte — ce qui peut sortir du module. */
export function toProfile(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
  };
}

@Injectable()
export class IdentityRepository {
  public constructor(
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
    // Dérogation au scoping, et la seule du module. Résoudre l'établissement
    // depuis son slug est par construction une opération **sans tenant courant** :
    // c'est elle qui va le déterminer, avant toute authentification. Le filtre
    // par tenant n'a donc rien à filtrer — il y a un `slug` unique global, et
    // c'est lui la clé. Le résultat est immédiatement posé dans le contexte, et
    // aucune autre requête du module ne passe par cette porte.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /**
   * Résout un établissement actif depuis son slug public.
   *
   * Ne renvoie **que** l'identifiant : le reste de la fiche n'a rien à faire dans
   * le module `identity`, et un objet complet finirait par être renvoyé au client.
   */
  public async findTenantIdBySlug(slug: string): Promise<string | null> {
    const tenant = await this.prismaUnscoped.tenant.findUnique({
      where: { slug },
      select: { id: true, isActive: true },
    });

    // Un établissement désactivé se comporte comme un établissement inexistant :
    // distinguer les deux dirait à un visiteur qu'un salon a fermé, et lequel.
    if (tenant === null || !tenant.isActive) {
      return null;
    }
    return tenant.id;
  }

  /**
   * Retrouve un compte par son adresse, dans le tenant courant.
   *
   * `findFirst` et non `findUnique` : l'unique du schéma est
   * `(tenant_id, email)`, et l'extension de scoping injecte `tenantId` dans le
   * `where` — or `findUnique` exige que le `where` désigne *exactement* une clé
   * unique, ce que `{ email, tenantId }` ne fait pas sous cette forme.
   */
  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { email },
      select: USER_SELECT,
    });
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id },
      select: USER_SELECT,
    });
  }

  /**
   * Un **compte interne** de l'établissement courant, par identifiant.
   *
   * Le filtre sur le rôle est ce qui distingue cette lecture de `findUserById`,
   * et il n'est pas cosmétique : sans lui, `GET /users/:id` — une route ouverte
   * au rang `STAFF` — rendrait la fiche d'une cliente, nom, e-mail et téléphone
   * compris, depuis un point d'entrée d'administration des droits. Les données
   * personnelles de la clientèle relèvent du module `crm` et de ses propres
   * permissions (CDC §5.1) ; ne pas les lire ici est plus sûr que d'espérer que
   * personne n'appelle la route avec le bon identifiant.
   *
   * Un compte `CLIENT` du tenant courant est donc **introuvable** par cette
   * méthode, exactement comme un compte d'un autre établissement — et pour la
   * même raison de forme : le service traduit `null` en 404, sans avoir à
   * choisir entre deux motifs de refus.
   */
  public async findStaffAccountById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id, role: { in: [...STAFF_ROLES] } },
      select: USER_SELECT,
    });
  }

  /**
   * Crée un compte dans le tenant courant.
   *
   * Aucun `tenantId` n'est passé : c'est l'extension qui le pose, et elle
   * **écrase** ce qui s'y trouverait. Un `tenantId` qui aurait traversé la
   * validation n'aurait donc aucun effet.
   *
   * La violation de `@@unique([tenantId, email])` est traduite ici, et pas
   * ailleurs : c'est le seul point du module qui connaît les codes d'erreur de
   * Prisma. Le contrôle préalable du service est une courtoisie — c'est la base
   * qui tranche, et deux inscriptions concurrentes sur la même adresse le
   * passent toutes les deux. Sans cette traduction, la perdante recevrait un 500
   * « erreur interne » là où le contrat annonce un 409.
   */
  public async createUser(input: {
    email: string;
    role: UserRole;
    passwordHash: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  }): Promise<UserRecord> {
    try {
      return await this.prisma.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: input.email,
          role: input.role,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
        }),
        select: USER_SELECT,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  public async touchLastLogin(userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  /**
   * Les **comptes internes** de l'établissement courant — le « comptes staff »
   * du CDC §1.4.
   *
   * Le filtre sur `role` n'est pas cosmétique : sans lui, la lecture ramènerait
   * aussi la clientèle, qui se compte en milliers là où le personnel se compte
   * en dizaines. Les fiches clients relèvent du module `crm` et de sa
   * pagination ; ce point d'entrée-ci répond à une question d'administration des
   * droits, et sa taille est bornée par nature.
   *
   * `@@index([tenantId, role])` du schéma sert exactement cette requête — c'est
   * la seule qui filtre sur ce couple.
   */
  public async listStaffAccounts(): Promise<UserProfile[]> {
    return this.prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      select: PROFILE_SELECT,
      // Ordre stable : le rang d'abord, l'adresse pour départager. Sans `orderBy`,
      // PostgreSQL n'en garantit aucun et la liste change d'un appel à l'autre.
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
    });
  }

  /**
   * Attribue un rôle à un compte de l'établissement courant.
   *
   * `updateMany` et non `update` : sous le scoping, le `where` porte à la fois
   * `id` et `tenantId`, ce qui n'est pas une clé unique au sens de Prisma. Le
   * compte est surtout la propriété utile — il vaut `0` pour un identifiant d'un
   * autre établissement, ce qui donne le 404 attendu plutôt qu'une exception
   * « record not found » indistinguable d'un incident.
   */
  public async updateUserRole(input: { userId: string; role: UserRole }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId },
      data: { role: input.role },
    });
    return count === 1;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    return this.prisma.refreshToken.create({
      data: withScopedTenant<Prisma.RefreshTokenUncheckedCreateInput>({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      }),
      select: { id: true, userId: true, tokenHash: true, expiresAt: true, revokedAt: true },
    });
  }

  public async findSessionById(id: string): Promise<SessionRecord | null> {
    return this.prisma.refreshToken.findFirst({
      where: { id },
      select: { id: true, userId: true, tokenHash: true, expiresAt: true, revokedAt: true },
    });
  }

  /**
   * Fait tourner l'empreinte d'une session — **si** elle porte encore celle
   * qu'on a présentée.
   *
   * Le `tokenHash` attendu est dans le `where`, pas seulement vérifié en amont :
   * c'est ce qui rend la rotation atomique. Deux rafraîchissements concurrents
   * partant du même jeton se disputent la même ligne ; le premier la met à jour,
   * le second ne trouve plus rien à mettre à jour et reçoit `0`. Sans cette
   * condition, les deux réussiraient et la détection de réemploi ne verrait rien.
   *
   * Renvoie `true` si la rotation a eu lieu.
   */
  public async rotateSession(input: {
    sessionId: string;
    expectedTokenHash: string;
    nextTokenHash: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: {
        id: input.sessionId,
        tokenHash: input.expectedTokenHash,
        revokedAt: null,
      },
      data: { tokenHash: input.nextTokenHash, expiresAt: input.expiresAt },
    });

    return count === 1;
  }

  /**
   * Éteint une session. Idempotent : `revoked_at` n'est posé que s'il est encore
   * nul, une session révoquée ne se « re-révoque » donc pas à une date plus
   * tardive — ce qui garderait une trace fausse de l'instant de la déconnexion.
   */
  public async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Éteint **toutes** les sessions vivantes d'un compte.
   *
   * Appelé sur détection de réemploi : si un jeton déjà consommé ressort, on ne
   * sait pas lequel des deux porteurs est légitime, donc aucun ne garde la main.
   */
  public async revokeAllSessionsOfUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
