/**
 * Tests d'intégration : l'application Nest est réellement démarrée et interrogée
 * en HTTP. Les cas « dépendance indisponible » sont déterministes partout ; les
 * cas « dépendance disponible » exigent Postgres et Redis, garantis en CI par les
 * services du job `test` de .github/workflows/ci.yml.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Même précaution que dans `jest.unit.config.js` : `roots` borne la recherche
  // par un **chemin**, le motif reste relatif. Interpoler `<rootDir>` dans un
  // glob casse la découverte dès que le chemin absolu du dépôt contient un
  // séparateur Windows — Jest sort alors sur « No tests found » sans avoir
  // exécuté une seule suite, ce qui se lit comme un succès si l'on ne regarde
  // que le nombre d'échecs.
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.integration-spec.ts', '**/*.isolation-spec.ts'],
  // Posé avant le chargement du moindre module Nest : `AppConfigModule` valide
  // `process.env` pendant son initialisation, trop tard pour qu'un test le
  // complète lui-même.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testTimeout: 30000,
  clearMocks: true,
  restoreMocks: true,
};
