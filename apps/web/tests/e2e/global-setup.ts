/**
 * L'amorçage global de la suite E2E — il pose le référentiel et déverrouille les
 * routes du front, une fois, avant tout worker.
 *
 * ## Il s'exécute **après** les serveurs de `webServer`
 *
 * Playwright monte ses greffons — dont `webServer` — avant d'appeler
 * `globalSetup` (`createGlobalSetupTasks` : `createPluginSetupTasks` précède
 * `createGlobalSetupTask`). C'est ce qui rend le préchauffage ci-dessous
 * possible : les deux processus répondent déjà quand cette fonction s'exécute.
 *
 * Le sous-processus plutôt qu'un import direct de `seed.mjs` : le jeu d'essai a
 * besoin du client Prisma généré dans `apps/api/node_modules`, et le charger
 * dans le processus de Playwright y attacherait un pool de connexions
 * PostgreSQL pour toute la durée de la suite. Un processus qui naît, écrit et
 * meurt ne laisse rien derrière lui.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RACINE_WEB, SLUG, URL_WEB, chemins } from './support/environnement';
import { CHEMIN_JEU_DESSAI } from './support/jeu-dessai';

/**
 * Les routes visitées une fois pour que le serveur de développement les
 * compile — hors du budget d'un test.
 *
 * ## Pourquoi ce préchauffage n'est pas un confort
 *
 * `next dev` compile chaque route à sa **première** visite, et le coût mesuré
 * n'est pas marginal : 28 s pour la vitrine, davantage pour le tunnel. Ce temps
 * était payé par le premier test qui traversait la route, et il consommait son
 * délai de 180 s avant même que le scénario ait commencé — le parcours critique
 * échouait sur un « Timeout » qui n'accusait rien de réel, et le tirage au sort
 * de l'ordre des tests décidait lequel paierait. Une suite dont le verdict
 * dépend de l'ordre d'exécution ne protège rien.
 *
 * Le compter ici le rend visible, unique et hors budget. En CI comme en local.
 *
 * Seules les routes **publiques** sont préchauffées : celles du back-office
 * exigent une session, et leur demander sans jeton ne compilerait que la
 * redirection.
 */
const ROUTES_A_PRECHAUFFER = [chemins.salon(), chemins.reservation()];

/** La marge laissée à une première compilation. Large : elle n'est payée qu'ici. */
const DELAI_PRECHAUFFAGE_MS = 180_000;

/**
 * Visite les routes publiques, sans jamais faire échouer l'amorçage.
 *
 * Un préchauffage est une optimisation, pas une pré-condition : s'il échoue, le
 * test qui traversera la route la compilera comme avant. Le faire tomber ici
 * priverait la suite d'un diagnostic bien meilleur — celui du scénario qui
 * échoue sur l'écran qu'il attendait.
 */
async function prechauffer(): Promise<void> {
  for (const route of ROUTES_A_PRECHAUFFER) {
    try {
      await fetch(`${URL_WEB}${route}`, {
        signal: AbortSignal.timeout(DELAI_PRECHAUFFAGE_MS),
        redirect: 'follow',
      });
    } catch (erreur) {
      process.stderr.write(
        `Préchauffage de ${route} sans réponse (${(erreur as Error).message}). ` +
          'La route sera compilée par le premier test qui la traverse.\n',
      );
    }
  }
}

export default async function amorcer(): Promise<void> {
  const graine = path.join(RACINE_WEB, 'tests', 'e2e', 'fixtures', 'seed.mjs');

  const execution = spawnSync(process.execPath, [graine, '--slug', SLUG], {
    encoding: 'utf8',
    // Le jeu d'essai lit `DATABASE_URL` du processus appelant : c'est la même
    // base que servira l'API, et c'est ce qui garantit qu'ils parlent du même
    // établissement.
    env: process.env,
  });

  if (execution.status !== 0) {
    throw new Error(
      `Le jeu d'essai a échoué (code ${execution.status ?? 'inconnu'}).\n` +
        `${execution.stderr || execution.stdout || 'aucune sortie'}\n` +
        'Vérifier que PostgreSQL répond (docker compose up -d), que DATABASE_URL vise le ' +
        'port publié par le compose (5433 en local), et que le client Prisma est généré ' +
        '(npm run db:generate).',
    );
  }

  // Le jeu d'essai n'écrit qu'une ligne de JSON sur stdout, mais Prisma peut y
  // ajouter des avertissements : c'est la dernière ligne non vide qui fait foi.
  const lignes = execution.stdout.trim().split('\n');
  const derniere = lignes[lignes.length - 1] ?? '';

  let jeu: unknown;
  try {
    jeu = JSON.parse(derniere);
  } catch {
    throw new Error(
      `Le jeu d'essai n'a pas rendu de JSON exploitable. Dernière ligne : « ${derniere} ».`,
    );
  }

  mkdirSync(path.dirname(CHEMIN_JEU_DESSAI), { recursive: true });
  writeFileSync(CHEMIN_JEU_DESSAI, JSON.stringify(jeu, null, 2), 'utf8');

  // Après l'écriture du jeu d'essai : la vitrine et le tunnel lisent le
  // catalogue de l'établissement, et les compiler sur une base déjà peuplée
  // réchauffe aussi le chemin de données que les tests emprunteront.
  await prechauffer();
}
