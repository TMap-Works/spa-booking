/*
 * Tunnel de réservation — le rythme vertical d'une étape
 * =============================================================================
 *
 * Issue #624. La campagne de QA a relevé, sur `/…/reservation`, des libellés
 * plus proches du champ qui les précède que du leur : ~7 px au-dessus d'un
 * libellé contre ~10 px en dessous, et le titre « Vos coordonnées » collé au
 * premier libellé. Le même formulaire, rendu par `/…/compte/inscription` avec le
 * même composant `Field`, donnait ~29 px et ~17 px.
 *
 * Le défaut ne venait donc pas de `.spa-field` — les deux pages en partagent
 * l'intérieur — mais de ce qu'il y avait **autour**. La racine d'une étape du
 * tunnel, `<form>` ou `<section>`, n'avait aucune mise en page : ses enfants
 * s'empilaient dans le flux normal, sans le moindre interstice, et les ~7 px
 * relevés n'étaient que l'interlignage du libellé. Les ~10 px, eux, sont la
 * gouttière `--spa-space-1` que `.spa-field` pose entre son libellé et son
 * contrôle. La proximité disait alors exactement l'inverse de l'appartenance.
 *
 * Le piège, et la raison d'être de cette suite : **rien ne signale une mise en
 * page absente**. Une étape ajoutée demain sans `.spa-booking__step` compile,
 * s'affiche, passe la recette — et rouvre le bug à l'identique sur son seul
 * écran. C'est ce qui s'est produit ici sur cinq étapes d'un coup.
 *
 * Ce que la suite tient, et rien d'autre :
 *
 * 1. l'interstice **extérieur** d'une étape est strictement plus grand que la
 *    gouttière **intérieure** d'un champ — l'invariant dont découle la lecture
 *    correcte, énoncé en jetons résolus et non en pixels de rendu ;
 * 2. les cinq étapes du tunnel portent bien cette mise en page ;
 * 3. chacune groupe ses boutons, faute de quoi la colonne flex les étirerait sur
 *    toute la largeur du panneau ;
 * 4. la grille de créneaux ne cumule pas ses marges avec le `gap` de l'étape.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #624.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readStyleSheet,
  readTokenDeclarations,
  resolveToken,
  rulesFor,
  stripComments,
  styleSheetPath,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Le dossier des étapes du tunnel. */
const stepsDir = join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'steps');

/** Les cinq étapes que `BookingTunnel` monte dans son panneau. */
const STEP_FILES = [
  'service-step.tsx',
  'slot-step.tsx',
  'contact-step.tsx',
  'summary-step.tsx',
  'confirmation-step.tsx',
];

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));
const field = stripComments(readStyleSheet(styleSheetPath('components/field.css')));

/*
 * `rulesFor` vient de `support/tokens.mjs` (#683). Il lit les règles dont la liste
 * de sélecteurs contient **exactement** le sélecteur demandé, ce dont cette suite
 * dépend de près : chercher `.spa-booking__step` par sous-chaîne attraperait aussi
 * la règle `.spa-booking__step > .spa-card__body`, et une déclaration déplacée de
 * l'une à l'autre laisserait l'assertion verte alors que l'étape aurait changé de
 * comportement.
 */

/** La dernière valeur déclarée pour `property` dans un ensemble de blocs. */
function declaredValue(rules, property) {
  const matches = [...rules.join(';').matchAll(new RegExp(`${property}\\s*:\\s*([^;]+)`, 'g'))];
  return matches.length === 0 ? null : matches.at(-1)[1].trim();
}

/** Un espacement du design system, en rem, depuis son nom de jeton. */
function spacingInRem(token) {
  const literal = resolveToken(readTokenDeclarations(), token);
  const rem = literal.match(/^([\d.]+)rem$/);
  assert.ok(rem, `${token} vaut « ${literal} », qui n'est pas une longueur en rem.`);
  return Number(rem[1]);
}

