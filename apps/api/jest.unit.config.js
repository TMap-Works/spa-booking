/**
 * Tests unitaires : logique pure, aucune dépendance externe (ni Postgres, ni Redis).
 * Ils doivent passer sur une machine sans infrastructure locale.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // `roots` borne la recherche par un **chemin** ; le motif reste relatif.
  // Interpoler `<rootDir>` dans un glob casse la découverte dès que le chemin
  // absolu du dépôt contient un séparateur Windows ou un caractère que
  // micromatch interprète — le motif ne correspond alors à aucun fichier, et
  // Jest sort en échec sur « No tests found » sans rien avoir exécuté.
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
};
