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
 * signale.
 *
 * **Deux des trois sont branchées ici** : #703 a été écrite quand il n'y en
 * avait que deux, et la troisième (#697) est arrivée entre-temps, dans un
 * segment que ce ticket n'a pas ouvert — la migrer aurait fait sortir le diff de
 * son empreinte pendant qu'un lot de tickets tourne sur le dépôt, exactement ce
 * qui avait déjà fait annuler la correction une première fois. Elle suit dans
 * son propre ticket ; ce module est le seul endroit où cette lecture doit finir.
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
 *    l'écran dont #627 et #696 cherchaient à sortir.
 *
 * L'appelant décide quoi faire de `null` ; les deux frontières taisent leur lien
 * plutôt que d'en fabriquer un au hasard — même arbitrage que
 * `readApiSessionCookie` dans `lib/api-client.ts`.
 */
export function tenantSlugFromPathname(pathname: string): string | null {
  const [, encodedSlug = ''] = pathname.split('/');

  if (encodedSlug === '') {
    return null;
  }

  try {
    return decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
}