/** Le nom de jeton derrière un `var(--spa-…)`, ou `null`. */
function tokenOf(value) {
  const reference = value === null ? null : value.match(/var\(\s*(--[\w-]+)\s*\)/);
  return reference === null ? null : reference[1];
}

describe('Une étape du tunnel sépare ses blocs plus qu’un champ ne sépare ses parties', () => {
  const step = rulesFor(booking, '.spa-booking__step');

  it('déclare bien une règle de mise en page d’étape', () => {
    assert.notDeepEqual(
      step,
      [],
      'aucune règle ne vise `.spa-booking__step`. Sans elle, la racine d’une ' +
        'étape empile ses enfants dans le flux normal, sans interstice : chaque ' +
        'libellé se lit alors comme appartenant au champ du dessus (#624).',
    );
  });

  it('empile ses enfants en colonne', () => {
    const rule = step.join(' ');

    assert.match(rule, /display\s*:\s*flex/, '`.spa-booking__step` n’est plus un conteneur flex.');
    assert.match(
      rule,
      /flex-direction\s*:\s*column/,
      '`.spa-booking__step` n’empile plus en colonne : le `gap` deviendrait ' +
        'horizontal et le rythme vertical disparaîtrait à nouveau (#624).',
    );
  });

  it('pose un interstice exprimé en jeton', () => {
    const gap = declaredValue(step, 'gap');

    assert.notEqual(
      gap,
      null,
      '`.spa-booking__step` ne pose plus de `gap` : c’est la seule chose qui ' +
        'sépare le titre de l’étape, les champs et les boutons (#624).',
    );
    assert.notEqual(
      tokenOf(gap),
      null,
      `l’interstice de l’étape vaut « ${gap} », écrit hors du barème ` +
        'd’espacement. Une valeur posée à la main dérive du reste du front au ' +
        'premier ajustement des jetons (styles/README.md §1).',
    );
  });

  it('sépare deux blocs plus qu’un libellé de son champ', () => {
    // L'invariant du ticket, et le seul qui décide de ce que la cliente lit :
    // tant que l'écart extérieur dépasse la gouttière intérieure, un libellé se
    // rattache à son propre champ. Les deux sont comparés en jetons résolus,
    // pour que la suite suive le barème plutôt qu'un couple de valeurs figées.
    const outer = tokenOf(declaredValue(step, 'gap'));
    const inner = tokenOf(declaredValue(rulesFor(field, '.spa-field'), 'gap'));

    assert.notEqual(inner, null, '`.spa-field` ne pose plus de gouttière en jeton.');
    assert.ok(
      spacingInRem(outer) > spacingInRem(inner),
      `l’étape sépare ses blocs de ${outer} et \`.spa-field\` sépare son libellé ` +
        `de son contrôle de ${inner} : le libellé est au moins aussi proche du ` +
        'bloc précédent que du champ qu’il désigne, et la proximité dit alors ' +
        'l’inverse de l’appartenance (#624).',
    );
  });
});

