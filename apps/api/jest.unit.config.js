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
  // `eslint-rules` est le plugin ESLint local : ses règles sont du code de
  // production de la barrière, et leurs `RuleTester` sont des tests unitaires
  // purs. Les exécuter ici, et non dans une cible à part, les met dans
  // `npm run verify` et dans le job `test` de la CI sans rien ajouter.
  roots: ['<rootDir>/src', '<rootDir>/eslint-rules'],
  testMatch: ['**/__tests__/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
};
