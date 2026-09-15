/*
 * Tunnel de réservation — le récapitulatif se lit en deux colonnes
 * =============================================================================
 *
 * Issue #636. La campagne de QA a relevé, aux étapes « Vérifiez votre
 * réservation » et « confirmation », une liste de définitions rendue avec le
 * style par défaut du navigateur : dix couples libellé / valeur étalés sur vingt
 * lignes, chaque valeur passée à la ligne sous son libellé et décalée de 40 px.
 * La même information, sur la vitrine, est mise en colonnes depuis #343.
 *
 * Le piège est le même que pour `booking-step-rhythm.test.mjs` : **rien ne
 * signale une mise en page absente**. Une `<dl>` sans règle compile, s'affiche,
 * passe la recette — et sort le style de l'agent utilisateur, dont le
 * `margin-inline-start` de 40 px sur le `<dd>` est la marque. Ce décalage
 * n'appartient pas à la liste mais au `<dd>` : le retirer demande une
 * déclaration explicite, qu'aucun `display` posé sur la `<dl>` ne remplace.
 *
 * Ce que la suite tient, et rien d'autre :
 *
 * 1. la valeur remet sa marge de navigateur à zéro — le défaut lui-même ;
 * 2. une rangée met son libellé et sa valeur côte à côte, et les fait passer à
 *    la ligne plutôt que déborder sur un écran étroit ;
 * 3. le libellé occupe une colonne de largeur tenue, faute de quoi les valeurs
 *    ne s'alignent pas d'une rangée à l'autre ;
 * 4. la rangée aligne ses deux parties sur leur ligne de base — « Prix » met un
 *    libellé de 14 px à côté d'un montant de 18 px, et l'alignement par défaut
 *    d'un conteneur flex les décale d'environ 4 px ;
 * 5. le composant groupe bien chacun de ses couples — une paire ajoutée demain
 *    hors d'une rangée retomberait dans le flux de la liste, elle seule.
 *
 * Les valeurs d'espacement sont celles d'« Informations pratiques »
 * (`.spa-salon__info-row` dans `salon.css`), délibérément. Elles ne sont pas
 * comparées ici : une assertion croisée ferait échouer cette suite au premier
 * ajustement de la vitrine, sur une PR qui n'aurait pas touché au tunnel.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readStyleSheet, stripComments, styleSheetPath } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Le source du récapitulatif, ses commentaires neutralisés.
 *
 * `stripComments` n'est pas une précaution : la documentation du composant cite
 * `<dt>` et `<dd>` pour expliquer pourquoi ils sont groupés, et ces mentions-là
 * n'ont évidemment pas de classe. Sans neutralisation, l'assertion des orphelins
 * échouerait sur la prose qui la justifie.
 */
const recapSource = stripComments(
  readFileSync(
    join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'steps', 'recap.tsx'),
    'utf8',
  ),
);

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));

/**
 * Les blocs de déclarations des règles dont la liste de sélecteurs contient
 * **exactement** `selector`.
 *
 * L'égalité et non la sous-chaîne : `.spa-booking__recap` est un préfixe de
 * `.spa-booking__recap-row` comme de `.spa-booking__recap-term`, et une
 * recherche par sous-chaîne rendrait vraie n'importe quelle assertion dès que
 * l'une des trois règles existe.
 */
function rulesFor(sheet, selector) {
  const wanted = selector.trim().replace(/\s+/g, ' ');
  const found = [];
  for (const [, prelude, body] of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
    if (selectors.includes(wanted)) found.push(body);
  }
  return found;
}

describe('La valeur du récapitulatif ne porte plus l’indentation du navigateur', () => {
  const value = rulesFor(booking, '.spa-booking__recap-value');

  it('déclare une règle pour la valeur', () => {
    assert.notDeepEqual(
      value,
      [],
      'aucune règle ne vise `.spa-booking__recap-value` : le `<dd>` reprend les ' +
        '40 px de `margin-inline-start` de la feuille de l’agent utilisateur, et ' +
        'chaque valeur se décale sous son libellé (#636).',
    );
  });

  it('remet la marge du `<dd>` à zéro', () => {
    assert.match(
      value.join(' '),
      /(?:margin|margin-inline|margin-inline-start)\s*:\s*0/,
      'la valeur ne remet plus sa marge à zéro. C’est la seule déclaration qui ' +
        'retire les 40 px du navigateur : ni `display: flex` sur la rangée ni ' +
        '`gap` ne les emportent, la marge appartient au `<dd>` (#636).',
    );
  });
});

