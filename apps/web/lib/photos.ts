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
 * ## La langue (#1233) : une clé, jamais une phrase
 *
 * Les huit descriptions étaient écrites ici, en français. Elles vivent
 * désormais dans le catalogue, et le registre n'en garde que la **clé**
 * (`altKey`) — la clé reste décidée une fois, avec l'image sous les yeux, et
 * c'est l'écran qui la traduit.
 *
 * Ce module n'importe donc **aucun catalogue**, et c'est délibéré : c'est la
 * doctrine posée par #1142: un module pur atteignable depuis un Client
 * Component qui importe `messages/<langue>/<ns>.json` fait agréger le catalogue
 * entier, dans les deux langues, par webpack — pour huit chaînes. Trois écrans
 * d'identification et le cadre client (`components/auth/*`) importent ce
 * registre ; le faire lire un catalogue aurait alourdi leurs bundles sans rien
 * apporter, `NextIntlClientProvider` portant déjà ces messages.
 *
 * Le namespace n'est pas nommé ici non plus : la clé est relative, et l'écran
 * qui pose la photo la résout dans **son** catalogue. Aujourd'hui, seul
 * l'accueil de la plateforme rend ces photos en `<img>` — il les lit sous
 * `home.photos` du namespace `booking`.
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

/**
 * Le nom d'une photographie du catalogue.
 *
 * Énuméré plutôt que dérivé de `PHOTOS` : `altKey` en dépend, et un
 * `keyof typeof PHOTOS` aurait rendu le type circulaire. Le `satisfies` posé
 * sur le registre garde les deux listes alignées — une photo ajoutée sans son
 * nom, un nom sans sa photo, ou une entrée qui porterait la clé d'une autre, ne
 * compile pas.
 */
export type PhotoName =
  | 'spaInterieur'
  | 'soinPierresChaudes'
  | 'massageDos'
  | 'coiffureBrushing'
  | 'salonInterieur'
  | 'soinVisage'
  | 'natureMorteSpa'
  | 'barbier';

/** Une photographie du catalogue — son fichier et ce qu'elle montre. */
export interface Photo {
  /** Le chemin servi, depuis `apps/web/public`. */
  readonly src: string;
  /**
   * La clé du catalogue qui décrit la scène — voir l'en-tête (#1233).
   *
   * Employée quand la photo est posée en `<img>` : l'écran la résout dans son
   * propre namespace. En fond décoratif, l'élément est masqué aux lecteurs
   * d'écran et aucun texte n'est rendu.
   *
   * C'est le nom de la photo elle-même : une entrée du registre et sa
   * description portent la même clé, et il n'y a donc qu'un mot à retrouver
   * dans les catalogues.
   */
  readonly altKey: PhotoName;
  /** La largeur du fichier, en pixels — telle qu'il a été téléchargé. */
  readonly width: number;
  /** La hauteur du fichier, en pixels. */
  readonly height: number;
}

/**
 * Générique sur le nom, et ce n'est pas une coquetterie : c'est ce qui fait
 * dire au compilateur qu'une entrée porte **sa** clé. Le type de retour se
 * souvient du nom passé, et le `satisfies` du registre ci-dessous exige que
 * chaque `altKey` soit celle de la propriété qui la porte — `barbier:
 * photo('soinVisage', …)` ne compile pas, là où un `PhotoName` nu l'aurait
 * laissé passer et fait annoncer la mauvaise scène au lecteur d'écran.
 */
function photo<N extends PhotoName>(
  name: N,
  file: string,
  width: number,
  height: number,
): Photo & { readonly altKey: N } {
  return { src: `/photos/${file}`, altKey: name, width, height };
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
  spaInterieur: photo('spaInterieur', 'spa-interieur.jpg', 1600, 1281),
  /** Un soin aux pierres chaudes, fleurs posées sur le dos. */
  soinPierresChaudes: photo('soinPierresChaudes', 'soin-pierres-chaudes.jpg', 1400, 933),
  /** Les mains d'un praticien sur un dos, en massage. */
  massageDos: photo('massageDos', 'massage-dos.jpg', 1100, 1650),
  /** Une coiffeuse au brushing, dans un salon lumineux. */
  coiffureBrushing: photo('coiffureBrushing', 'coiffure-brushing.jpg', 1100, 734),
  /** L'intérieur d'un salon de coiffure, postes alignés. */
  salonInterieur: photo('salonInterieur', 'salon-interieur.jpg', 1200, 800),
  /** Un soin du visage appliqué au pinceau. */
  soinVisage: photo('soinVisage', 'soin-visage.jpg', 1000, 667),
  /** Serviette roulée, flacon et fleurs — la table d'un soin. */
  natureMorteSpa: photo('natureMorteSpa', 'nature-morte-spa.jpg', 1000, 667),
  /** Un rasage chez le barbier. */
  barbier: photo('barbier', 'barbier.jpg', 1000, 667),
} as const satisfies { readonly [K in PhotoName]: Photo & { readonly altKey: K } };
