/*
 * Maquettes du tableau de bord admin — intégrité et accessibilité
 * =============================================================================
 *
 * Issue #30. `apps/web` ne porte ni `react`, ni `next`, ni `next.config.*` : des
 * `.tsx` y seraient du code mort, non compilé et non linté. Les écrans sont donc
 * livrés comme l'a fait le design system (#29) — du CSS piloté par jetons et des
 * contrats de balisage — mais rendus ici en pages HTML statiques ouvrables telles
 * quelles dans un navigateur. Ce sont les maquettes.
 *
 * Le risque de ce format est connu : une maquette et sa feuille de style dérivent
 * l'une de l'autre en silence, et la documentation devient un mensonge daté. Cette
 * suite est ce qui l'empêche. Elle vérifie dans les deux sens — aucune classe
 * inventée dans une maquette, aucun style admin que plus aucune maquette n'exerce
 * — puis quelques invariants que la revue humaine rate systématiquement : un
 * champ sans libellé, un identifiant en double, un état vide manquant.
 *
 * Elle porte enfin la garantie la plus coûteuse à perdre du projet : l'écran
 * d'encaissement n'offre nulle part où saisir un numéro de carte. Cette
 * interdiction ne se confie pas à la vigilance du prochain contributeur — elle
 * s'exécute.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent. Le front
 * n'a pas de gestionnaire de paquets propre, et `package.json` est hors du
 * périmètre de cette issue.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { listStyleSheets, readStyleSheet, relativeName, stripComments } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mockupsDir = join(here, '..', 'mockups', 'admin');

/** Les cinq écrans des critères d'acceptation, plus leur sommaire. */
const SCREENS = {
  'calendrier.html': 'calendrier jour et semaine',
  'rendez-vous.html': 'création et édition manuelle d’un rendez-vous',
  'fiche-client.html': 'fiche client, notes et historique',
  'personnel.html': 'personnel et horaires',
  'encaissement.html': 'encaissement et POS',
};
const SUMMARY = 'index.html';

const readMockup = (file) => readFileSync(join(mockupsDir, file), 'utf8');

/** Neutralise les commentaires HTML : ils décrivent l'intention, pas le rendu. */
const stripHtmlComments = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));

/** Classes portées par les éléments d'une maquette. */
function usedClasses(html) {
  const found = new Set();
  for (const match of stripHtmlComments(html).matchAll(/\sclass="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) {
      if (name) found.add(name);
    }
  }
  return found;
}

/**
 * Classes citées par un sélecteur CSS.
 *
 * Le premier caractère doit être une lettre : sans cette contrainte, `0.25rem`
 * et `1.4s` ressortiraient comme des classes. Les `@import` sont retirés d'abord,
 * pour la même raison — `./tokens.css` s'y lirait comme la classe « css ».
 */
function declaredClasses(sheets) {
  const found = new Map();
  for (const sheet of sheets) {
    const css = stripComments(readStyleSheet(sheet)).replace(/@import[^;]*;/g, '');
    for (const match of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      if (!found.has(match[1])) found.set(match[1], relativeName(sheet));
    }
  }
  return found;
}

const allSheets = listStyleSheets();
const declared = declaredClasses(allSheets);
const adminOnly = declaredClasses(
  allSheets.filter((sheet) => relativeName(sheet).startsWith('admin/')),
);

const mockupFiles = readdirSync(mockupsDir).filter((file) => file.endsWith('.html'));

describe('Les cinq écrans existent et sont autoportants', () => {
  it('livre une maquette par critère d’acceptation, plus son sommaire', () => {
    assert.deepEqual(
      [...mockupFiles].sort(),
      [...Object.keys(SCREENS), SUMMARY].sort(),
      'les fichiers de mockups/admin/ ne correspondent pas aux cinq écrans attendus.',
    );
  });

  for (const file of [...Object.keys(SCREENS), SUMMARY]) {
    it(`${file} charge les deux points d’entrée du front`, () => {
      const html = readMockup(file);

      // L'ordre est contraint : l'entrée partagée déclare les jetons que le
      // chrome admin consomme. Inversée, la page se peindrait sans ses couleurs.
      const shared = html.indexOf('../../styles/index.css');
      const admin = html.indexOf('../../styles/admin/index.css');

      assert.ok(shared !== -1, `${file} n'importe pas styles/index.css.`);
      assert.ok(admin !== -1, `${file} n'importe pas styles/admin/index.css.`);
      assert.ok(
        shared < admin,
        `${file} importe le chrome admin avant les jetons partagés.`,
      );
    });
  }
});

