/** Une origine factice : elle ne sert qu'à résoudre un chemin, jamais émise. */
const SITE_ORIGIN = 'http://site.invalid';

/**
 * Ramène un chemin reçu à sa forme **normalisée et encodée**, ou rend `null`
 * s'il ne désigne pas un chemin de ce site (#856).
 *
 * ## Normaliser d'abord, juger ensuite
 *
 * Une destination de retour se valide sur ce qu'elle **deviendra**, pas sur ce
 * qu'elle affiche. `/slug/admin/../..//exemple.test` commence par le bon
 * préfixe, et le parseur d'URL la résout pourtant en `//exemple.test` : une URL
 * protocole-relative, c'est-à-dire un autre domaine dès qu'on l'écrit dans un
 * `Location`. Le parseur résout les `..` (y compris `%2e%2e`), change les `\` en
 * `/` et encode ce qui doit l'être — un caractère hors Latin-1 ou un retour à la
 * ligne, qu'un en-tête HTTP refuserait. C'est donc son résultat qu'on juge, et
 * c'est lui qu'on rend.
 *
 * Module sans dépendance à Next : `paths.ts` l'importe, et `paths.ts` est lu par
 * des composants clients.
 */
export function sitePath(candidate: string): string | null {
  if (!candidate.startsWith('/')) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate, SITE_ORIGIN);
  } catch {
    return null;
  }

  // `//exemple.test` et `/\exemple.test` changent d'origine dès l'analyse ; un
  // chemin qui ne s'y ramène qu'après résolution des `..` garde l'origine, mais
  // commence par deux barres — les deux cas sont refusés.
  if (url.origin !== SITE_ORIGIN || url.pathname.startsWith('//')) {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
