/*
 * Les coordonnées de l'encart d'identité tiennent dans l'encart à 360 px
 * =============================================================================
 *
 * Issue #1088, seconde finition de la revue de #1086. L'étape « Coordonnées » du
 * tunnel résume ce que le compte connaît plutôt que de le redemander, et la
 * ligne « alice@… · +33 6… » de cet encart réutilise
 * `.spa-booking__identity-label`.
 *
 * Une adresse e-mail n'a **ni espace ni césure**. Le `<wbr />` du balisage pose
 * le point de coupure d'usage, après l'arobase, et couvre le cas courant du
 * domaine long ; il ne peut rien pour une partie locale de quarante caractères —
 * `marie-christine.andriamanantena@…` — qui n'offre aucun point de coupure et
 * sortirait de la bordure de l'encart à 360 px, la largeur où l'audit prend ses
 * constats.
 *
 * Le piège est celui de `booking-recap-columns.test.mjs` et de
 * `booking-reference-legibility.test.mjs` : **rien ne signale une mise en page
 * absente**. La ligne s'affiche, compile et passe la recette avec les adresses
 * courtes du jeu d'essai, et ne déborde que chez la cliente qui a une longue
 * adresse — c'est-à-dire jamais chez nous.
 *
 * Ce que la suite tient, et rien d'autre :
 *
 * 1. la ligne peut se couper là où aucun point de coupure n'est prévu ;
 * 2. `anywhere` et non `break-word` — la nuance décide de la largeur minimale du
 *    bloc, donc de ce que l'encart réserve comme place ;
 * 3. l'étape rend bien cette classe sur la ligne des coordonnées, faute de quoi
 *    la règle n'a plus de prise.
 *
 * Aucune dépendance : `node:test` et `node:assert`, comme les autres suites de
 * style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  declaration,
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const contactSource = stripComments(
  readFileSync(
    join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'steps', 'contact-step.tsx'),
    'utf8',
  ),
);

/*
 * `withoutMediaQueries` avant toute lecture : `rulesFor` **aplatit** les
 * at-rules, et une règle posée sous `@media` lui revient comme si elle était à
 * la racine (le piège écrit en tête de `support/tokens.mjs`). Non filtrée, la
 * feuille ferait passer cette suite au vert le jour où la coupure ne serait plus
 * déclarée que dans un palier — alors que c'est précisément à 360 px, largeur où
 * l'audit prend ses constats, que la ligne doit pouvoir se rompre. La coupure
 * est une propriété de la règle de base, et c'est elle qu'on interroge.
 */
const booking = withoutMediaQueries(
  stripComments(readStyleSheet(styleSheetPath('components/booking.css'))),
);

describe('La ligne de coordonnées de l’encart peut se couper', () => {
  const label = rulesFor(booking, '.spa-booking__identity-label');

  it('déclare une règle pour la ligne', () => {
    assert.notDeepEqual(
      label,
      [],
      'aucune règle ne vise `.spa-booking__identity-label` : la ligne des ' +
        'coordonnées retombe sur le comportement par défaut, qui ne coupe jamais ' +
        'un mot (#1088).',
    );
  });

  it('autorise la coupure là où le mot n’en offre aucune', () => {
    assert.equal(
      declaration(label.join(';'), 'overflow-wrap'),
      'anywhere',
      '`.spa-booking__identity-label` ne pose plus `overflow-wrap: anywhere` : ' +
        'une partie locale de quarante caractères n’a aucun point de coupure, et ' +
        'le `<wbr />` du balisage ne sait couper qu’avant le domaine — l’adresse ' +
        'sort alors de la bordure de l’encart à 360 px (#1088). `break-word` ne ' +
        'suffit pas : lui seul laisse le bloc réserver la largeur du mot ' +
        'insécable dans son calcul de largeur minimale.',
    );
  });
});

describe('L’étape rend cette classe sur ses coordonnées', () => {
  it('pose la classe sur la ligne « adresse · numéro »', () => {
    const classNames = [...contactSource.matchAll(/className="([^"]*)"/g)].map(([, value]) => value);

    assert.ok(
      classNames.filter((one) => one.includes('spa-booking__identity-label')).length >= 2,
      'l’étape « Coordonnées » ne rend plus `.spa-booking__identity-label` deux ' +
        'fois : le libellé « Réservé au nom de » et la ligne des coordonnées la ' +
        'portent tous deux, et c’est par elle que la seconde reçoit sa règle de ' +
        'coupure (#1088). Si la ligne a pris une classe à elle — ' +
        '`.spa-booking__identity-contact`, ce que la revue de #1086 proposait —, ' +
        'c’est cette classe-là qui doit porter `overflow-wrap: anywhere`, et ' +
        'cette suite qui doit la suivre.',
    );
  });
});
