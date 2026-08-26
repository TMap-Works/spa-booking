/**
 * Vocabulaire des rôles et hiérarchie d'autorisation — CDC §1.4 « comptes staff
 * avec rôles et permissions », §2.4 « Compte (client / staff / admin) + rôle ».
 *
 * ## Un seul vocabulaire, depuis #202
 *
 * Cette liste est à la fois ce que la **couche d'autorisation** sait nommer et
 * ce que la **colonne** sait écrire. Les deux ont divergé le temps d'un ticket :
 * #201 a livré la hiérarchie `STAFF` < `MANAGER` < `ADMIN` dans la garde alors
 * que `enum UserRole` ne comptait que trois libellés, et le module portait
 * jusqu'ici deux listes — `USER_ROLES` et un `PERSISTABLE_USER_ROLES` amputé de
 * `MANAGER` — pour que le DTO refuse en 400 un rôle qui aurait sinon produit une
 * erreur Prisma en 500. La migration additive
 * `20260826100000_add_manager_user_role` a refermé l'écart, et cette seconde
 * liste a disparu avec lui : un prédicat « stockable ? » qui rend toujours vrai
 * ne protège rien et fait croire à une frontière qui n'existe plus.
 *
 * Ce qui reste de ce garde-fou, c'est le **témoin** : `roles.spec.ts` compare
 * cette liste à l'énumération réellement générée par Prisma, dans l'ordre. Un
 * cinquième rôle ajouté ici sans sa migration y rougit immédiatement, avant
 * qu'une écriture ne le découvre en production.
 *
 * Ce témoin est dans la suite de test et non dans ce fichier, délibérément :
 * `roles.ts` est importé par la garde, donc par tous les contrôleurs de tous les
 * modules. Y lire `@prisma/client` **comme valeur** ferait du client généré une
 * dépendance d'exécution de la couche d'autorisation, là où api-module §2
 * réserve cet import au repository — et une machine sans `prisma generate`
 * verrait échouer toutes les suites qui touchent la garde ou les jetons, au lieu
 * de la seule qui parle du schéma.
 *
 * ## L'ordre de cette liste est celui de la colonne
 *
 * PostgreSQL ordonne un `enum` par son ordre de **déclaration**, et c'est cet
 * ordre que rend le `orderBy: { role: 'asc' }` de `listStaffAccounts`. Les deux
 * ordres doivent donc coïncider, faute de quoi la liste du personnel sortirait
 * dans un ordre qui contredit la hiérarchie. C'est pourquoi la migration insère
 * `MANAGER` *avant* `ADMIN` plutôt qu'en queue d'énumération, et pourquoi
 * `roles.spec.ts` verrouille la concordance dans les deux sens.
 *
 * ## Pourquoi un rang et non une matrice de permissions
 *
 * Les quatre rôles du MVP sont strictement emboîtés : un `ADMIN` peut tout ce
 * que peut un `MANAGER`, qui peut tout ce que peut un `STAFF`. Un rang numérique
 * suffit donc à exprimer « au moins ce rôle ». Le jour où deux rôles cessent
 * d'être comparables — un comptable qui voit le chiffre d'affaires mais aucun
 * agenda — ce rang devient faux et il faut une vraie liste de permissions :
 * c'est une décision d'ADR, pas un ajout de ligne.
 *
 * ## Majuscules ici, minuscules dans le contrat
 *
 * Le stockage PostgreSQL et les revendications de jeton émises par #21 utilisent
 * les libellés en majuscules ; `@spa/shared` expose les mêmes rôles en
 * minuscules. La traduction appartiendra au jour où `apps/api` dépendra du
 * paquet partagé — ce qui touche `apps/api/package.json`, hors périmètre de ce
 * ticket. Changer la casse des revendications maintenant invaliderait par
 * ailleurs tous les jetons en circulation.
 */

/**
 * Les quatre rôles, du moins au plus capable — et dans l'ordre de déclaration de
 * `enum UserRole`.
 */
export const USER_ROLES = ['CLIENT', 'STAFF', 'MANAGER', 'ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Rang d'inclusion — l'ordre de `USER_ROLES`, rendu comparable.
 *
 * Dérivé de la liste plutôt que réécrit : deux sources qui divergeraient d'un
 * cran donneraient une garde qui autorise le rôle en dessous de celui annoncé.
 */
export const USER_ROLE_RANK: Readonly<Record<UserRole, number>> = Object.fromEntries(
  USER_ROLES.map((role, index) => [role, index]),
) as Record<UserRole, number>;

/**
 * Rôles internes à l'établissement, par opposition au rôle `CLIENT`.
 *
 * C'est la définition de « compte staff » du CDC §1.4, la liste que
 * `GET /api/v1/users` renvoie, et celle qu'un `WHERE role IN (…)` cite. À ce
 * dernier titre elle est **contrainte par la colonne** : PostgreSQL rejette une
 * comparaison à un libellé absent de l'énumération, et un rôle cité ici sans sa
 * migration ferait échouer la requête — `invalid input value for enum
 * "UserRole"` — sur la totalité des tenants, pas seulement à l'écriture. Le
 * `satisfies` interdit d'y écrire un rôle inconnu de l'autorisation ;
 * `roles.spec.ts` interdit d'y écrire un rôle inconnu de la base.
 */
export const STAFF_ROLES = ['STAFF', 'MANAGER', 'ADMIN'] as const satisfies readonly UserRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/** `true` si la valeur est l'un des rôles connus — à utiliser avant tout transtypage. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** `true` si `role` est un rôle interne à l'établissement — tout sauf `CLIENT`. */
export function isStaffRole(role: UserRole): role is StaffRole {
  return role !== 'CLIENT';
}

/** `true` si `role` est au moins aussi capable que `minimum`. */
export function hasAtLeastRole(role: UserRole, minimum: UserRole): boolean {
  return USER_ROLE_RANK[role] >= USER_ROLE_RANK[minimum];
}

/**
 * Les rôles au moins aussi capables que `minimum`, dans l'ordre du rang.
 *
 * C'est ce qui rend `@AuthAtLeast('STAFF')` équivalent à une énumération
 * explicite : la garde ne compare que des appartenances à une liste, et la
 * hiérarchie est résolue **une fois**, à la déclaration de la route, plutôt qu'à
 * chaque requête.
 */
export function rolesAtLeast(minimum: UserRole): readonly UserRole[] {
  return USER_ROLES.filter((role) => hasAtLeastRole(role, minimum));
}
