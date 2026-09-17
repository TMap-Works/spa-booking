/**
 * Un clic annonce-t-il un changement d'écran dans cet onglet ? (#830)
 *
 * ## Pourquoi cette question se pose au clic
 *
 * L'App Router n'expose aucun état « navigation en cours » à l'échelle de
 * l'application : `useLinkStatus` ne répond que pour le `<Link>` qui l'entoure,
 * et `usePathname` ne change qu'**après** l'arrivée de l'écran suivant. Entre les
 * deux, l'écran précédent restait figé, et c'est tout le constat de #830. La
 * seule chose qu'on sache au moment du geste, c'est qu'un lien a été cliqué — ce
 * module dit si ce clic va effectivement quitter l'écran courant.
 *
 * ## Ce qui n'en est pas un
 *
 * Tout ce que le navigateur ou le routeur ne traitent pas comme un changement
 * d'écran dans l'onglet courant :
 *
 * - un autre bouton que le principal, ou une touche de modification — ouverture
 *   dans un nouvel onglet ou une nouvelle fenêtre, téléchargement ;
 * - une cible autre que `_self`, un attribut `download` ;
 * - une autre origine : le navigateur a son propre indicateur, et l'onglet part ;
 * - la même adresse, au fragment près — une ancre dans la page, ou l'entrée du
 *   rail qui désigne l'écran déjà ouvert. Aucune URL ne changerait, et rien ne
 *   viendrait donc éteindre l'indicateur.
 *
 * Le `defaultPrevented` du clic n'est **pas** lu, et c'est délibéré : `<Link>`
 * l'annule justement pour naviguer lui-même, si bien qu'il ne distingue pas un
 * lien du routeur d'un lien neutralisé. Aucun lien de `apps/web` n'annule sa
 * navigation.
 *
 * Fonction pure, sans React : c'est ce qui permet de l'éprouver clic par clic.
 */

/** Le sous-ensemble d'un `MouseEvent` que la décision lit. */
export interface NavigationClick {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

/** L'adresse courante — `window.location` s'y conforme. */
export interface CurrentLocation {
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

/** Bouton principal de la souris, ou toucher — `MouseEvent.button`. */
const PRIMARY_BUTTON = 0;

export function isTrackedNavigation(click: NavigationClick, current: CurrentLocation): boolean {
  if (click.button !== PRIMARY_BUTTON) {
    return false;
  }

  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
    return false;
  }

  // Le clic part souvent d'un descendant du lien — un libellé, l'indicateur
  // d'attente lui-même : c'est l'ancêtre `<a>` qui dit où l'on va.
  const anchor =
    click.target instanceof Element ? click.target.closest<HTMLAnchorElement>('a[href]') : null;

  if (anchor === null) {
    return false;
  }

  const target = anchor.getAttribute('target');
  if ((target !== null && target !== '' && target !== '_self') || anchor.hasAttribute('download')) {
    return false;
  }

  let destination: URL;
  try {
    destination = new URL(anchor.getAttribute('href') ?? '', current.href);
  } catch {
    return false;
  }

  if (destination.origin !== current.origin) {
    return false;
  }

  return destination.pathname !== current.pathname || destination.search !== current.search;
}
