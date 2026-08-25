import { EnvValidationError, validateEnv } from '../env.schema';

const VALID = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://spa:spa@localhost:5432/spa_test',
  REDIS_URL: 'redis://localhost:6379',
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

  it.each(['APP_URL', 'API_URL', 'DATABASE_URL', 'REDIS_URL'])(
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
  ])('refuse %s = %s', (name, value) => {
    expect(() => validateEnv({ ...VALID, [name]: value })).toThrow(EnvValidationError);
  });

  it('accepte rediss:// — ElastiCache impose TLS en déployé', () => {
    expect(() => validateEnv({ ...VALID, REDIS_URL: 'rediss://cache.aws:6379' })).not.toThrow();
  });
});
