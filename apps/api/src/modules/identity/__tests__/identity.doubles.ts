import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import { toProfile } from '../identity.repository';
import type { IdentityRepository, SessionRecord, UserRecord } from '../identity.repository';
import type { UserProfile } from '../identity.types';
import { STAFF_ROLES, USER_ROLE_RANK, type UserRole } from '../roles';

/**
 * Doubles du module `identity`, partagés par ses suites unitaires.
 *
 * Le dépôt en mémoire reproduit **une propriété précise** du vrai : le scoping
 * par tenant. Chaque ligne porte son `tenantId`, et toute lecture le filtre —
 * exactement ce que l'extension Prisma fait en vrai. Un double qui ignorerait le
 * tenant ferait passer les tests d'isolation pour de mauvaises raisons, ce qui
 * est pire que de ne pas les écrire.
 */

/** Configuration minimale — coût bcrypt plancher, la suite ne mesure pas le temps. */
export function fakeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    nodeEnv: 'test',
    isProduction: false,
    bcryptCost: 4,
    jwtSecret: 'unit-test-access-key-not-a-secret-000001',
    jwtRefreshSecret: 'unit-test-refresh-key-not-a-secret-00002',
    jwtExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    ...overrides,
  } as AppConfigService;
}

/**
 * L'erreur rejetée par une promesse, pour les assertions qui portent sur son
 * **contenu** — code, message, `details` — et pas seulement sur son type.
 *
 * `expect(...).rejects` ne rend pas l'erreur, et un `.catch((error) => error)`
 * donne un type union avec la valeur de succès, qu'il faut ensuite transtyper.
 * Ici la promesse qui aboutit est un échec de test explicite, et ce qui revient
 * est l'erreur, rien d'autre.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

export function silentLogger(): StructuredLogger {
  return {
    error: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;
}

interface StoredUser extends UserRecord {
  tenantId: string;
}

interface StoredSession extends SessionRecord {
  tenantId: string;
}

/**
 * Dépôt en mémoire.
 *
 * Il filtre sur le **vrai** contexte de tenant (`getTenantId()`), celui-là même
 * que l'extension Prisma consulte. C'est ce qui rend les tests d'isolation
 * probants : un double qui tiendrait son propre `currentTenantId` ne testerait
 * que sa propre comptabilité, et laisserait passer précisément la faute qu'on
 * cherche — une garde qui n'ouvre pas la portée, ou qui l'ouvre sur le mauvais
 * établissement.
 *
 * Le défaut est fermé, comme en vrai : sans portée résolue, aucune lecture.
 */
export class FakeIdentityRepository {
  public readonly tenants = new Map<string, string>();
  public readonly users: StoredUser[] = [];
  public readonly sessions: StoredSession[] = [];

  public addTenant(slug: string, tenantId = randomUUID()): string {
    this.tenants.set(slug, tenantId);
    return tenantId;
  }

