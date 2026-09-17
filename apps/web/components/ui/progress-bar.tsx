/**
 * La barre de progression de navigation, en haut de la fenêtre (#830).
 *
 * ## Deux propriétaires, une seule apparence
 *
 * Elle est peinte à deux moments d'une même navigation, par deux composants :
 *
 * 1. **du clic à l'arrivée de l'URL** — par `NavigationProgress`, qui écoute les
 *    clics depuis le layout racine ;
 * 2. **pendant que l'écran charge** — par les `loading.tsx` de chaque espace, qui
 *    la rendent avec leur squelette.
 *
 * Le second relaie le premier : l'URL change au moment où le squelette s'affiche,
 * et la barre du clic s'éteint alors que celle du squelette s'allume. C'est ce qui
 * la garde visible jusqu'au contenu, sans que personne ait à deviner quand
 * celui-ci arrive — le squelette disparaît avec lui.
 *
 * ## Ce qu'elle n'annonce pas
 *
 * Elle est décorative (`aria-hidden`). Ce qui se dit à un lecteur d'écran se dit
 * une fois, là où l'attente a un objet : `aria-busy` et le message masqué du
 * squelette, puis l'annonce de page que l'App Router fait à l'arrivée. Une
 * barre annoncée en plus doublerait chaque navigation.
 *
 * Composant sans état ni écouteur : il se rend côté serveur comme côté client.
 */
export function ProgressBar() {
  return (
    <div aria-hidden="true" className="spa-progress">
      <span className="spa-progress__bar" />
    </div>
  );
}
