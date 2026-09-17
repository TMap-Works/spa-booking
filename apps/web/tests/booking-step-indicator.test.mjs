/*
 * Tunnel de réservation — l'indicateur d'étape dit où l'on en est
 * =============================================================================
 *
 * Issue #740. L'audit de conception a relevé, sur `/…/reservation`, cinq
 * libellés — « Prestation · Créneau · Coordonnées · Récapitulatif ·
 * Confirmation » — rendus à l'identique à toutes les étapes : même graisse, même
 * couleur, même taille. `docs/design/appointments/wireframes.md` — « Structure
 * commune à toutes les étapes » — prescrit l'inverse : *« ①──②──③──④──⑤──⑥
 * indicateur d'étape (étape courante mise en avant) »*, et *« l'indicateur
 * d'étape montre la progression et permet de revenir à une étape déjà
 * franchie »*.
 *
 * ## Ce que cette suite tient, et pourquoi elle existe séparément
 *
 * Le constat de l'audit n'était pas un attribut manquant : `aria-current="step"`
 * était posé depuis le premier jour. Il était **nu** — aucune règle ne le
 * visait. C'est la panne exacte que cette suite garde, et c'est une panne que
 * rien d'autre ne voit :
 *
 * - `booking-tunnel.test.tsx` éprouve l'état et la navigation sous jsdom, qui ne
 *   charge aucune feuille de style : l'attribut peut redevenir nu sans qu'une
 *   seule de ses assertions bouge ;
 * - la recette et la QA regardent un écran à un instant donné, pas la règle qui
 *   le peint — et la règle a survécu neuf mois à ce régime-là.
 *
 * Trois choses, donc, et rien d'autre : la feuille **habille** `aria-current`,
 * elle le fait par l'attribut et non par une classe qui pourrait en diverger, et
 * le tunnel porte bien les classes qu'elle décrit. Le détail des teintes est
 * l'affaire de `contrast.test.mjs`, qui vérifie déjà les paires employées ici.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de ce dossier.
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
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const tunnel = join(
  here,
  '..',
  'app',
  '(booking)',
  '[tenantSlug]',
  'reservation',
  'booking-tunnel.tsx',
);

/** Le fil, la pastille d'une étape, et le retour vers une étape franchie. */
const LIST = 'spa-booking__progress';
const STEP = `${LIST}-step`;
const NAME = `${LIST}-name`;
const LINK = `${LIST}-link`;

/** La règle qui met en avant l'étape courante — celle qui manquait. */
const CURRENT = `.${STEP}[aria-current='step'] .${NAME}`;

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));
const source = readFileSync(tunnel, 'utf8');

describe('L’indicateur d’étape met en avant l’étape courante (#740)', () => {
  const current = rulesFor(booking, CURRENT).join(' ');

  it('habille `aria-current`, que rien ne visait', () => {
    assert.notEqual(
      current,
      '',
      `Aucune règle ne vise \`${CURRENT}\` : l’attribut est de nouveau nu, et les ` +
        'cinq étapes ressortent à l’identique — l’écart relevé par l’audit (#740).',
    );
  });

  it('la distingue autrement que par la seule couleur (WCAG 1.4.1)', () => {
    // L'aplat et la bordure sont les deux repères que le back-office emploie
    // déjà (`.spa-admin-client-list__item[aria-current='true']`), la graisse le
    // troisième. Un seul d'entre eux suffirait à peindre l'état, aucun seul ne
    // suffit à le **dire** : une teinte d'accent perdue en monochrome ou par un
    // filtre de daltonisme ne laisserait rien.
    for (const property of ['background-color', 'border-color', 'font-weight']) {
      assert.notEqual(
        declaration(current, property),
        null,
        `\`${CURRENT}\` ne déclare plus \`${property}\` : l’étape courante ne se ` +
          'distingue plus que par sa couleur, ce que WCAG 1.4.1 refuse.',
      );
    }
  });

  it('réserve la place de la bordure dès le repos, pour que le fil ne saute pas', () => {
    const rest = rulesFor(booking, `.${NAME}`).join(' ');

    assert.match(
      declaration(rest, 'border') ?? '',
      /transparent/,
      `\`.${NAME}\` ne porte plus de bordure transparente au repos : l’étape ` +
        'gagne 2 px en devenant la courante, et le fil entier se décale à chaque geste.',
    );
  });

  it('ne double l’attribut d’aucune classe d’état', () => {
    // Le piège que le back-office a écarté en #30, et pour la même raison : deux
    // sources pour un seul état finissent par diverger, et c'est l'annonce au
    // lecteur d'écran qui se tait la première.
    for (const modifier of ['--active', '--current', '--done', '--todo']) {
      assert.equal(
        booking.includes(`${LIST}${modifier}`),
        false,
        `\`booking.css\` vise \`.${LIST}${modifier}\` : l’état de l’indicateur a ` +
          'une seconde source, qui peut diverger de `aria-current`.',
      );
      assert.equal(
        source.includes(`${LIST}${modifier}`),
        false,
        `\`booking-tunnel.tsx\` pose \`${LIST}${modifier}\` : l’état de ` +
          'l’indicateur a une seconde source, qui peut diverger de `aria-current`.',
      );
    }
  });
});

describe('Les étapes franchies se rouvrent d’un clic (#740)', () => {
  it('rend la cible cliquable atteignable au doigt (WCAG 2.5.8)', () => {
    const name = rulesFor(booking, `.${NAME}`).join(' ');

    assert.notEqual(
      declaration(name, 'min-block-size'),
      null,
      `\`.${NAME}\` ne déclare plus de hauteur minimale : la pastille d’une étape ` +
        'franchie retombe à la hauteur d’une ligne de 14 px, sous le minimum de WCAG 2.5.8.',
    );
  });

  it('donne au retour la forme d’un lien, pas celle d’un bouton', () => {
    const link = rulesFor(booking, `.${LINK}`).join(' ');

    assert.notEqual(link, '', `Aucune règle ne vise \`.${LINK}\`.`);
    // Le chrome natif d'un `<button>` ferait cinq boutons en tête du panneau,
    // au-dessus du seul qui compte — celui qui fait avancer la réservation.
    assert.equal(declaration(link, 'background'), 'none');
    assert.equal(declaration(link, 'font'), 'inherit');
    assert.equal(declaration(link, 'cursor'), 'pointer');
  });

  it('est rendu par le tunnel, faute de quoi la feuille ne déclenche rien', () => {
    for (const className of [LIST, STEP, NAME, LINK]) {
      assert.ok(
        source.includes(className),
        `\`booking-tunnel.tsx\` ne porte plus \`${className}\` : la feuille a beau ` +
          'déclarer la règle, plus rien ne la déclenche.',
      );
    }

    // La condition peut changer de forme ; ce qui est gardé, c'est que la
    // valeur `'step'` soit encore posée conditionnellement sur l'attribut.
    assert.match(
      source,
      /aria-current=\{[^}]*'step'/,
      '`booking-tunnel.tsx` ne pose plus `aria-current="step"` sur l’étape ' +
        'courante : la feuille ne peut plus rien habiller.',
    );
  });
});
