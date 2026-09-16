import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

import { runInTenantScope } from '../src/common/tenant';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { AuthService, REFRESH_ROTATION_GRACE_MS } from '../src/modules/identity/auth.service';
import { InvalidRefreshTokenError } from '../src/modules/identity/identity.errors';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import type { RefreshResult } from '../src/modules/identity/identity.types';
import { PasswordHasher } from '../src/modules/identity/password.hasher';
import { hashJti, TokenService } from '../src/modules/identity/token.service';
import { fakeConfig, silentLogger } from '../src/modules/identity/__tests__/identity.doubles';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Renouvellements concurrents d'une même session — contre un vrai PostgreSQL
 * (#856).
 *
 * `identity-auth.integration-spec.ts` joue la même course en HTTP, mais sur le
 * dépôt en mémoire : il prouve le câblage, pas la base. Ce qui ne se prouve
 * qu'ici :
 *
 * - que la migration porte bien `previous_token_hash` et `rotated_at`, et que
 *   la rotation les écrit dans la même instruction que la nouvelle empreinte ;
 * - que l'`UPDATE … WHERE token_hash = $attendu` départage réellement N
 *   renouvellements simultanés — un seul gagne, les autres voient `0` ligne
 *   et prennent le chemin `rotated === false`, qu'aucun double ne rejoue
 *   fidèlement ;
 * - qu'aucun perdant ne révoque le compte.
 *
 * Le service est le vrai, branché sur le dépôt réel et le client **scopé**,
 * comme en production. Chaque cas sème son propre établissement : aucun ne
 * dépend de ce que le précédent a laissé en base.
 */

/**
 * Le nombre de renouvellements lancés de front, aligné sur les autres suites de
 * concurrence : deux requêtes peuvent se sérialiser par hasard sur un pool de
 * connexions, et un test qui passe par chance ne prouve rien.
 */
const CONCURRENT_ATTEMPTS = 8;

const PASSWORD = 'correct-horse-battery';

interface OpenedSession {
  readonly refreshToken: string;
  readonly userId: string;
}

describe('Renouvellements concurrents — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  let tokens: TokenService;
  let service: AuthService;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Une requête réelle : c'est elle qui prouve que le schéma est en place.
      await prismaUnscoped.refreshToken.count();
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    const config = fakeConfig();
    tokens = new TokenService(new JwtService(), config);
    service = new AuthService(
      new IdentityRepository(createScopedPrismaClient(prismaUnscoped), prismaUnscoped),
      new PasswordHasher(config),
      tokens,
      silentLogger(),
    );
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    try {
      await prismaUnscoped.$disconnect();
    } finally {
      await database.drop();
    }
  });

  /** Sème un établissement et un compte, puis ouvre une session par la vraie connexion. */
  const openSession = async (): Promise<OpenedSession> => {
    const slug = `i856-${randomUUID()}`;
    const tenant = await prismaUnscoped.tenant.create({
      data: { slug, name: 'Salon des Lilas', timezone: 'Europe/Paris', defaultCurrency: 'EUR' },
    });

    const email = `alice-${randomUUID()}@example.test`;
    const user = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email,
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Martin',
        passwordHash: await new PasswordHasher(fakeConfig()).hash(PASSWORD),
      },
    });

    const opened = await runInTenantScope(async () =>
      service.login({ tenantSlug: slug, email, password: PASSWORD }),
    );

    return { refreshToken: opened.refreshToken, userId: user.id };
  };

  /** Un renouvellement, dans sa propre portée de requête — comme derrière le middleware. */
  const refresh = (token: string): Promise<RefreshResult> =>
    runInTenantScope(async () => service.refresh(token));

  const sessionsOf = (userId: string) =>
    prismaUnscoped.refreshToken.findMany({
      where: { userId },
      select: { tokenHash: true, previousTokenHash: true, rotatedAt: true, revokedAt: true },
    });

  const jtiHash = async (token: string): Promise<string> =>
    hashJti((await tokens.verifyRefreshToken(token)).jti);

  it('une seule rotation pour N renouvellements simultanés, et aucune révocation', async () => {
    const { refreshToken, userId } = await openSession();

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => refresh(refreshToken)),
    );

    // Aucun refus : chaque page aurait pu s'afficher.
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toEqual([]);

    const results = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const winners = results.filter(
      (result): result is Extract<RefreshResult, { refreshToken: string }> =>
        result.refreshToken !== null,
    );
    expect(winners).toHaveLength(1);

    const [row, ...others] = await sessionsOf(userId);
    expect(others).toEqual([]);
    expect(row?.revokedAt).toBeNull();
    // La base porte l'empreinte du gagnant, et retient celle qu'il a remplacée.
    expect(row?.tokenHash).toBe(await jtiHash(winners[0]?.refreshToken ?? ''));
    expect(row?.previousTokenHash).toBe(await jtiHash(refreshToken));
    expect(row?.rotatedAt).toBeInstanceOf(Date);

    // Le cookie final — celui du gagnant — renouvelle encore.
    const next = await refresh(winners[0]?.refreshToken ?? '');
    expect(next.refreshToken).not.toBeNull();
  });

  it('au-delà du délai de grâce, le jeton remplacé révoque toutes les sessions du compte', async () => {
    const { refreshToken, userId } = await openSession();
    await refresh(refreshToken);

    await prismaUnscoped.refreshToken.updateMany({
      where: { userId },
      data: { rotatedAt: new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 1_000) },
    });

    await expect(refresh(refreshToken)).rejects.toBeInstanceOf(InvalidRefreshTokenError);

    const sessions = await sessionsOf(userId);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });
});
