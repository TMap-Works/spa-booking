/**
 * Tests de **charge** du moteur de disponibilité et du tunnel de réservation
 * (#83, troisième critère) — joués contre un vrai PostgreSQL que chaque suite
 * démarre elle-même, comme les tests de concurrence.
 *
 * ## Une cible à part, et hors de `npm run verify`
 *
 * `jest.concurrency.config.js` sert la cible que la CI joue à chaque pull
 * request : elle prouve une **propriété** — un succès par créneau — et doit
 * rester assez rapide pour cela. Les suites de charge, elles, **mesurent** :
 * elles écrivent des centaines de rendez-vous, relèvent des latences, et leur
 * durée se compte en minutes dès qu'on relève `SPA_LOAD_FACTOR`.
 *
 * Les mêler à `test:concurrency` aurait deux effets, tous deux mauvais :
 * allonger chaque PR du temps d'une campagne, et faire dépendre la barrière de
 * la CI de chiffres qui varient avec la machine. Une cible séparée les rend
 * jouables **quand on veut les jouer** — avant une mise en production, ou pour
 * confronter un relevé à celui de la campagne précédente.
 *
 * ```bash
 * npm run test:load --workspace @spa/api
 * SPA_LOAD_FACTOR=5 npm run test:load --workspace @spa/api   # campagne
 * ```
 *
 * Ce que la cible n'est pas : un substitut aux tirs de bout en bout sur un
 * environnement déployé. Elle charge le moteur et la transaction d'insertion,
 * pas l'application servie — voir `docs/recette/cahier-de-recette-mvp.md` §7.
 *
 * `--passWithNoTests` n'est pas posé, pour la raison de `jest.concurrency.config.js` :
 * une cible qui verdirait faute de suites trouvée ne prouverait rien.
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // `roots` borne la recherche par un **chemin**, le motif reste relatif :
  // interpoler `<rootDir>` dans un glob casse la découverte dès que le chemin
  // absolu du dépôt contient un séparateur Windows.
  roots: ['<rootDir>/test'],
  // Suffixe disjoint de ceux des trois autres configurations
  // (`*.integration-spec.ts`, `*.isolation-spec.ts`, `*.concurrency-spec.ts`) :
  // aucune suite n'est jouée deux fois, et `npm run verify` ne ramasse pas
  // celles-ci au passage.
  testMatch: ['**/*.load-spec.ts'],
  // Posé avant le chargement du moindre module Nest, comme ailleurs :
  // `AppConfigModule` valide `process.env` pendant son initialisation.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: {
    '^@spa/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Cinq minutes : l'amorçage démarre un conteneur PostgreSQL, migre une base et
  // sème un salon complet avant la première mesure. Chaque cas repose son propre
  // délai, plus serré.
  testTimeout: 300000,
  clearMocks: true,
  restoreMocks: true,
};
