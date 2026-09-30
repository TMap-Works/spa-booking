/*
 * Un titre d'onglet par écran
 * =============================================================================
 *
 * Issue #1329, troisième critère d'acceptation : *« chaque page a un `<title>`
 * propre à l'écran »*.
 *
 * ## Ce que le défaut était, et pourquoi il ne se voyait pas en test
 *
 * Les trois espaces derrière authentification — back-office, espace client,
 * console de l'éditeur — posaient leur titre dans leur **layout**, et leurs
 * vingt-sept pages en héritaient tel quel. Trois onglets ouverts sur le
 * planning, le fichier client et les réglages portaient donc le même
 * « Back-office » ; un signet ne disait pas ce qu'il rouvrait, et la liste des
 * onglets d'un navigateur non plus.
 *
 * Rien ne rougissait : un titre hérité est un titre valide. C'est ce que cette
 * suite ferme, et elle le fait **par convention** plutôt que par énumération —
 * elle parcourt `app/`, si bien qu'un écran ajouté demain est couvert sans que
 * ce fichier bouge.
 *
 * ## La règle, en deux moitiés
 *
 * 1. **Chaque `page.tsx` des trois espaces exporte `generateMetadata`.** Et non
 *    un objet `metadata` constant : le titre est du texte traduit, il se lit dans
 *    le catalogue par `getTranslations`, qui est asynchrone (#845, #1106).
 * 2. **Chaque layout d'espace porte un `template`.** C'est lui qui situe le
 *    titre de la page — « Planning · Back-office » — et son `default` reste le
 *    titre de l'espace, qui n'est l'écran de personne.
 *
 * Le parcours public `(booking)` est hors de portée : ses trois pages posent
 * déjà leur titre, description et `robots` pour le référencement, et son layout
 * racine n'a pas d'espace à nommer.
 *
 * Elle ne mesure aucun rendu : la preuve au navigateur est la phase de recette
 * du ticket. Aucune dépendance, comme les autres suites de ce dossier.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');

/** Les trois espaces qui nomment un espace, et le layout qui en pose le gabarit. */
const ESPACES = [
  { nom: 'du back-office', racine: join(appDir, '(admin)'), layout: 'admin/layout.tsx' },
  { nom: 'de l’espace client', racine: join(appDir, '(account)'), layout: 'compte/layout.tsx' },
  { nom: 'de la console', racine: join(appDir, 'plateforme'), layout: 'plateforme/layout.tsx' },
];

/** Tous les fichiers portant un nom donné sous un dossier, en profondeur. */
function fichiers(dir, nom) {
  const trouves = [];

  for (const entree of readdirSync(dir, { withFileTypes: true })) {
    const complet = join(dir, entree.name);

    if (entree.isDirectory()) {
      trouves.push(...fichiers(complet, nom));
    } else if (entree.name === nom) {
      trouves.push(complet);
    }
  }

  return trouves.sort();
}

/** Le chemin tel qu'un message d'échec doit le montrer. */
function chemin(fichier) {
  return relative(join(here, '..'), fichier).split(sep).join('/');
}

describe('les titres d’onglet des espaces authentifiés (#1329)', () => {
  for (const espace of ESPACES) {
    it(`donne à chaque page ${espace.nom} son propre titre`, () => {
      const pages = fichiers(espace.racine, 'page.tsx');

      assert.ok(pages.length > 0, `aucune page trouvée sous ${chemin(espace.racine)}`);

      for (const page of pages) {
        const source = readFileSync(page, 'utf8');

        assert.match(
          source,
          /export async function generateMetadata\(/,
          `${chemin(page)} n’exporte pas generateMetadata : son onglet porterait le ` +
            'seul nom de son espace, comme les vingt-sept écrans de #1329.',
        );
        assert.match(
          source,
          /title: t\(/,
          `${chemin(page)} ne lit pas son titre dans le catalogue : un titre en dur ` +
            'ne suit pas la langue de la session (#845).',
        );
      }
    });
  }

  it('fait poser le gabarit du titre par le layout de chaque espace', () => {
    for (const espace of ESPACES) {
      const layout = fichiers(espace.racine, 'layout.tsx').find((fichier) =>
        chemin(fichier).endsWith(espace.layout),
      );

      assert.ok(layout, `layout introuvable : ${espace.layout}`);

      const source = readFileSync(layout, 'utf8');

      // `default` **et** `template` : le premier nomme l'espace, le second situe
      // le titre que la page pose. Un `title` nu écraserait celui de la page.
      assert.match(
        source,
        /title: \{ default: t\([^)]+\), template: t\([^)]+\) \}/,
        `${chemin(layout)} ne pose pas de gabarit de titre : les titres de ses pages ` +
          'ne seraient plus situés, « Planning » sans « · Back-office ».',
      );
    }
  });
});
