/**
 * Tests unitaires du contrat partagé : les schémas Zod et les constantes, sans
 * aucune dépendance externe. Ils doivent passer sur une machine sans Postgres,
 * sans Redis et sans réseau.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // `roots` borne la recherche par un **chemin**, le motif reste relatif :
  // interpoler `<rootDir>` dans un glob casse la découverte dès que le chemin
  // absolu du dépôt contient un séparateur Windows ou une esperluette. Jest
  // sortirait alors sur « No tests found » sans avoir exécuté une seule suite,
  // ce qui se lit comme un succès si l'on ne regarde que le nombre d'échecs.
  // Même précaution que dans apps/api.
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
};