  public addUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string | null;
    /**
     * `UserRole` comme en base : le double n'écrit que des rôles que
     * `enum UserRole` connaît, et il les connaît désormais tous les quatre
     * (#202). Un double capable d'écrire un rôle que PostgreSQL refuserait
     * ferait passer au vert un scénario impossible en production — c'est
     * `roles.spec.ts` qui tient cette équivalence, en comparant le vocabulaire
     * à l'énumération réellement générée.
     */
    role?: UserRole;
    isActive?: boolean;
  }): StoredUser {
    const user: StoredUser = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      role: input.role ?? 'CLIENT',
      passwordHash: input.passwordHash,
      firstName: 'Alice',
      lastName: 'Durand',
      phone: null,
      isActive: input.isActive ?? true,
    };
    this.users.push(user);
    return user;
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Défaut fermé, comme l'extension : sans tenant, pas de données. Ne jamais
      // retomber sur « toutes les lignes » — c'est le mode ouvert qui fuit.
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }
    return tenantId;
  }

  /**
   * Résolution du slug — la **seule** lecture légitimement hors portée, comme le
   * `prismaUnscoped` du vrai dépôt : c'est elle qui détermine le tenant, elle ne
   * peut donc pas déjà le connaître. Elle ne pose rien dans le contexte : c'est
   * `AuthService` qui appelle `setRequestTenantId`, et c'est ce chemin-là qu'on
   * veut exercer.
   */
  public async findTenantIdBySlug(slug: string): Promise<string | null> {
    return this.tenants.get(slug) ?? null;
  }

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    return this.users.find((user) => user.tenantId === tenantId && user.email === email) ?? null;
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    return this.users.find((user) => user.tenantId === tenantId && user.id === id) ?? null;
  }

  public async findStaffAccountById(id: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    const staffRoles: readonly string[] = STAFF_ROLES;
    return (
      this.users.find(
        (user) =>
          user.tenantId === tenantId && user.id === id && staffRoles.includes(user.role),
      ) ?? null
    );
  }

  public async createUser(input: {
    email: string;
    role: UserRole;
    passwordHash: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  }): Promise<UserRecord> {
    const tenantId = this.requireTenant();
    const user: StoredUser = {
      id: randomUUID(),
      tenantId,
      email: input.email,
      role: input.role,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      isActive: true,
    };
    this.users.push(user);
    return user;
  }

  public async touchLastLogin(_userId: string): Promise<void> {
    // Sans effet observable ici : la colonne ne participe à aucune décision.
  }

  /**
   * Les comptes internes de l'établissement courant.
   *
   * Reproduit les trois propriétés du vrai dont un test dépend : le filtre de
   * tenant, le filtre sur les rôles internes — la clientèle n'y figure pas —
   * et l'ordre stable `(role, email)`. Un double qui rendrait les lignes dans
   * l'ordre d'insertion ferait passer une assertion d'ordre pour de mauvaises
   * raisons.
   *
   * Le tri des rôles passe par `USER_ROLE_RANK` et **non** par `localeCompare` :
   * `orderBy: { role: 'asc' }` porte sur une colonne `enum`, et PostgreSQL
   * ordonne un enum par son ordre de **déclaration**, pas alphabétiquement. Un
   * tri alphabétique rendrait `[ADMIN, STAFF]` là où la base rend
   * `[STAFF, ADMIN]` — une assertion d'ordre serait alors verte sur l'inverse du
   * résultat réel, jusqu'au jour où un test sur vraie base la contredirait.
   * `roles.spec.ts` verrouille la concordance des deux ordres.
   */
  public async listStaffAccounts(): Promise<UserProfile[]> {
    const tenantId = this.requireTenant();
    const staffRoles: readonly string[] = STAFF_ROLES;
    return this.users
      .filter((user) => user.tenantId === tenantId && staffRoles.includes(user.role))
      .sort((left, right) =>
        left.role === right.role
          ? left.email.localeCompare(right.email)
          : USER_ROLE_RANK[left.role] - USER_ROLE_RANK[right.role],
      )
      .map((user) => toProfile(user));
  }

  /**
   * Attribue un rôle à un compte de l'établissement courant.
   *
   * Rend `false` — et n'écrit rien — pour un identifiant inconnu **ou**
   * appartenant à un autre établissement, exactement comme le `updateMany` scopé
   * du vrai dépôt rend `count: 0`. C'est cette valeur-là qui devient le 404.
   */
  public async updateUserRole(input: { userId: string; role: UserRole }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === input.userId,
    );
    if (user === undefined) {
      return false;
    }
    user.role = input.role;
    return true;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    const tenantId = this.requireTenant();
    const session: StoredSession = {
      id: randomUUID(),
      tenantId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.push(session);
    return session;
  }

  public async findSessionById(id: string): Promise<SessionRecord | null> {
    const tenantId = this.requireTenant();
    return (
      this.sessions.find((session) => session.tenantId === tenantId && session.id === id) ?? null
    );
  }

  public async rotateSession(input: {
    sessionId: string;
    expectedTokenHash: string;
    nextTokenHash: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const session = this.sessions.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.id === input.sessionId &&
        candidate.tokenHash === input.expectedTokenHash &&
        candidate.revokedAt === null,
    );
    if (session === undefined) {
      return false;
    }
    session.tokenHash = input.nextTokenHash;
    session.expiresAt = input.expiresAt;
    return true;
  }

  public async revokeSession(sessionId: string): Promise<void> {
    const tenantId = this.requireTenant();
    for (const session of this.sessions) {
      if (session.tenantId === tenantId && session.id === sessionId && session.revokedAt === null) {
        session.revokedAt = new Date();
      }
    }
  }

  public async revokeAllSessionsOfUser(userId: string): Promise<void> {
    const tenantId = this.requireTenant();
    for (const session of this.sessions) {
      if (session.tenantId === tenantId && session.userId === userId && session.revokedAt === null) {
        session.revokedAt = new Date();
      }
    }
  }

  /** Vue typée pour l'injection dans `AuthService`. */
  public asRepository(): IdentityRepository {
    return this as unknown as IdentityRepository;
  }
}
