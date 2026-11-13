import { defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

/**
 * Le banc d'essai du copilot contre le vrai Claude (`tests/copilot-live/`),
 * lancé à la demande seulement : `npm run test:copilot-live`. Ses fichiers
 * finissent en `.live.ts` pour qu'aucune autre suite — ni Vitest, ni
 * `node --test` — ne les ramasse.
 *
 * Pas de `mergeConfig` : il concatène les `include`, et la suite unitaire
 * entière repartirait avec.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: 'node',
    include: ['tests/copilot-live/**/*.live.ts'],
    // Un cas = quelques appels au modèle ; une campagne, quelques minutes.
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
