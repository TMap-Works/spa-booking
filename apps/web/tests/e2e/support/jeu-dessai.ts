/**
 * Le jeu d'essai, écrit une fois par `global-setup.ts` et relu par chaque worker.
 *
 * ## Pourquoi un fichier, et pas une variable
 *
 * Playwright exécute l'amorçage global dans un processus, et ses workers dans
 * d'autres : une valeur posée en mémoire ne leur parviendrait pas. Passer par
 * `process.env` fonctionnerait par héritage, mais lierait la suite à un ordre de
 * démarrage que Playwright ne garantit pas. Un fichier ne fait aucune hypothèse.
 *
 * Il vit sous `test-results/`, déjà ignoré par `.gitignore` et vidé par
 * Playwright à chaque exécution.
 *
 * ## Le chemin est ancré sur `RACINE_WEB`, et non sur `config.rootDir`
 *
 * `rootDir` désigne le répertoire des **tests** (`tests/e2e`), pas le workspace :
 * les chemins bâtis dessus visaient `tests/e2e/tests/e2e/…`. `RACINE_WEB` est
 * dérivé de `__dirname`, que la transpilation de Playwright fournit.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RACINE_WEB } from './environnement';

/** Ce que `fixtures/seed.mjs` rend, vu depuis les suites. */
export interface JeuDessai {
  readonly motDePasse: string;
  readonly etablissement: {
    readonly id: string;
    readonly slug: string;
    readonly nom: string;
    readonly fuseau: string;
  };
  readonly comptes: readonly {
    readonly role: string;
    readonly email: string;
    readonly id: string;
  }[];
  readonly praticiens: readonly {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
  }[];
  readonly prestation: {
    readonly id: string;
    readonly slug: string;
    readonly nom: string;
    readonly dureeMinutes: number;
    readonly prixMineur: number;
    readonly devise: string;
  };
}

/** Le fichier de passage entre l'amorçage global et les workers. */
export const CHEMIN_JEU_DESSAI = path.join(RACINE_WEB, 'test-results', 'jeu-dessai.json');

export function lireJeuDessai(): JeuDessai {
  const chemin = CHEMIN_JEU_DESSAI;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8')) as JeuDessai;
  } catch (erreur) {
    throw new Error(
      `Jeu d'essai illisible (${chemin}) : ${(erreur as Error).message}. ` +
        "L'amorçage global n'a pas abouti — relancer par « npm run test:e2e ».",
    );
  }
}

/** L'identifiant du compte client, celui que le comptoir retrouve dans le fichier. */
export function compteClient(jeu: JeuDessai): string {
  const compte = jeu.comptes.find((candidat) => candidat.role === 'CLIENT');
  if (compte === undefined) {
    throw new Error("Le jeu d'essai ne porte aucun compte CLIENT.");
  }
  return compte.id;
}
