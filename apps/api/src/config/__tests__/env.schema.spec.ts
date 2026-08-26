import { EnvValidationError, validateEnv } from '../env.schema';

// Deux valeurs distinctes de 32 caractères : ce ne sont pas des secrets, juste
// des chaînes qui satisfont le contrat. Les faire différer est nécessaire —
// `validateEnv` refuse deux clés identiques.
const ACCESS_SECRET = 'a'.repeat(32);
const REFRESH_SECRET = 'b'.repeat(32);

const VALID = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://spa:spa@localhost:5432/spa_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
} as const;

describe('validateEnv', () => {
  it('accepte un environnement complet et applique les valeurs par défaut', () => {
    const env = validateEnv({ ...VALID });

    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('convertit PORT en nombre — process.env ne fournit que des chaînes', () => {
    const env = validateEnv({ ...VALID, PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('applique les défauts de durée et de coût du module identity', () => {
    const env = validateEnv({ ...VALID });

    expect(env.JWT_EXPIRES_IN).toBe('15m');
    expect(env.REFRESH_TOKEN_EXPIRES_IN).toBe('7d');
    expect(env.BCRYPT_COST).toBe(12);
  });

  it.each(['APP_URL', 'API_URL', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'])(
    'refuse de démarrer quand %s manque',
    (missing) => {
      const incomplete: Record<string, unknown> = { ...VALID };
      delete incomplete[missing];

      expect(() => validateEnv(incomplete)).toThrow(EnvValidationError);
    },
  );

  it('nomme chaque variable manquante, sans en citer aucune valeur', () => {
    let caught: unknown;
    try {
      validateEnv({ NODE_ENV: 'test' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const issues = (caught as EnvValidationError).issues;
    expect(issues.join('\n')).toContain('DATABASE_URL');
    expect(issues.join('\n')).toContain('REDIS_URL');
    expect(issues.every((issue) => issue.includes('manquante'))).toBe(true);
  });

  it("ne recopie jamais la valeur fautive dans le rapport d'erreur", () => {
    // Une URL de connexion porte un mot de passe : un message d'erreur qui la
    // recopie le publie dans les logs de démarrage.
    const secret = 'sup3r-s3cret-p4ssw0rd';

    expect(() => validateEnv({ ...VALID, DATABASE_URL: `mysql://spa:${secret}@host/db` })).toThrow(
      EnvValidationError,
    );

    try {
      validateEnv({ ...VALID, DATABASE_URL: `mysql://spa:${secret}@host/db` });
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it.each([
    ['DATABASE_URL', 'mysql://spa:spa@localhost:3306/spa'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['APP_URL', 'pas-une-url'],
    ['NODE_ENV', 'preprod'],
    ['LOG_LEVEL', 'trace'],
    ['PORT', '0'],
    ['PORT', '70000'],
    // Un secret court est un secret forçable : 31 caractères ne passent pas.
    ['JWT_SECRET', 'a'.repeat(31)],
    ['JWT_REFRESH_SECRET', 'b'.repeat(31)],
    // Une durée sans unité est lue en **millisecondes** par `jsonwebtoken` : un
    // jeton censé vivre 15 minutes vivrait 0,9 seconde.
    ['JWT_EXPIRES_IN', '900'],
    ['REFRESH_TOKEN_EXPIRES_IN', '7'],
    ['JWT_EXPIRES_IN', '15 minutes'],
    // Un coût bcrypt de 3 rend le forçage hors ligne d'une base dérobée trivial.
    ['BCRYPT_COST', '3'],
  ])('refuse %s = %s', (name, value) => {
    expect(() => validateEnv({ ...VALID, [name]: value })).toThrow(EnvValidationError);
  });

  it('refuse deux clés de signature identiques', () => {
    // Avec un secret unique, un jeton d'accès dérobé — le plus exposé des deux,
    // puisqu'il voyage à chaque appel — se présenterait comme jeton de
    // rafraîchissement et passerait la vérification cryptographique. Seule la
    // revendication `typ` l'en distinguerait, et une convention applicative n'est
    // pas une barrière.
    expect(() =>
      validateEnv({ ...VALID, JWT_REFRESH_SECRET: ACCESS_SECRET }),
    ).toThrow(EnvValidationError);
  });

  it('ne recopie aucun secret de signature dans le rapport d’erreur', () => {
    // Le rapport part dans les logs de démarrage de la tâche ECS.
    const secret = 'x'.repeat(31);

    try {
      validateEnv({ ...VALID, JWT_SECRET: secret });
      throw new Error('validateEnv aurait dû refuser ce secret');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('JWT_SECRET');
    }
  });

  it('accepte rediss:// — ElastiCache impose TLS en déployé', () => {
    expect(() => validateEnv({ ...VALID, REDIS_URL: 'rediss://cache.aws:6379' })).not.toThrow();
  });
});
