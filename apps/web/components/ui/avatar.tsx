export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  /** Le nom dont on tire les initiales — « Yanis B. », « Spa Lumière ». */
  readonly name: string;
  readonly size?: AvatarSize;
  /** `square` pour le monogramme d'un salon, `circle` pour une personne. */
  readonly shape?: 'circle' | 'square';
  /** `brand` pose l'aplat de marque — l'identité du salon, jamais une action. */
  readonly tone?: 'accent' | 'brand';
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
 * Pastille d'initiales (#1044) — un praticien, une cliente, le monogramme d'un
 * salon (BM-PRATICIEN-02, BM-VITRINE-06).
 *
 * Aucune photo n'existe encore dans le modèle de données : quand elle viendra,
 * c'est ici qu'elle se branchera, sans toucher aux appelants.
 */
export function Avatar({ name, size = 'md', shape = 'circle', tone = 'accent', label }: AvatarProps) {
  const classes = `spa-avatar spa-avatar--${size} spa-avatar--${shape} spa-avatar--${tone}`;

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