describe('Maquettes et feuilles de style ne dérivent pas', () => {
  for (const file of mockupFiles) {
    it(`${file} n’emploie aucune classe inconnue du design system`, () => {
      for (const name of usedClasses(readMockup(file))) {
        assert.ok(
          declared.has(name),
          `${file} emploie « ${name} », qui n'est définie dans aucune feuille de ` +
            `styles/. Une maquette ne dessine rien qu'elle n'ait déclaré.`,
        );
      }
    });
  }

  it('aucun style admin n’est laissé sans maquette qui l’exerce', () => {
    // Le sens qui manque le plus souvent : une règle survit à l'écran qui la
    // motivait, personne ne le remarque, et la feuille grossit de code mort que
    // plus rien ne montre.
    const shown = new Set();
    for (const file of mockupFiles) {
      for (const name of usedClasses(readMockup(file))) shown.add(name);
    }

    for (const [name, sheet] of adminOnly) {
      assert.ok(
        shown.has(name),
        `${sheet} définit « ${name} », qu'aucune maquette n'emploie. Retirer la ` +
          `règle, ou montrer l'état qu'elle décrit.`,
      );
    }
  });

  it('les maquettes ne peignent aucune couleur en dur', () => {
    // Même contrat que `tokens.test.mjs` côté CSS : la personnalisation par
    // tenant ne vaut que si RIEN, nulle part, ne court-circuite la couche
    // sémantique. Un attribut `style` suffirait à rouvrir la brèche.
    for (const file of mockupFiles) {
      const html = stripHtmlComments(readMockup(file));

      assert.doesNotMatch(
        html,
        /\sstyle="/,
        `${file} porte un attribut style inline : tout passe par une classe et un jeton.`,
      );
      assert.doesNotMatch(
        html,
        /#[0-9a-fA-F]{3,8}\b/,
        `${file} contient une couleur hexadécimale littérale.`,
      );
      assert.doesNotMatch(
        html,
        /<style[\s>]/,
        `${file} embarque une feuille de style locale au lieu du design system.`,
      );
    }
  });
});

describe('Les trois états de chaque écran', () => {
  for (const [file, label] of Object.entries(SCREENS)) {
    it(`${label} distingue « ça charge » de « il n’y a rien »`, () => {
      // La règle §6 de la skill web-frontend, et un critère de l'issue #29 repris
      // ici : les deux ne sont pas le même écran, et un état vide sans
      // explication est un bug d'UX.
      const html = stripHtmlComments(readMockup(file));

      assert.match(
        html,
        /aria-busy="true"/,
        `${file} ne montre aucun état de chargement (aria-busy="true" absent).`,
      );
      assert.match(
        html,
        /spa-empty-state|--empty/,
        `${file} ne montre aucun état vide.`,
      );
      assert.match(
        html,
        /spa-empty-state__description/,
        `${file} a un état vide sans texte d'explication.`,
      );
    });
  }
});

describe('Accessibilité des maquettes', () => {
  for (const file of mockupFiles) {
    it(`${file} nomme chacun de ses contrôles de saisie`, () => {
      const html = stripHtmlComments(readMockup(file));
      const labelled = new Set(
        [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((match) => match[1]),
      );

      for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const [, tag, attributes] = match;
        if (/\stype="hidden"/.test(attributes)) continue;

        const id = attributes.match(/\sid="([^"]+)"/)?.[1];
        const named =
          /\saria-label(?:ledby)?="/.test(attributes) || (id && labelled.has(id));

        assert.ok(
          named,
          `${file} : un <${tag}> n'a aucun nom accessible — ni <label for>, ni ` +
            `aria-label, ni aria-labelledby. « ${match[0].trim()} »`,
        );
      }
    });

    it(`${file} n’a ni identifiant en double ni référence pendante`, () => {
      const html = stripHtmlComments(readMockup(file));
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

      const seen = new Set();
      for (const id of ids) {
        assert.ok(!seen.has(id), `${file} déclare deux fois l'identifiant « ${id} ».`);
        seen.add(id);
      }

      // `for`, `aria-labelledby` et `aria-describedby` désignent des éléments
      // absents sans que rien ne se voie : le libellé disparaît simplement de
      // l'annonce, et seul un lecteur d'écran s'en aperçoit.
      const references = /\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/g;
      for (const match of html.matchAll(references)) {
        for (const reference of match[1].split(/\s+/)) {
          assert.ok(
            seen.has(reference),
            `${file} pointe l'identifiant « ${reference} », qui n'existe nulle part.`,
          );
        }
      }
    });

    it(`${file} ne confie aucun comportement à un gestionnaire en ligne`, () => {
      const html = stripHtmlComments(readMockup(file));

      assert.doesNotMatch(
        html,
        /<script[\s>]/,
        `${file} contient du script : les maquettes sont statiques et se lisent ` +
          `en ouvrant le fichier.`,
      );
      assert.doesNotMatch(
        html,
        /\son(?:click|change|input|submit|load|focus|blur)=/i,
        `${file} porte un gestionnaire d'événement en ligne. Une <div> cliquable ` +
          `sort de l'ordre de tabulation — un contrôle est un <button> ou un <a>.`,
      );
    });

    it(`${file} déclare sa langue et son titre`, () => {
      const html = readMockup(file);
      assert.match(html, /<html lang="fr">/, `${file} ne déclare pas sa langue.`);
      assert.match(html, /<title>[^<]+<\/title>/, `${file} n'a pas de titre.`);
      assert.match(html, /<meta charset="utf-8"/, `${file} ne déclare pas son encodage.`);
    });
  }
});

