import js from '@eslint/js';
import next from '@next/eslint-plugin-next';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'coverage/**',
      'node_modules/**',
      // Maquettes HTML statiques : elles n'ont ni build ni module.
      'mockups/**',
      // Produit par Next à chaque construction.
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  // Étalé à la racine et non dans un bloc `files` : c'est ce qui enregistre le
  // plugin `@typescript-eslint` pour toutes les configurations qui suivent.
  // Même raison que dans packages/shared/eslint.config.mjs.
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    ...reactHooks.configs['recommended-latest'],
  },
  // Les règles propres à Next — `<img>` brut, `<a>` vers une route interne,
  // script synchrone. Sans ce bloc, `next build` avertit à chaque construction
  // que le plugin n'est pas configuré, et l'avertissement finit par se lire
  // comme du bruit normal.
  // Le plugin est enregistré sans filtre `files` : c'est ainsi que `next build`
  // le détecte — il interroge la configuration résolue pour le répertoire du
  // projet, et un bloc restreint aux sources ne s'y applique pas.
  { plugins: { '@next/next': next } },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
  {
    languageOptions: {
      // Le front tourne des deux côtés : Server Components sur Node, Client
      // Components dans le navigateur. Les deux jeux de globales sont donc
      // légitimes dans ce workspace, et c'est `"use client"` — pas ESLint — qui
      // dit lequel s'applique à un fichier.
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Règle de code du projet : pas de `any` implicite ni explicite.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      // Rien n'écrit sur la console d'un navigateur en production : un message
      // utile va dans une notification, une erreur remonte à l'appelant.
      'no-console': 'error',
    },
  },
);
