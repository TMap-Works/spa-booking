import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
);