describe('Une rangée pose le libellé et sa valeur côte à côte', () => {
  const row = rulesFor(booking, '.spa-booking__recap-row');

  it('déclare une règle de rangée', () => {
    assert.notDeepEqual(
      row,
      [],
      'aucune règle ne vise `.spa-booking__recap-row` : les couples retombent ' +
        'l’un sous l’autre dans le flux de la liste (#636).',
    );
  });

  it('aligne ses deux parties sur une ligne', () => {
    assert.match(
      row.join(' '),
      /display\s*:\s*flex/,
      '`.spa-booking__recap-row` n’est plus un conteneur flex : son libellé et ' +
        'sa valeur redeviennent deux blocs empilés (#636).',
    );
  });

  it('les fait passer à la ligne plutôt que déborder', () => {
    assert.match(
      row.join(' '),
      /flex-wrap\s*:\s*wrap/,
      '`.spa-booking__recap-row` ne passe plus à la ligne. À 360 px un panneau ' +
        'de tunnel offre ~280 px utiles : sans `flex-wrap`, une adresse e-mail ' +
        'posée à côté de son libellé déborde du panneau au lieu de descendre ' +
        'd’une ligne (#636).',
    );
  });

  it('aligne le libellé et sa valeur sur leur ligne de base', () => {
    assert.match(
      row.join(' '),
      /align-items\s*:\s*baseline/,
      '`.spa-booking__recap-row` retombe sur l’alignement par défaut d’un ' +
        'conteneur flex. La rangée « Prix » pose un libellé à ' +
        '`--spa-font-size-sm` à côté d’un montant à `--spa-font-size-lg` : ' +
        'étirées, les deux boîtes démarrent leur texte en haut, et les lignes ' +
        'de base s’écartent d’environ 4 px (#636).',
    );
  });

  it('tient la largeur de la colonne des libellés', () => {
    assert.match(
      rulesFor(booking, '.spa-booking__recap-term').join(' '),
      /min-inline-size\s*:/,
      '`.spa-booking__recap-term` ne pose plus de largeur minimale : chaque ' +
        'valeur commence là où finit son libellé, et la seconde colonne cesse ' +
        'd’en être une (#636).',
    );
  });
});

describe('Le composant groupe chacun de ses couples', () => {
  it('rend ses rangées', () => {
    assert.match(
      recapSource,
      /className="spa-booking__recap-row"/,
      'le récapitulatif ne groupe plus ses couples dans `.spa-booking__recap-row` : ' +
        'la mise en page de `booking.css` n’a plus de prise, et le style par ' +
        'défaut du navigateur revient (#636).',
    );
  });

  it('pose ses deux colonnes sur le couple', () => {
    for (const part of ['term', 'value']) {
      assert.match(
        recapSource,
        new RegExp(`spa-booking__recap-${part}`),
        `le couple ne porte plus \`spa-booking__recap-${part}\` : la colonne ` +
          'correspondante perd sa règle et reprend le style par défaut du ' +
          'navigateur (#636).',
      );
    }
  });

  it('ne déclare aucun `<dt>` ni `<dd>` hors de la rangée', () => {
    // Le récapitulatif est le seul endroit du tunnel où l'on écrit des couples,
    // et `RecapRow` est le seul endroit du fichier où l'on écrit une paire : une
    // seconde occurrence, c'est une paire posée à même la `<dl>`, donc la
    // réouverture du bug sur ses deux écrans.
    //
    // On compte les balises plutôt que d'exiger la classe dans le texte de
    // chacune : `className={…}` calculé est une écriture légitime, et l'exiger
    // en clair ferait échouer la suite sur un refactor qui ne régresse rien.
    for (const tag of ['dt', 'dd']) {
      const occurrences = [...recapSource.matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))];

      assert.equal(
        occurrences.length,
        1,
        `le récapitulatif déclare ${occurrences.length} \`<${tag}>\` au lieu du ` +
          'seul que porte `RecapRow` : une paire écrite à même la `<dl>` retombe ' +
          'dans le flux de la liste et rouvre le défaut sur sa ligne (#636).',
      );
    }
  });
});
