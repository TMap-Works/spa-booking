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
  // `@spa/shared` est résolu par ses **sources**, comme dans `tsconfig.json` —
  // et non par le lien de workspace npm, qui mènerait au `main` du paquet,
  // `packages/shared/dist/index.js`.
  //
  // Sans cette ligne, les suites exigeraient une compilation préalable du
  // contrat : `crm.errors.ts` en importe une **valeur** depuis #463, donc un
  // `require` bien réel à l'exécution. `npm run verify` compile avant de tester
  // et ne verrait rien ; le job `test` de ci.yml, lui, ne lance aucun build et
  // rougirait sur un `MODULE_NOT_FOUND` sans rapport avec le code testé.
  //
  // Ce que cela ne prouve pas, et qui est prouvé ailleurs : que le `dist` du
  // paquet existe là où l'application tourne pour de bon. C'est le rôle de la
  // garde « L'image API démarre » du job `docker`.
  moduleNameMapper: {
    '^@spa/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
};
