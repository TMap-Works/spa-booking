/**
 * L'élision, telle qu'un message du catalogue peut la choisir — « la fiche
 * d'Alice », et non « la fiche de Alice » (#1329).
 *
 * ## Pourquoi cela ne se règle pas dans le catalogue seul
 *
 * Parce qu'ICU ne sait pas regarder la valeur qu'on lui insère : `{client}` est
 * un trou, et aucun `select` ne peut s'y brancher tout seul. La règle qui décide
 * — « le mot suivant commence-t-il par une voyelle ? » — est donc calculée ici,
 * puis **passée comme argument** au message, qui porte la grammaire :
 *
 * ```json
 * "openRecord": "{elision, select, vowel {… d’{client}} other {… de {client}}}"
 * ```
 *
 * C'est le partage qui garde chaque chose à sa place. Le code ne sait rien du
 * français : il rend `'vowel'` ou `'consonant'`, deux étiquettes neutres. Le
 * catalogue **français** sait que « de » s'élide devant une voyelle ; l'anglais
 * n'élide rien, et ses deux branches portent donc la **même** phrase — « Open
 * {client}'s appointment » quelle que soit l'initiale. Deux branches identiques
 * et non un message sans `select` : `tests/unit/messages-parity.test.ts` exige
 * que les deux langues déclarent les mêmes paramètres ICU, faute de quoi un
 * argument passé par le composant serait silencieusement perdu d'un côté.
 *
 * L'alternative aurait été une fonction qui compose « d'Alice » en TypeScript.
 * Elle aurait mis une règle de grammaire française dans du code lu par les deux
 * langues, et rendu l'élision invisible au traducteur, à qui elle appartient.
 *
 * ## Ce que « commence par une voyelle » veut dire ici
 *
 * Les cinq voyelles, `y` comprise, et les formes accentuées qu'un prénom porte
 * couramment — « Émile », « Ophélie », « Ève ». La comparaison se fait sur la
 * forme **décomposée puis dépouillée de ses diacritiques** (`NFD`), ce qui
 * évite d'énumérer les accents un par un et traite du même coup « Ana » et
 * « Àna ».
 *
 * Le **h muet** n'est pas traité, et c'est délibéré : « Hélène » veut « d'Hélène »
 * quand « Hugo » veut « de Hugo », et rien dans une chaîne de caractères ne dit
 * lequel des deux h on a sous les yeux. Un dictionnaire de prénoms trancherait
 * mal — le produit sert des clientes du monde entier — et se tromperait avec
 * aplomb. Devant un h, la forme non élidée reste donc la forme rendue : elle est
 * lourde, jamais fausse.
 */

/** L'étiquette que le message attend — les valeurs du `select` du catalogue. */
export type ElisionForm = 'vowel' | 'consonant';

/** Les voyelles, diacritiques retirés. `y` en fait partie : « d'Yvon ». */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/**
 * `'vowel'` si le nom commence par un son de voyelle, `'consonant'` sinon.
 *
 * Une chaîne vide rend `'consonant'` : c'est la forme non élidée, celle qui reste
 * lisible si le nom manque à l'appel.
 */
export function elisionForm(name: string): ElisionForm {
  const first = name
    .trim()
    // `NFD` sépare la lettre de son accent, et la plage des diacritiques
    // combinants retire les accents ainsi détachés : « É » devient « E ».
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .charAt(0)
    .toLowerCase();

  return VOWELS.has(first) ? 'vowel' : 'consonant';
}
