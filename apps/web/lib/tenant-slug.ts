/**
 * Le slug de l'établissement, lu depuis le chemin de l'URL courante (#703).
 *
 * ## Pourquoi ce module existe
 *
 * Une frontière `not-found` ne reçoit **aucune prop** — ni `params`, ni
 * `searchParams` : c'est une limite de l'App Router, pas un oubli. Or ces écrans
 * ont besoin du slug de l'établissement pour offrir un chemin de retour. Le seul
 * accès qui y mène est `usePathname()`, d'où un Client Component pour trois
 * lignes de balisage, et d'où cette lecture.
 *
 * Elle était écrite **trois fois, caractère pour caractère** — dans la frontière
 * du report de rendez-vous (#627), dans celle de la fiche praticien (#696) et
 * dans celle de la fiche prestation (#697) —, et toute frontière future en
 * aurait écrit une quatrième copie. Les deux gardes ci-dessous auraient alors
 * divergé à la première correction, chacune dans son coin, sans que rien ne le
 * signale. Les trois frontières sont branchées ici : les deux premières par
 * #703, la dernière par #710. Ce module est le seul endroit où cette lecture
 * doit vivre.
 *
 * ## Ce que la fonction rend
 *
 * Le premier segment du chemin, **décodé**. Le décodage n'est pas redondant :
 * `usePathname()` rend le chemin encodé — Next le tire de
 * `new URL(canonicalUrl).pathname` — tandis que les constructeurs de chemins
 * (`adminPath`, `accountPath`) réencodent ce qu'on leur donne. Sans ce passage,
 * un slug déjà encodé le serait une seconde fois et le lien de retour pointerait
 * à côté.
 */

/**
 * Le slug de l'établissement porté par `pathname`, ou `null` s'il n'y en a pas
 * de lisible.
 *
 * Deux gardes, et ni l'une ni l'autre n'est décorative :
 *
 * 1. **Premier segment absent → `null`, jamais une chaîne vide.** Une chaîne
 *    vide passée à un constructeur de chemin donnerait `//admin/...` ou
 *    `//compte`, que le navigateur lit comme une URL **absolue** vers l'hôte
 *    `admin` ou `compte` : la seule issue de l'écran sortirait du site.
 * 2. **`decodeURIComponent` est enveloppé.** Un échappement tronqué — `/salon%/…`
 *    — lève `URIError`. Non rattrapée dans une frontière `not-found`, l'exception
 *    remplacerait le 404 par la frontière d'erreur, c'est-à-dire précisément
 *    l'écran dont #627, #696 et #697 cherchaient à sortir.
 *
 * L'appelant décide quoi faire de `null` ; les trois frontières taisent leur lien
 * plutôt que d'en fabriquer un au hasard — même arbitrage que
 * `readApiSessionCookie` dans `lib/api-client.ts`.
 */
export function tenantSlugFromPathname(pathname: string): string | null {
  return pathSegment(pathname, 1);
}

/**
 * Le `rank`-ième segment de `pathname`, **décodé**, ou `null` s'il n'y en a pas
 * de lisible — `1` étant le premier, celui du slug.
 *
 * C'est la lecture ci-dessus, rendue à son rang : #1326 en avait besoin du
 * **second** segment — `admin` de `/maison-lotus/admin/flux`, par quoi le
 * middleware dit de quel côté de l'établissement la page se trouve —, et
 * recopier les deux gardes dans `middleware.ts` aurait rouvert exactement la
 * divergence que l'en-tête de ce module raconte : elles auraient alors été
 * corrigées chacune dans son coin, sans que rien ne le signale.
 *
 * Les deux gardes sont donc ici, une fois, et valent pour tout rang.
 */
export function pathSegment(pathname: string, rank: number): string | null {
  const encoded = pathname.split('/')[rank] ?? '';

  if (encoded === '') {
    return null;
  }

  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
