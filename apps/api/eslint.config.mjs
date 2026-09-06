import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import tenant from './eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  // Étalé à la racine, et non dans un bloc `files: ['**/*.ts']` : c'est ce qui
  // enregistre le plugin `@typescript-eslint` pour **toutes** les configurations
  // qui suivent. Restreint à un bloc, le plugin reste local à ce bloc et ESLint
  // refuse de démarrer sur les règles `@typescript-eslint/*` déclarées ailleurs
  // (« could not find plugin »).
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
    },
    rules: {
      // Règle de code du projet : pas de `any` implicite ni explicite.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Les fichiers de configuration sont du CommonJS pur.
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Les deux gardes du scoping multi-tenant (#169). Elles ne valent que
    // branchées : c'est ce bloc qui les met dans `npm run lint`, donc dans
    // `npm run verify` et dans le job `lint` de la CI.
    //
    // Portée à tout le code applicatif **et** à ses tests d'intégration : une
    // fuite écrite dans un harnais de test finit par être recopiée en
    // production, et le SQL brut de préparation d'un jeu de données a les mêmes
    // raisons de porter son tenant que celui d'un repository.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { tenant },
    rules: {
      'tenant/raw-sql-tenant-filter': 'error',
      'tenant/unscoped-prisma-name': 'error',
    },
  },
  {
    // Le confinement du pool `pg` de service (#268), branché sur `src/**`
    // **seulement** — à la différence des deux gardes ci-dessus.
    //
    // Le harnais de test jetable (`test/utils/disposable-database.ts`) ouvre
    // légitimement un client `pg` : il crée et détruit des bases, ce qui n'est
    // pas un accès au schéma métier et que Prisma n'a pas à exprimer. L'exclure
    // par la portée, plutôt que par trois `eslint-disable`, garde l'exemption
    // en un seul endroit lisible.
    files: ['src/**/*.ts'],
    plugins: { tenant },
    rules: {
      'tenant/service-pool-confinement': 'error',
    },
  },
  {
    // Le contrat partagé ne se consomme que par son **baril** (#463).
    //
    // `apps/api/tsconfig.json` déclare `@spa/shared/*` dans ses `paths` : un
    // import profond — `@spa/shared/errors/error-codes` — compile donc sans
    // broncher, et `npm run typecheck` le laisse passer. Il ne se **charge**
    // pourtant jamais : le champ `exports` de `packages/shared/package.json`
    // n'expose que `.` et `./package.json`, et `node` refuse tout autre
    // sous-chemin en `ERR_PACKAGE_PATH_NOT_EXPORTED` — au démarrage du
    // conteneur, pas à la compilation. C'est exactement la classe de panne que
    // #463 corrige par ailleurs, et le lint est le seul endroit où elle se voit
    // avant le déploiement.
    //
    // **Ce que devient la règle que #463 prévoyait.** L'issue demandait un
    // `no-restricted-imports` avec `allowTypeImports: true` interdisant l'import
    // de *valeur* de `@spa/shared` — filet explicitement posé « tant que le
    // volet Dockerfile n'est pas fait ». Il l'est, et la garde « L'image API
    // démarre » de ci.yml le prouve à chaque PR : cette forme-là interdirait
    // aujourd'hui l'import que le ticket demande. Elle est donc **restreinte**
    // aux sous-chemins, où le risque, lui, subsiste entier.
    files: ['src/**/*.ts', 'test/**/*.ts', 'eslint-rules/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@spa/shared/*'],
              message:
                "Importer @spa/shared par son baril racine : le champ `exports` du paquet n'expose aucun sous-chemin, et node refuse un import profond à l'exécution (ERR_PACKAGE_PATH_NOT_EXPORTED) alors que tsc l'accepte.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
);
