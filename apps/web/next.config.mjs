import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';

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
 * 3. `outputFileTracingIncludes` embarque les **catalogues de messages** (#845).
 *    `i18n/messages.ts` les découvre par `readdirSync` plutôt que par un
 *    `import` — c'est ce qui permet d'ajouter un namespace sans toucher à aucun
 *    fichier central — et l'analyse statique de Next ne voit donc passer aucun
 *    de ces JSON : sans cette ligne, la sortie autonome démarre et rend des
 *    clés brutes à la place des libellés. Le motif est un **glob** : il ne
 *    change pas quand un namespace s'ajoute, ce qui est tout l'objet du second
 *    critère d'acceptation de #845.
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
  outputFileTracingIncludes: {
    '/**/*': ['./messages/**/*.json'],
  },
  reactStrictMode: true,
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@spa/shared': path.join(monorepoRoot, 'packages', 'shared', 'src', 'index.ts'),
    };

    return config;
  },
};

/**
 * `next-intl` (#845, ADR 0017).
 *
 * Le greffon fait une seule chose : brancher `i18n/request.ts` comme
 * configuration de requête, pour que `getLocale`, `useTranslations` et
 * `getTranslations` sachent où lire. **Aucun routage de langue** n'est mis en
 * place — pas de segment `[locale]`, pas de réécriture d'URL : l'adresse d'un
 * salon est ce qu'il imprime sur sa vitrine, et la langue n'a pas à la doubler.
 */
export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
