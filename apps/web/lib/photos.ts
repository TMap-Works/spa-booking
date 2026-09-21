/**
 * Le catalogue des photographies d'ambiance du produit.
 *
 * ## Pourquoi un registre, et non un chemin écrit dans chaque page
 *
 * Une photo d'ambiance est employée à deux endroits au moins — le volet
 * d'accueil d'un écran d'identification et la section qui lui répond sur la
 * page d'accueil —, et un chemin recopié est un chemin qui survit au fichier
 * qu'il désigne. Le registre donne à chaque image un nom, et le `tsc` nomme
 * tout ce qui suit le jour où l'une d'elles change.
 *
 * Il porte surtout le **texte alternatif** à côté du fichier. Écrit dans la
 * page, il aurait divergé d'un écran à l'autre pour la même photo ; écrit ici,
 * il est décidé une fois, avec l'image sous les yeux.
 *
 * ## Décoratives, et déclarées comme telles
 *
 * Aucune de ces photos ne porte d'information : elles donnent le registre du
 * lieu — un spa, un institut, un salon de coiffure, un barbier —, et le texte
 * qui les entoure dit déjà tout ce qu'il y a à savoir. Les composants qui les
 * posent en **fond** les rendent donc inertes pour les lecteurs d'écran
 * (`aria-hidden`), et celles qui sont posées en `<img>` portent l'`alt` ci-
 * dessous : une description brève de la scène, jamais une redite du titre
 * voisin. C'est la règle du skill `web-frontend` §5 et du critère `ds:a11y` de
 * l'audit de conception.
 *
 * ## Provenance et licence
 *
 * Toutes viennent d'Unsplash, dont la licence autorise l'usage commercial, la
 * modification et la redistribution sans attribution obligatoire
 * (https://unsplash.com/license). L'attribution reste néanmoins portée par
 * `apps/web/public/photos/LICENCE.md`, qui nomme chaque fichier et sa source :
 * une licence qu'on ne peut plus retracer est une licence qu'on ne peut plus
 * défendre.
 *
 * Les fichiers sont versionnés plutôt que chargés depuis un domaine tiers. Une
 * page de connexion qui attend le serveur d'un tiers est une page de connexion
 * qui blanchit quand ce tiers tombe, et un salon n'a pas à ce que son
 * back-office dépende d'un CDN public.
 */

/** Une photographie du catalogue — son fichier et ce qu'elle montre. */
export interface Photo {
  /** Le chemin servi, depuis `apps/web/public`. */
  readonly src: string;
  /**
   * Ce que montre la scène.
   *
   * Employé quand la photo est posée en `<img>`. En fond décoratif, l'élément
   * est masqué aux lecteurs d'écran et ce texte n'est pas rendu.
   */
  readonly alt: string;
  /** La largeur du fichier, en pixels — telle qu'il a été téléchargé. */
  readonly width: number;
  /** La hauteur du fichier, en pixels. */
  readonly height: number;
}

function photo(file: string, alt: string, width: number, height: number): Photo {
  return { src: `/photos/${file}`, alt, width, height };
}

/**
 * Les huit photographies du produit, nommées par ce qu'elles montrent.
 *
 * Les quatre métiers du CDC (§1.1) y sont représentés — spa, institut,
 * coiffure, barbier : la page d'accueil les annonce en surcapitale, et
 * n'illustrer que le massage aurait démenti la ligne qui les énumère.
 */
export const PHOTOS = {
  /** L'intérieur d'un spa ouvert sur un bassin et de la verdure. */
  spaInterieur: photo(
    'spa-interieur.jpg',
    'L’intérieur d’un spa, ouvert sur un bassin et des plantes',
    1600,
    1281,
  ),
  /** Un soin aux pierres chaudes, fleurs posées sur le dos. */
  soinPierresChaudes: photo(
    'soin-pierres-chaudes.jpg',
    'Un soin aux pierres chaudes posées le long du dos',
    1400,
    933,
  ),
  /** Les mains d'un praticien sur un dos, en massage. */
  massageDos: photo(
    'massage-dos.jpg',
    'Les mains d’une praticienne pendant un massage du dos',
    1100,
    1650,
  ),
  /** Une coiffeuse au brushing, dans un salon lumineux. */
  coiffureBrushing: photo(
    'coiffure-brushing.jpg',
    'Une coiffeuse termine un brushing dans un salon lumineux',
    1100,
    734,
  ),
  /** L'intérieur d'un salon de coiffure, postes alignés. */
  salonInterieur: photo(
    'salon-interieur.jpg',
    'Les postes de coiffage alignés dans un salon',
    1200,
    800,
  ),
  /** Un soin du visage appliqué au pinceau. */
  soinVisage: photo(
    'soin-visage.jpg',
    'Un soin du visage appliqué au pinceau, en institut',
    1000,
    667,
  ),
  /** Serviette roulée, flacon et fleurs — la table d'un soin. */
  natureMorteSpa: photo(
    'nature-morte-spa.jpg',
    'Une serviette roulée, un flacon de soin et des fleurs',
    1000,
    667,
  ),
  /** Un rasage chez le barbier. */
  barbier: photo('barbier.jpg', 'Un rasage en cours chez le barbier', 1000, 667),
} as const satisfies Readonly<Record<string, Photo>>;

/** Le nom d'une photographie du catalogue. */
export type PhotoName = keyof typeof PHOTOS;
