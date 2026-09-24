import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * Le back-office n'ouvre **aucune intention de paiement** — cinquième critère
 * de #1025.
 *
 * ## Pourquoi une garde, et pas seulement une suppression
 *
 * L'appel est parti (#835, ADR 0015) : le comptoir règle la carte sur le TPE
 * autonome de la banque du salon, et `POST /v1/sales/{saleId}/payments` inscrit
 * l'issue que le caissier déclare. Mais une suppression ne se défend pas
 * elle-même. La route `POST /public/{slug}/payments/intents` reste **servie**
 * par l'API pour le tunnel en ligne, le schéma partagé reste publié, et rien
 * n'empêcherait un écran d'administration de la rappeler « pour faire
 * simple » — c'est exactement ainsi qu'elle était arrivée là.
 *
 * Ce que cela coûterait n'est pas une régression ordinaire : une intention
 * ouverte depuis le back-office ramène le formulaire de carte sur une page que
 * nous servons, et fait sortir le projet de SAQ A. La contrainte non
 * négociable n° 3 du projet se tient par un test qui s'exécute, pas par une
 * consigne (`payments-stripe` §1 et §4).
 *
 * ## Ce qui est lu
 *
 * Les **sources privées de leurs commentaires**. La distinction n'est pas
 * cosmétique : plusieurs modules du back-office citent la route précisément
 * pour dire qu'ils ne l'appellent plus — `admin/components/navigation.ts`
 * explique quelles routes l'écran d'encaissement demande vraiment, et
 * `lib/admin/payment-contract.ts` raconte le départ du schéma. Une garde qui
 * lirait les commentaires interdirait d'écrire cette histoire, et la prochaine
 * personne la réécrirait de mémoire.
 *
 * Le périmètre est celui que le critère nomme — `apps/web/app/(admin)/` — plus
 * les trois modules de règlement que ces écrans importent. Le tunnel public
 * n'en fait pas partie : c'est lui, et lui seul, qui a le droit d'ouvrir une
 * intention (`payments-stripe` §2).
 */

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Les dossiers et fichiers sous garde, relatifs à `apps/web/`. */
const GUARDED: readonly string[] = [
  'app/(admin)',
  'lib/admin/checkout-summary.ts',
  'lib/admin/payment-contract.ts',
  'lib/admin/receipt-ticket.ts',
];

/** Les extensions qui portent du code — le reste (JSON, CSS) n'appelle rien. */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];

/** Tous les modules sous `target`, qu'il soit un fichier ou un dossier. */
function sourcesUnder(target: string): string[] {
  const full = path.join(webDir, target);
  const found: string[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(child);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(child);
      }
    }
  }

  if (SOURCE_EXTENSIONS.includes(path.extname(full))) {
    found.push(full);
  } else {
    walk(full);
  }

  return found;
}

/**
 * Le source privé de ses commentaires — blocs `/* *\/` et lignes `//`.
 *
 * Seules les lignes **entièrement** commentées sont retirées, et non tout ce
 * qui suit un `//` : une adresse `https://…` dans une chaîne de caractères se
 * verrait sinon tronquée, et c'est précisément dans une chaîne de ce genre
 * qu'un appel se cacherait.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Le chemin lisible d'un fichier, pour que l'échec nomme le coupable. */
function shown(file: string): string {
  return path.relative(webDir, file).split(path.sep).join('/');
}

/** La route d'intention, quelle que soit la façon dont le chemin est composé. */
const INTENT_ROUTE = /payments\s*\/\s*intents/i;

/** Ce qu'un symbole d'intention de paiement se nomme, dans les deux langues. */
const INTENT_SYMBOL = /payment.?intent|intention.?de.?paiement/i;

/**
 * Ce qu'un module importe — la clause entière, entre `import` et `from`.
 *
 * La clause et non les noms extraits un à un : une garde qui ne lisait que
 * `import { a, b } from '…'` laissait passer les trois autres formes de la
 * syntaxe — `import Intention from '…'`, `import * as intentions from '…'` et
 * `import Formulaire, { ouvrirIntention } from '…'` —, c'est-à-dire exactement
 * ce qu'écrirait quelqu'un qui ramène un formulaire de carte sans savoir ce
 * qu'il ramène. Le nom cherché est dans la clause quelle que soit sa forme ; le
 * chemin du module, lui, reste dehors, et ne peut donc pas faire accuser un
 * import légitime.
 */
function importClauses(code: string): string[] {
  const clauses: string[] = [];
  const statement = /\bimport\s+([^;]*?)\s+from\s*['"][^'"]+['"]/g;

  for (const match of code.matchAll(statement)) {
    clauses.push(match[1] ?? '');
  }

  return clauses;
}

const GUARDED_SOURCES = GUARDED.flatMap(sourcesUnder);

describe('le back-office n’ouvre aucune intention de paiement — #1025, critère 5', () => {
  it('a bien des sources à surveiller', () => {
    // Une garde qui ne lit rien passe au vert pour toujours. Un dossier
    // renommé la rendrait muette sans rien signaler.
    expect(GUARDED_SOURCES.length).toBeGreaterThan(20);
  });

  it('n’appelle nulle part POST /public/{slug}/payments/intents', () => {
    const guilty = GUARDED_SOURCES.filter((file) => INTENT_ROUTE.test(codeOf(file))).map(shown);

    expect(
      guilty,
      `${guilty.join(', ')} compose la route d'intention de paiement. Le comptoir ` +
        `règle la carte sur le TPE du salon (ADR 0015) : l'ouvrir depuis le ` +
        `back-office ramènerait un formulaire de carte sur nos pages et ferait ` +
        `sortir le projet de SAQ A.`,
    ).toEqual([]);
  });

  it('voit les quatre formes d’importation de la syntaxe', () => {
    // Ce cas garde la garde. Une lecture qui n'aurait reconnu que les accolades
    // aurait déclaré le back-office irréprochable pendant que trois des quatre
    // façons d'écrire un import ramenaient le symbole interdit.
    const forms = [
      "import { createPaymentIntent } from './x';",
      "import createPaymentIntent from './x';",
      "import * as createPaymentIntent from './x';",
      "import Formulaire, { createPaymentIntent } from './x';",
    ];

    for (const form of forms) {
      expect(importClauses(form).some((clause) => INTENT_SYMBOL.test(clause)), form).toBe(true);
    }

    // Et le chemin du module reste hors du champ lu : un import parfaitement
    // légitime ne doit pas être accusé par le nom de son fichier.
    expect(importClauses("import { sale } from './payment-intent-free';")).toEqual(['{ sale }']);
  });

  it('n’importe aucun symbole d’intention de paiement', () => {
    const guilty = GUARDED_SOURCES.filter((file) =>
      importClauses(codeOf(file)).some((clause) => INTENT_SYMBOL.test(clause)),
    ).map(shown);

    expect(
      guilty,
      `${guilty.join(', ')} importe un symbole d'intention de paiement. Le ` +
        `schéma partagé reste publié pour le tunnel en ligne — il n'a rien à ` +
        `faire dans un écran d'administration.`,
    ).toEqual([]);
  });
});
