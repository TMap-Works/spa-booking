/**
 * Lanceur des fumigations des Lambda du module `notifications` (#496).
 *
 * ## Ce qu'il résout
 *
 * Les trois handlers de ce dossier ont chacun leur fumigation — `node
 * dispatcher.smoke.mjs`, et ses deux jumelles. Elles sont la **seule preuve
 * exécutable** de ce que les fonctions *rendent* : « les reprises sont laissées
 * à SQS », « les échecs permanents ne sont pas rejoués », « aucune adresse ne
 * part au journal » sont des affirmations sur une valeur de retour et une
 * sortie standard, que ni `terraform validate`, qui ne lit pas de JavaScript,
 * ni la lecture du code ne prouvent.
 *
 * Elles ne tournaient dans aucun job de CI, faute d'appartenir à un espace de
 * travail npm : rien n'empêchait une modification d'un handler de casser le tri
 * des issues sans que rien ne le dise. Ce lanceur est ce que `npm run verify`
 * et le job `test` de `ci.yml` appellent (cible `test:smoke:lambda`).
 *
 * ## Pourquoi une découverte, et non trois appels en dur
 *
 * Une liste écrite ici laisserait la quatrième fumigation hors barrière le jour
 * où une quatrième Lambda arrive — c'est-à-dire qu'elle rouvrirait exactement le
 * trou que #496 referme. La découverte, elle, n'a rien à mettre à jour.
 *
 * Sa contrepartie est qu'une découverte qui ne trouve rien sortirait en 0 :
 * une barrière verte n'ayant rien exercé, la panne que #326 a déjà connue
 * ailleurs. D'où le refus explicite du lot vide, plus bas — et, une granularité
 * plus bas encore, le refus d'un handler empaqueté qui n'aurait pas de
 * fumigation : découvrir dispense de *câbler* la quatrième, pas de l'écrire.
 */

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` n'existe qu'à partir de Node 21.2 ; le dépôt est sur
// Node 20 (`engines` du package.json de la racine).
const here = dirname(fileURLToPath(import.meta.url));

const SMOKE_SUFFIX = '.smoke.mjs';

/** Ce qui, dans un répertoire empaqueté, n'a rien à faire dans l'artefact. */
const TEST_LIKE = /\.(smoke|test|spec)\.(mjs|js|cjs)$/;

/** Une seule lecture du dossier : les deux listes ci-dessous s'en déduisent. */
const contenu = readdirSync(here, { withFileTypes: true });

/**
 * Les fumigations, par ordre alphabétique pour que la sortie soit stable d'une
 * exécution à l'autre — un diff de log de CI qui bouge tout seul ne se lit pas.
 */
const smokes = contenu
  .filter((entry) => entry.isFile() && entry.name.endsWith(SMOKE_SUFFIX))
  .map((entry) => entry.name)
  .sort();

/**
 * Les répertoires empaquetés : chaque sous-dossier de `lambda/` est le
 * `source_dir` d'un `archive_file` (`dispatcher-lambda.tf`, `delivery-events.tf`,
 * `reminder-sweep.tf` — la convention est un dossier par fonction).
 */
const packaged = contenu
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Le critère « la fumigation reste hors du répertoire empaqueté » (#496), tenu
 * par une garde et non par un commentaire. Aujourd'hui il est satisfait par la
 * position des fichiers ; rien n'empêcherait la prochaine d'être déposée dans
 * `lambda/dispatcher/`, d'où elle partirait dans l'archive déployée sans que
 * personne ne le voie — `archive_file` empaquette un répertoire entier, sans
 * filtre.
 */
const intruders = [];
for (const dir of packaged) {
  for (const entry of readdirSync(join(here, dir), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && TEST_LIKE.test(entry.name)) {
      // Séparateurs normalisés : le message se lit à l'identique sur le runner
      // Linux de la CI et sur un poste Windows.
      intruders.push(
        relative(here, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'),
      );
    }
  }
}

if (intruders.length > 0) {
  process.stderr.write(
    `Fichiers de test dans un répertoire empaqueté par archive_file :\n` +
      intruders.map((f) => `  - ${f}`).join('\n') +
      `\n\nCes fichiers partiraient dans l'artefact Lambda déployé. Les remonter dans\n` +
      `infra/terraform/modules/notifications/lambda/, à côté des autres fumigations.\n`,
  );
  process.exit(1);
}

if (smokes.length === 0) {
  process.stderr.write(
    `Aucun fichier *${SMOKE_SUFFIX} dans ${here}.\n\n` +
      `Ce lanceur est la barrière des handlers Lambda du module notifications :\n` +
      `sortir en succès sans rien avoir exercé la rendrait verte et vide (#496).\n`,
  );
  process.exit(1);
}

/**
 * Le refus du lot vide, une granularité plus bas : un lot non vide peut fort
 * bien laisser un handler hors barrière. La découverte évite de *câbler* la
 * fumigation d'une quatrième Lambda ; elle ne remarque pas qu'on a oublié de
 * l'écrire. Sans ce contrôle, `lambda/suppression-sync/index.mjs` déposé sans
 * `suppression-sync.smoke.mjs` laisserait l'étape « Fumigation des Lambda de
 * notification » au vert sans avoir jamais exécuté ce handler — la panne de
 * #326, au handler près.
 *
 * Le critère est la présence d'un `index.mjs` : c'est ce qui distingue un
 * répertoire empaqueté **comme fonction** d'un dossier de ressources, qui n'a
 * pas de comportement à fumiger.
 */
const sansFumigation = packaged.filter(
  (dir) => existsSync(join(here, dir, 'index.mjs')) && !smokes.includes(`${dir}${SMOKE_SUFFIX}`),
);

if (sansFumigation.length > 0) {
  process.stderr.write(
    `Handler Lambda sans fumigation :\n` +
      sansFumigation.map((dir) => `  - ${dir}/index.mjs → ${dir}${SMOKE_SUFFIX} attendu`).join('\n') +
      `\n\nCette étape resterait verte sans avoir jamais exécuté ces handlers (#496).\n` +
      `Écrire la fumigation à la racine de lambda/, jamais dans le répertoire empaqueté.\n`,
  );
  process.exit(1);
}

const failed = [];

for (const smoke of smokes) {
  process.stderr.write(`\n=== ${smoke} ===\n`);
  // `process.execPath` plutôt que « node » : c'est l'interpréteur qui joue ce
  // lanceur qui doit jouer les fumigations, et non celui que le PATH désigne.
  const { status, error } = spawnSync(process.execPath, [smoke], {
    cwd: here,
    stdio: 'inherit',
  });

  if (error) {
    process.stderr.write(`${smoke} : ${error.message}\n`);
    failed.push(smoke);
  } else if (status !== 0) {
    failed.push(smoke);
  }
}

if (failed.length > 0) {
  process.stderr.write(
    `\n${failed.length} fumigation(s) en échec sur ${smokes.length} : ${failed.join(', ')}\n`,
  );
  process.exit(1);
}

process.stderr.write(`\n${smokes.length} fumigations passées : ${smokes.join(', ')}\n`);