describe('Frontière PCI — l’écran d’encaissement', () => {
  /*
   * La contrainte non négociable n° 3 du projet : aucune donnée de carte ne
   * touche notre code. Elle est ici vérifiée par exécution plutôt que confiée à
   * la relecture, parce que le champ qui la briserait est exactement celui qui
   * « semble manquer » à qui découvre l'écran.
   */
  const CARD_FIELD = /(?:^|[^a-z])(?:carte|card|cvc|cvv|pan|cryptogramme|expirat)/i;
  /** Saisies libres : celles où un numéro pourrait être tapé. */
  const FREE_TEXT = /^(?:text|tel|number|password|email|search)$/;

  it('n’offre aucun champ où saisir un numéro de carte', () => {
    const html = stripHtmlComments(readMockup('encaissement.html'));

    // `<textarea>` et `<select>` sont examinés au même titre que `<input>` : un
    // numéro se tape aussi bien dans une zone de texte, et n'inspecter que les
    // `<input>` laisserait la garantie contournable par un seul mot de balise.
    for (const match of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
      const [, tag, attributes] = match;
      const type = attributes.match(/\stype="([^"]+)"/)?.[1] ?? 'text';

      assert.doesNotMatch(
        attributes,
        /\sautocomplete="cc-/i,
        `un champ annonce de l'autocomplétion de carte : « ${match[0].trim()} »`,
      );

      // Une case à cocher, un bouton radio ou une liste de choix ne portent pas
      // de numéro : seuls les champs de saisie libre sont examinés.
      if (tag === 'select') continue;
      if (tag === 'input' && !FREE_TEXT.test(type)) continue;

      const identity = [
        attributes.match(/\sid="([^"]+)"/)?.[1] ?? '',
        attributes.match(/\sname="([^"]+)"/)?.[1] ?? '',
        attributes.match(/\splaceholder="([^"]+)"/)?.[1] ?? '',
      ].join(' ');

      assert.doesNotMatch(
        identity,
        CARD_FIELD,
        `« ${match[0].trim()} » ressemble à une saisie de données de carte. Le ` +
          `montant part vers le lecteur Stripe Terminal ; rien ne se tape ici. ` +
          `Un tel champ ferait basculer le projet de SAQ A à SAQ D.`,
      );
    }
  });

  it('écrit la règle sur l’écran, à l’intention de l’opérateur', () => {
    // La frontière n'est pas qu'une affaire de développeurs : un numéro noté sur
    // un papier au comptoir est le même incident.
    const html = readMockup('encaissement.html');
    assert.match(
      html,
      /spa-admin-checkout__pci/,
      'la mention de la frontière PCI a disparu de l’écran d’encaissement.',
    );
  });

  it('ne contient aucune suite de chiffres à longueur de carte', () => {
    // Attrape la carte de test collée « juste pour voir le rendu », qui se
    // retrouverait versionnée.
    for (const file of mockupFiles) {
      const html = stripHtmlComments(readMockup(file));
      assert.doesNotMatch(
        html,
        /\b(?:\d[ -]?){13,19}\b/,
        `${file} contient une suite de chiffres de longueur de numéro de carte.`,
      );
    }
  });
});
