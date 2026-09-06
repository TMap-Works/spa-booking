import { runWithTenant } from '../../src/common/tenant/tenant-context';

/**
 * Le détour que **toute** suite exerçant le client scopé doit prendre — écrit
 * une fois, ici, plutôt que recopié dans chaque fichier qui en a besoin.
 *
 * ## Pourquoi il existe
 *
 * Ce n'est pas une commodité : sans lui, une suite entière passe ou échoue pour
 * de mauvaises raisons. `runWithTenant` s'appuie sur `AsyncLocalStorage`, dont
 * la portée se referme dès que la fonction rend la main — or une opération
 * Prisma est une **promesse paresseuse** : rien n'est exécuté à sa
 * construction, tout l'est au premier `.then()`. Écrire
 *
 * ```ts
 * runWithTenant(autreTenant, () => scoped.user.findUnique({ where: { id } }))
 * ```
 *
 * construit donc la promesse dans la portée et l'exécute **dehors** :
 * l'extension de scoping n'y trouve aucun tenant et lève
 * `MissingTenantContextError`. Le test rougit là où il devrait prouver un
 * filtrage — ou, pire pour un test qui attend justement cette erreur, il verdit
 * sans avoir rien exercé.
 *
 * En attendant à l'intérieur, la continuation est planifiée dans la portée, et
 * `AsyncLocalStorage` la lui restitue. C'est exactement ce que fait le code de
 * production : `TenantScopeMiddleware` ouvre la portée sur une fonction `async`,
 * et un repository `await` toujours dans la sienne.
 *
 * ## Pourquoi il est partagé
 *
 * La subtilité tient à un seul `await`, et rien dans le corps de la fonction ne
 * dit qu'il est porteur. Trois copies, c'est trois occasions de « simplifier »
 * l'une en `runWithTenant(id, fn)` — après quoi la suite concernée verdit sans
 * plus rien exercer, silencieusement. Une seule définition rend la correction,
 * comme la régression, visible d'un endroit.
 */
export async function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, async () => {
    const result = await fn();
    return result;
  });
}