describe('Les blocs à marge propre ne les cumulent pas avec l’interstice', () => {
  // Le récapitulatif est une `<dl>`, dont `base.css` ne remet pas la marge de
  // navigateur à zéro. Dans une étape, elle s'ajouterait au `gap` : 30 px de
  // part et d'autre du récapitulatif, une valeur qui n'est sur aucun barreau de
  // l'échelle. La carte rendue ailleurs garde sa marge, d'où la portée à
  // l'étape.
  it('`.spa-booking__step > .spa-card__body` remet ses marges à zéro', () => {
    const scoped = rulesFor(booking, '.spa-booking__step > .spa-card__body');

    assert.notDeepEqual(
      scoped,
      [],
      'aucune règle ne vise `.spa-booking__step > .spa-card__body` : le ' +
        'récapitulatif cumule la marge de la `<dl>` avec le `gap` de l’étape (#624).',
    );
    assert.match(
      scoped.join(' '),
      /margin-block\s*:\s*0/,
      '`.spa-booking__step > .spa-card__body` ne remet plus ses marges à zéro.',
    );
  });

  // `.spa-slot-grid`, lui, se règle à la source plutôt qu'à l'étape : les deux
  // écrans qui montent `SlotPicker` — l'étape « créneau » du tunnel et le report
  // de l'espace compte (#622) — sont l'un et l'autre des colonnes flex à
  // `gap: var(--spa-space-4)`. Sa marge propre s'y ajoutait des deux côtés :
  // 32 px entre le titre de la journée et la grille qu'il annonce contre 16 px
  // entre ce titre et la barre de dates qui le précède. Une neutralisation
  // portée par le seul tunnel aurait laissé le défaut intact sur l'autre écran.
  it('`.spa-slot-grid` ne déclare plus de marge verticale propre', () => {
    const slotGrid = stripComments(readStyleSheet(styleSheetPath('components/slot-grid.css')));

    for (const property of ['margin-block', 'margin-block-start', 'margin-block-end', 'margin']) {
      assert.equal(
        declaredValue(rulesFor(slotGrid, '.spa-slot-grid'), property),
        null,
        `\`.spa-slot-grid\` reprend une \`${property}\` : elle s’ajoute au \`gap\` ` +
          'de chacun des deux conteneurs qui montent `SlotPicker`, et remet entre ' +
          'la grille et le titre qui l’annonce plus d’écart qu’entre ce titre et ' +
          'la barre de dates (#624).',
      );
    }
  });
});

describe('Les cinq étapes du tunnel portent cette mise en page', () => {
  for (const name of STEP_FILES) {
    const source = readFileSync(join(stepsDir, name), 'utf8');

    // Un modificateur est toléré à côté de la classe de base — `slot-step.tsx`
    // porte `--calendar`, qui élargit l'enveloppe du tunnel sur cette seule
    // étape (#738). Ce qui est exigé, c'est que la classe de base soit là : c'est
    // elle qui pose le rythme vertical, et le modificateur ne fait que s'y
    // ajouter. Le motif reste ancré sur le nom complet, faute de quoi il
    // laisserait passer une classe qui ne ferait que commencer pareil.
    it(`${name} pose \`.spa-booking__step\` sur sa racine`, () => {
      assert.match(
        source,
        /className="spa-booking__step(?:\s[^"]*)?"/,
        `${name} ne porte pas \`.spa-booking__step\` : son écran empile ses ` +
          'champs sans interstice, alors que les quatre autres étapes du même ' +
          'tunnel respirent (#624).',
      );
    });

    it(`${name} groupe ses boutons`, () => {
      // Une colonne flex étire ses enfants : un `.spa-button`, qui est
      // `inline-flex`, occuperait toute la largeur du panneau et deux boutons
      // passeraient l'un sous l'autre.
      assert.match(
        source,
        /className="spa-booking__actions"/,
        `${name} ne groupe pas ses boutons dans \`.spa-booking__actions\` : ` +
          'posés directement dans la colonne flex de l’étape, ils s’étirent sur ' +
          'toute la largeur du panneau (#624).',
      );
    });
  }
});

describe('Le groupe de boutons ne rattrape plus d’interstice manquant', () => {
  it('ne porte pas de marge haute propre', () => {
    // Elle compensait l'absence de mise en page de la racine d'étape (#623).
    // Depuis #624 elle s'ajouterait au `gap`, et ferait de la seule rangée de
    // boutons une exception dans le rythme vertical.
    assert.equal(
      declaredValue(rulesFor(booking, '.spa-booking__actions'), 'margin-block-start'),
      null,
      '`.spa-booking__actions` reprend une marge haute : elle s’ajoute désormais ' +
        'au `gap` de `.spa-booking__step`, et la rangée de boutons se détache ' +
        'plus que tout le reste de l’étape (#624).',
    );
  });
});
