import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(here, '..', '..');

/**
 * Configuration du front (#45).
 *
 * Trois réglages, et chacun répond à une contrainte du dépôt plutôt qu'à un
 * goût.
 *
 * 1. `output: 'standalone'` et `outputFileTracingRoot` sont **exigés par
 *    `apps/web/Dockerfile`**, qui ne copie que la sortie autonome de Next. Sans
 *    la racine du monorepo, la trace de modules part d'`apps/web` et laisse
 *    derrière tout ce que npm a hissé dans le `node_modules` racine : l'image se
 *    construit et démarre sur un `MODULE_NOT_FOUND`.
 *
 * 2. L'alias de `@spa/shared` vise les **sources** du paquet et non son `dist`.
 *    C'est ce qui rend l'ordre de construction indifférent : `npm run verify`
 *    exécute `typecheck` avant `build`, et `npm run build --workspaces` traite
 *    `apps/*` avant `packages/*` — dans les deux cas, `packages/shared/dist`
 *    n'existe pas encore au moment où le front en aurait besoin. Le Dockerfile
 *    a le même problème : il appelle `npm run build --workspace @spa/web`
 *    directement. Viser la source supprime la dépendance d'ordonnancement au
 *    lieu de la contourner, et `tsconfig.json` la déclare à l'identique pour que
 *    le compilateur et le bundler résolvent le même fichier.
 *
 * Rien ici pour Turbopack : `next dev` et `next build` emploient webpack tant
 * qu'on ne passe pas `--turbopack`, et aucun script ne le passe. Le jour où l'un
 * d'eux le fera, l'alias devra être redéclaré sous la clé `turbopack`.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  reactStrictMode: true,
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@spa/shared': path.join(monorepoRoot, 'packages', 'shared', 'src', 'index.ts'),
    };

    return config;
  },
};

export default nextConfig;
