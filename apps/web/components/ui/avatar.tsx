export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
/** `square` pour le monogramme d'un salon, `circle` pour une personne. */
export type AvatarShape = 'circle' | 'square';
/** `brand` pose l'aplat de marque — l'identité du salon, jamais une action. */
export type AvatarTone = 'accent' | 'brand';

interface AvatarProps {
  /** Le nom dont on tire les initiales — « Yanis B. », « Spa Lumière ». */
  readonly name: string;
  readonly size?: AvatarSize;
  readonly shape?: AvatarShape;
  readonly tone?: AvatarTone;
  /**
   * Nom accessible, **seulement** quand l'avatar est seul. À côté d'un nom
   * écrit, il reste décoratif : un lecteur d'écran lirait sinon deux fois
   * « Yanis B. ».
   */
  readonly label?: string;
}

/**
 * Les initiales d'un nom : la première lettre du premier mot et celle du
 * dernier — « Jean-Pierre Martin » donne « JM », un prénom composé reste un mot.
 *
 * Les mots sans lettre (« & », « — ») sont ignorés, et la ponctuation d'une
 * initiale déjà abrégée (« B. ») tombe avec eux. Un nom vide rend « ? » plutôt
 * qu'une pastille muette.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/u)
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => letter !== undefined);

  const first = letters[0];
  if (first === undefined) {
    return '?';
  }
  const last = letters.length > 1 ? letters[letters.length - 1] : '';
  return `${first}${last}`.toLocaleUpperCase('fr-FR');
}

/**
 * Les classes d'une pastille, au format qu'`avatar.css` attend (#1079).
 *
 * Exporté parce qu'une pastille ne loge pas toujours des initiales : « Premier
 * disponible » n'est personne, et sa pastille porte un pictogramme
 * (`components/booking/staff-choice.tsx`). Cet appelant-là recopiait la chaîne à
 * la main faute de pouvoir la demander, et il aurait dérivé de toutes les autres
 * pastilles au premier renommage de classe.
 *
 * Les valeurs par défaut sont celles d'`Avatar` : les deux surfaces composent la
 * même chaîne pour les mêmes arguments, puisque c'est désormais la même
 * fonction.
 */
export function avatarClasses(
  size: AvatarSize = 'md',
  shape: AvatarShape = 'circle',
  tone: AvatarTone = 'accent',
): string {
  return `spa-avatar spa-avatar--${size} spa-avatar--${shape} spa-avatar--${tone}`;
}

/**
 * Pastille d'initiales (#1044) — un praticien, une cliente, le monogramme d'un
 * salon (BM-PRATICIEN-02, BM-VITRINE-06).
 *
 * Aucune photo n'existe encore dans le modèle de données : quand elle viendra,
 * c'est ici qu'elle se branchera, sans toucher aux appelants.
 */
export function Avatar({ name, size = 'md', shape = 'circle', tone = 'accent', label }: AvatarProps) {
  const classes = avatarClasses(size, shape, tone);

  if (label !== undefined) {
    return (
      <span className={classes} role="img" aria-label={label}>
        <span aria-hidden="true">{initialsOf(name)}</span>
      </span>
    );
  }

  return (
    <span className={classes} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
