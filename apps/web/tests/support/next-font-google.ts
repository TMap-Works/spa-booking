/**
 * Doublure de `next/font/google` pour vitest : hors du compilateur Next, la
 * fonction de police n'existe pas. Elle rend ici la même forme qu'au build —
 * une classe et une variable CSS — sans rien télécharger.
 */
interface FontOptions {
  readonly variable?: string;
}

function font(options: FontOptions = {}) {
  return {
    className: 'font-test',
    variable: options.variable === undefined ? '' : 'font-test-variable',
    style: { fontFamily: 'sans-serif' },
  };
}

export const Inter = font;
