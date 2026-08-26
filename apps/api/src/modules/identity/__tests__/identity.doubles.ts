import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import type { IdentityRepository, SessionRecord, UserRecord } from '../identity.repository';
import type { UserRole } from '../identity.types';

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
