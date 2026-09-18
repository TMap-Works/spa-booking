/**
 * Les initiales d'un nom, pour les pastilles d'avatar du back-office :
 * « Spa Lumière » → « SL », « Adèle A. » → « AA », « Claire » → « C ».
 *
 * Toujours décoratives : l'avatar accompagne le nom écrit, il ne le remplace
 * jamais, et se pose donc avec `aria-hidden`.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/[\s.\-']+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.slice(0, 2).join('') || '·';
}
