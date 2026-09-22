/**
 * Les libellés du parcours public, lus **dans les catalogues** (#846).
 *
 * ## Pourquoi la suite E2E n'écrit plus ses libellés en dur
 *
 * Le parcours doit être traversable en français **et** en anglais : c'est le
 * huitième critère d'acceptation de #846. Une scène qui cherche
 * `getByRole('button', { name: 'Choisir un créneau' })` ne décrit plus le
 * produit, elle décrit une de ses deux langues — et la seconde passe rouge sans
 * qu'aucune régression n'ait eu lieu.
 *
 * Les gestes de `scene.ts` désignent donc leurs cibles par **clé de catalogue**,
 * et ce module rend le libellé de la langue jouée. Effet de bord heureux : un
 * libellé déplacé dans le catalogue sans l'être dans la suite fait échouer la
 * suite pour la bonne raison — la clé est introuvable, et le message le dit —,
 * là où une chaîne en dur aurait rendu un « élément introuvable » muet.
 *
 * ## Pourquoi `readFileSync` et non un `import`
 *
 * La langue jouée n'est connue qu'à l'exécution, et Playwright transpile ses
 * suites en CommonJS : un `import` dynamique de JSON y coûterait plus
 * d'explications que la lecture directe. C'est aussi ce que fait
 * `i18n/messages.ts` côté produit, et pour une raison voisine — plusieurs
 * lecteurs, une seule façon de lire.
 *
 * ## L'espace client aussi, depuis #1134
 *
 * Les écrans de l'espace client — connexion, inscription — ont été traduits par
 * leur ticket de l'épique #843, et la scène lit désormais leurs libellés dans
 * `account.json` comme elle lit ceux du tunnel dans `booking.json`. Le
 * namespace est le seul écart : la clé reste complète et se résout pareil.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Locale } from '@spa/shared';

import { RACINE_WEB } from './environnement';

type Arbre = { readonly [cle: string]: string | Arbre };

/** Un catalogue déjà lu, par langue et par namespace. */
const CATALOGUES = new Map<string, Arbre>();

function catalogue(langue: Locale, namespace: string): Arbre {
  const cache = `${langue}/${namespace}`;
  const connu = CATALOGUES.get(cache);

  if (connu !== undefined) {
    return connu;
  }

  const lu = JSON.parse(
    readFileSync(path.join(RACINE_WEB, 'messages', langue, `${namespace}.json`), 'utf8'),
  ) as Arbre;

  CATALOGUES.set(cache, lu);

  return lu;
}

/**
 * Le libellé de cette clé, dans cette langue.
 *
 * La clé est **complète**, namespace compris — « booking.tunnel.header.back »,
 * « public-exits.exits.reservation » —, exactement comme le composant l'écrit
 * en réunissant son `useTranslations('…')` et l'argument de `t`.
 *
 * Les paramètres sont substitués littéralement : les clés visées par la suite
 * n'ont ni pluriel ni forme conditionnelle, et embarquer un formateur ICU dans
 * le banc d'essai reviendrait à éprouver `next-intl` au lieu du produit.
 *
 * Une clé absente **lève**, et c'est délibéré : un `undefined` deviendrait un
 * sélecteur qui ne trouve rien, et la suite accuserait l'écran d'avoir perdu un
 * bouton qu'il affiche parfaitement.
 */
export function libelle(
  langue: Locale,
  cle: string,
  parametres: Readonly<Record<string, string>> = {},
): string {
  const [namespace = '', ...chemin] = cle.split('.');
  let noeud: string | Arbre = catalogue(langue, namespace);

  for (const segment of chemin) {
    if (typeof noeud === 'string') {
      throw new Error(`« ${cle} » traverse une feuille du catalogue « ${langue} ».`);
    }

    // Annoté : sans cela, `tsc` lit une référence circulaire entre `noeud` et
    // son propre initialiseur (TS7022).
    const suivant: string | Arbre | undefined = noeud[segment];

    if (suivant === undefined) {
      throw new Error(`« ${cle} » est absente des catalogues « ${langue} ».`);
    }

    noeud = suivant;
  }

  if (typeof noeud !== 'string') {
    throw new Error(`« ${cle} » désigne une section de catalogue, pas un libellé.`);
  }

  return Object.entries(parametres).reduce(
    (texte, [nom, valeur]) => texte.replaceAll(`{${nom}}`, valeur),
    noeud,
  );
}

/**
 * Le même libellé, en expression régulière **ancrée au début**.
 *
 * C'est ce qu'il faut pour les noms accessibles composés — « Créneaux du lundi
 * 5 octobre », dont seule la tête est un libellé de catalogue : le reste est une
 * date qu'`Intl` met en forme, et que la suite n'a aucune raison de recalculer
 * pour la reconnaître.
 *
 * Le libellé est donc **coupé au premier paramètre non fourni**, et les
 * caractères spéciaux de ce qui reste sont échappés — plusieurs libellés portent
 * une parenthèse ou un point.
 *
 * Il coupe aussi ce qui suit : « Jour du rendez-vous — {month} » devient
 * `^Jour du rendez-vous — `, et c'est bien la tête, la seule partie stable d'une
 * langue et d'un mois à l'autre.
 */
export function debuteParLibelle(
  langue: Locale,
  cle: string,
  parametres: Readonly<Record<string, string>> = {},
): RegExp {
  const complet = libelle(langue, cle, parametres);
  const parametre = complet.indexOf('{');
  const tete = parametre === -1 ? complet : complet.slice(0, parametre);

  return new RegExp(`^${tete.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
}
