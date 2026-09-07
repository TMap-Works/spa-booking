/**
 * La configuration de la suite E2E du parcours critique — #80.
 *
 * ## Pourquoi ce fichier est dans `apps/web` et non à la racine
 *
 * La suite pilote un navigateur contre le front : c'est un artefact du
 * workspace web, et `npm run test:e2e` du dépôt le trouve par le fan-out
 * `--workspaces --if-present`, comme les autres cibles de test. Le poser à la
 * racine aurait demandé d'inventer un douzième chemin d'exécution.
 *
 * ## Ce que `webServer` démarre
 *
 * Deux processus : l'**API compilée** — celle-là même que l'image Docker
 * exécute — et le front en mode développement.
 *
 * ## Pourquoi le front n'est pas servi par `next start`, et pourquoi ce n'est
 * pas un renoncement
 *
 * Parce qu'un front en mode production ne peut pas être authentifié sur
 * `http://127.0.0.1`. Les deux espaces de session posent leurs cookies avec
 * `secure: process.env.NODE_ENV === 'production'`
 * (`app/(admin)/[tenantSlug]/admin/session.ts`, et son jumeau côté client) : en
 * production, le navigateur ne renvoie donc jamais le cookie sur une origine en
 * clair, et tous les scénarios de comptoir échoueraient à la connexion — sur un
 * défaut du protocole du banc d'essai, pas du produit. Servir la suite en HTTPS
 * demanderait une autorité de certification dans la CI pour éprouver un attribut
 * de cookie que le déploiement pose de toute façon derrière un ALB en TLS.
 *
 * Le contournement inverse — construire en production, exécuter en
 * `NODE_ENV=development` — ferait mentir la construction sur son propre
 * environnement, et `next build` refuse déjà de préparer ses pages d'erreur sous
 * un `NODE_ENV` non standard.
 *
 * Ce qui n'est pas perdu : la construction de production est **déjà** éprouvée
 * par le job `build` de `ci.yml` et par le job `docker`, qui construisent et
 * démarrent les deux images. Ce que ce banc ajoute est le comportement du
 * parcours, que ni l'un ni l'autre ne traverse. C'est aussi le choix qu'a fait
 * le harnais de recette du dépôt (`scripts/mcp/recette_server.py`, qui lance
 * `npm run dev -w @spa/web`), et deux bancs qui divergeraient sur ce point
 * rendraient un échec impossible à comparer d'un banc à l'autre.
 *
 * ## Les délais sont larges, délibérément
 *
 * Un front en mode développement compile chaque route à sa première visite. Le
 * premier passage sur le tunnel ou sur le planning paie donc quelques dizaines
 * de secondes qui ne sont pas du produit. Des délais serrés ne rendraient pas la
 * suite plus rapide — ils la rendraient intermittente, ce qui est le seul défaut
 * qu'un parcours critique ne peut pas se permettre.
 *
 * `reuseExistingServer` est actif hors CI : un développeur qui a déjà ses
 * serveurs sur les ports de la suite les garde.
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { FUSEAU, PORT_API, PORT_WEB, URL_API, URL_WEB } from './tests/e2e/support/environnement';

const enCI = process.env['CI'] !== undefined && process.env['CI'] !== '';
const racineDepot = path.join(__dirname, '..', '..');

/**
 * L'environnement commun aux deux processus.
 *
 * `APP_URL` doit valoir l'origine réelle du front : `bootstrap.ts` n'autorise
 * qu'une seule origine CORS, et c'est celle-là. Les secrets JWT sont engendrés à
 * la volée plutôt qu'écrits ici — un littéral de 32 caractères dans un fichier
 * versionné est un secret publié, même s'il ne signe rien de réel.
 */
const environnementServeurs: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: 'development',
  APP_URL: URL_WEB,
  API_URL: URL_API,
  // Le coût bcrypt de production ferait payer un quart de seconde à chaque
  // connexion de comptoir, pour une base jetable et des mots de passe publics.
  BCRYPT_COST: '4',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),

  /**
   * `*.e2e.ts`, et non le `*.spec.ts` par défaut.
   *
   * Trois lanceurs se partagent `apps/web/tests` : Vitest sur
   * `tests/unit/**\/*.test.{ts,tsx}`, `node --test` sur les `*.test.mjs` du
   * design system, et Playwright ici. Un motif propre à chacun est ce qui
   * garantit qu'aucun ne ramasse les suites d'un autre — un scénario E2E happé
   * par Vitest échouerait sur un `page is not defined` qui n'apprendrait rien.
   */
  testMatch: '**/*.e2e.ts',

  globalSetup: path.join(__dirname, 'tests', 'e2e', 'global-setup.ts'),
  outputDir: path.join(__dirname, 'test-results', 'artefacts'),

  /**
   * Séquentiel, délibérément.
   *
   * Les scénarios partagent un établissement et donc un agenda. Les paralléliser
   * demanderait un établissement par worker — c'est-à-dire de faire du jeu
   * d'essai une affaire de worker et non de suite. Tant que la suite tient en
   * quelques minutes, la simplicité vaut mieux que les minutes gagnées : un
   * parcours critique intermittent ne protège plus rien.
   */
  fullyParallel: false,
  workers: 1,

  forbidOnly: enCI,
  retries: enCI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },

  reporter: enCI
    ? [
        ['list'],
        // Annote la ligne fautive directement dans l'onglet « Files changed ».
        ['github'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['./tests/e2e/support/rapport-etape.ts'],
      ]
    : [['list'], ['./tests/e2e/support/rapport-etape.ts']],

  use: {
    baseURL: URL_WEB,

    /**
     * Le fuseau et la langue sont **fixés**.
     *
     * Le front n'affiche la mention « Tous les horaires sont affichés en … » que
     * lorsque le fuseau du navigateur diffère de celui du salon : laisser le
     * fuseau du runner décider ferait apparaître et disparaître des libellés
     * d'une machine à l'autre. Les aligner sur le salon supprime la variable.
     */
    timezoneId: FUSEAU,
    locale: 'fr-FR',

    // La première visite d'une route la fait compiler : c'est la navigation, et
    // elle seule, qui a besoin de cette marge.
    navigationTimeout: 90_000,

    // `on-first-retry` plutôt que `retain-on-failure` : la trace coûte cher à
    // produire, et la première exécution suffit à savoir s'il y a un problème.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: enCI ? 'retain-on-failure' : 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      name: 'api',
      // Le contrat partagé d'abord : `apps/api` en importe une valeur, et son
      // `main` pointe `dist/`.
      command:
        'npm run build --workspace @spa/shared && npm run build --workspace @spa/api && ' +
        'node apps/api/dist/main.js',
      cwd: racineDepot,
      // `/health` est hors du préfixe `/api` et sans version — il rend 503 tant
      // que Postgres ou Redis ne répond pas, ce que Playwright compte comme
      // « démarré ». C'est voulu : la connexion est paresseuse, et un 503 est une
      // réponse **servie**, donc la preuve que le processus écoute.
      url: `${URL_API}/health`,
      env: { ...environnementServeurs, PORT: String(PORT_API) },
      reuseExistingServer: !enCI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'web',
      // `next dev` : voir l'en-tête. Le `-w` et non un `cd` — `next dev` lit son
      // `next.config.mjs` depuis le répertoire du workspace, que npm pose seul.
      command: 'npm run dev --workspace @spa/web',
      cwd: racineDepot,
      url: URL_WEB,
      env: { ...environnementServeurs, PORT: String(PORT_WEB) },
      reuseExistingServer: !enCI,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
