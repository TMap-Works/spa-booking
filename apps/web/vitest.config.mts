import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(here, '..', '..');

/**
 * Suites de composants et de logique de présentation (skill web-frontend §8).
 *
 * `include` est restreint à `tests/unit/` **à dessein** : `tests/` porte déjà
 * les suites `node:test` du design system, que `npm run test:unit` lance à part
 * et que Vitest ramasserait sinon avec son motif par défaut — leurs `describe`
 * viennent de `node:test`, pas de Vitest, et ne s'y exécuteraient pas.
 *
 * L'alias reprend celui de `next.config.mjs` : trois résolveurs (tsc, webpack,
 * Vite) doivent désigner le même fichier de contrat, sans quoi un test passerait
 * contre une version du schéma que l'application n'emploie pas.
 */
export default defineConfig({
  // `tsconfig.json` déclare `jsx: "preserve"` — c'est Next qui transforme le
  // JSX en production, pas le compilateur. Hors de Next, il faut le dire à
  // esbuild, sans quoi il laisse le JSX intact et le test échoue sur un
  // « React is not defined » qui ne parle de rien.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    globals: false,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@spa/shared': path.join(monorepoRoot, 'packages', 'shared', 'src', 'index.ts'),
      '@': here,
    },
  },
});
