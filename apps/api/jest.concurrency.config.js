/**
 * Tests de **concurrence** : les courses du moteur de réservation, jouées
 * contre un vrai PostgreSQL que chaque suite démarre elle-même (#31, #326).
 *
 * Une configuration à part, et non un motif de plus dans
 * `jest.integration.config.js` : c'est ce qui donne à `npm run test:concurrency`
 * une cible qu'elle est seule à servir, et à l'étape « Tests de concurrence »
 * du job `test` de ci.yml quelque chose à exercer. Jusqu'à #326, cette étape
 * était un fan-out `--if-present` que plus aucun workspace ne déclarait : elle
 * verdissait sans rien lancer, alors qu'elle annonce le garde-fou du risque n°1
 * du projet (CDC §6).
 *
 * `--passWithNoTests` n'est **pas** posé, délibérément : sans suite trouvée,
 * Jest sort en échec sur « No tests found ». Une cible de concurrence qui
 * passerait au vert faute de tests reproduirait exactement le défaut que #326
 * corrige.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Même précaution que dans `jest.unit.config.js` et `jest.integration.config.js` :
  // `roots` borne la recherche par un **chemin**, le motif reste relatif.
  // Interpoler `<rootDir>` dans un glob casse la découverte dès que le chemin
  // absolu du dépôt contient un séparateur Windows — Jest sort alors sur « No
  // tests found », ce qui ferait ici rougir la cible pour la mauvaise raison.
  roots: ['<rootDir>/test'],
  // Le suffixe est disjoint de ceux de `jest.integration.config.js`
  // (`*.integration-spec.ts`, `*.isolation-spec.ts`) : aucune suite n'est jouée
  // deux fois, ni par `npm run verify` ni par le job `test`.
  testMatch: ['**/*.concurrency-spec.ts'],
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
