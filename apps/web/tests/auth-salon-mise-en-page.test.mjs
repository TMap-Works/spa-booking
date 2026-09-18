/*
 * Écrans d'identification clients — ce que seule la feuille de style tient
 * =============================================================================
 *
 * Issue #1052, audit de conception `d20260918-1`, critère `ds:mobile`. Le
 * constat est une **mesure** : à 360 px, le volet sombre occupe 270 px avant le
 * premier champ de la connexion, et le bouton « Créer mon compte » tombe à
 * 1 290 px sur l'inscription. Aucun test de rendu ne le signalerait — jsdom ne
 * peint rien, et `tests/unit/salon-auth-screen.test.tsx`, qui éprouve la
 * structure, les libellés et la bascule du mot de passe, resterait vert si le
 * volet d'accueil redevenait une colonne pleine hauteur sur un téléphone.
 *
 * Même partage que `salon-vitrine-mise-en-page.test.mjs`, dont cette suite
 * reprend le raisonnement et les outils. La preuve visuelle, elle, est au
 * navigateur : phase de recette de #1052.
 *
 * Exécution : `node --test apps/web/tests/`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  declaration,
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const auth = stripComments(readStyleSheet(styleSheetPath('components/auth.css')));
const account = stripComments(readStyleSheet(styleSheetPath('components/account.css')));

/** Sous 56 rem — la largeur d'un téléphone, celle que l'audit mesure. */
const etroit = withoutMediaQueries(auth);

const INTRO = '.spa-auth--salon .spa-auth__intro';

describe('À 360 px, le volet d’accueil est une bande (#1052)', () => {
  it('se couche en ligne : monogramme et titre, pas une colonne pleine hauteur', () => {
    const regle = rulesFor(etroit, INTRO).join(' ');

    assert.notEqual(regle, '', `Aucune règle ne vise \`${INTRO}\` hors palier.`);
    assert.equal(
      declaration(regle, 'flex-direction'),
      'row',
      'Couché, le volet tient en une bande ; empilé, il repousse le premier ' +
        'champ hors du premier écran — les 270 px que l’audit mesure.',
    );
  });

  it('efface ce que le titre dit déjà, et ce qui se lit sur la vitrine', () => {
    for (const cible of ['.spa-auth__salon-name', '.spa-auth__lead', '.spa-auth__facts']) {
      const regle = rulesFor(etroit, `.spa-auth--salon ${cible}`).join(' ');

      assert.equal(
        declaration(regle, 'display'),
        'none',
        `\`${cible}\` doit s’effacer sous 56 rem : le nom du salon est dans le ` +
          'titre, et l’adresse comme les horaires se lisent sur la vitrine d’où ' +
          'l’on vient. Les garder ici coûte la bande entière.',
      );
    }
  });

  it('ne laisse pas 32 px de vide entre l’en-tête du salon et le cadre', () => {
    // Deux classes sur le même élément : `.spa-shell .spa-auth--client` pesait
    // autant que `.spa-shell .spa-auth` de `salon-shell.css` et ne l'emportait
    // que par l'ordre des imports.
    const regle = rulesFor(etroit, '.spa-shell .spa-auth.spa-auth--salon').join(' ');

    assert.equal(
      declaration(regle, 'padding-block-start'),
      'var(--spa-space-4)',
      'Le cadre est déjà sous l’en-tête du gabarit : le retrait de 32 px que ' +
        '`salon-shell.css` pose pour la vitrine repousse ici le premier champ ' +
        'pour du blanc.',
    );
  });
});

describe('À partir de 56 rem, les deux volets et l’identité du salon', () => {
  it('redresse l’accueil et montre ce que le salon est', () => {
    // La feuille **entière** : c'est du palier qu'on parle.
    const redresse = rulesFor(auth, INTRO).some(
      (corps) => declaration(corps, 'flex-direction') === 'column',
    );
    const faits = rulesFor(auth, '.spa-auth--salon .spa-auth__facts').some(
      (corps) => declaration(corps, 'display') === 'flex',
    );

    assert.ok(redresse, 'Sans ce palier, le volet resterait une bande sur un écran large.');
    assert.ok(
      faits,
      'Le bas du volet porte l’adresse et l’état d’ouverture du salon : c’est ce ' +
        'qui remplace les trois puces génériques que l’audit relève à 1 280 px.',
    );
  });
});

describe('Le cadre du back-office n’est pas touché (critère d’acceptation)', () => {
  it('garde son volet en colonne et ses puces', () => {
    const nominal = withoutMediaQueries(auth);

    assert.equal(
      declaration(rulesFor(nominal, '.spa-auth__intro').join(' '), 'flex-direction'),
      'column',
      'La règle partagée reste celle qu’elle était : la variante cliente ' +
        'l’étend sous `.spa-auth--salon`, elle ne la remplace pas.',
    );
    assert.notEqual(
      rulesFor(nominal, '.spa-auth__highlights').join(' '),
      '',
      'Les puces servent encore la connexion du back-office, l’invitation et ' +
        'la console : ce ticket n’y touche pas.',
    );
  });

  it('ne pose aucune règle sur `.spa-auth--back-office`', () => {
    assert.ok(
      !auth.includes('.spa-auth--back-office'),
      'Une règle visant explicitement le back-office serait le début de la ' +
        'régression que le critère d’acceptation interdit.',
    );
  });
});

describe('L’inscription raccourcit sa colonne (#1052)', () => {
  it('met prénom et nom sur une ligne dès 30 rem, et pas avant', () => {
    const nominal = withoutMediaQueries(account);
    const base = rulesFor(nominal, '.spa-account__form-row').join(' ');

    assert.equal(declaration(base, 'display'), 'grid');
    assert.equal(
      declaration(base, 'grid-template-columns'),
      null,
      'Sous 30 rem, deux champs de 90 px ne se remplissent pas : la rangée ' +
        'retombe en colonne.',
    );

    const palier = rulesFor(account, '.spa-account__form-row').some(
      (corps) => declaration(corps, 'grid-template-columns') === 'repeat(2, minmax(0, 1fr))',
    );

    assert.ok(palier, 'Sans le palier, la rangée ne gagne jamais sa seconde colonne.');
  });

  it('colore le critère de longueur avec un jeton dont le contraste est vérifié', () => {
    const regle = rulesFor(
      account,
      ".spa-account__password-rule[data-met='true'] .spa-field__hint",
    ).join(' ');

    assert.equal(
      declaration(regle, 'color'),
      'var(--spa-color-success)',
      'La paire succès / surface est vérifiée à 4,5:1 dans les deux thèmes par ' +
        '`contrast.test.mjs` ; toute autre valeur sortirait de ce filet.',
    );
  });
});
