/**
 * Les données lues, mises entre balises pour le modèle — P5-02 (#1470).
 *
 * Le prompt dit au modèle que ce qui figure entre `<donnees_salon>`,
 * `<contexte_page>`… sont des données. Une donnée qui contiendrait elle-même
 * `</donnees_salon>` refermerait la balise et ferait passer la suite pour du
 * texte de premier rang : un nom de prestation, un nom de cliente ou une valeur
 * envoyée par la page suffiraient. Chaque donnée passe donc par `asData`, qui
 * neutralise toute balise ouvrante ou fermante, quel que soit son nom.
 */

/** `<` et `>` d'une balise deviennent `‹` et `›` : le texte reste lisible, plus aucune balise ne se ferme. */
export function asData(text: string): string {
  return text.replace(/<(\/?[\p{L}_][^<>]{0,80})>/gu, '‹$1›');
}

/** Bornes du contexte qu'envoie la page : il vient du navigateur, donc de n'importe qui. */
export const PAGE_CONTEXT_LIMITS = { entries: 4, chars: 600 } as const;
