/**
 * Vocabulaire des rôles et hiérarchie d'autorisation — CDC §1.4 « comptes staff
 * avec rôles et permissions », §2.4 « Compte (client / staff / admin) + rôle ».
 *
 * ## Deux vocabulaires, et c'est délibéré
 *
 * `USER_ROLES` est ce que la **couche d'autorisation** sait nommer : les quatre
 * rôles qu'exige #22. `PERSISTABLE_USER_ROLES` est ce que la **base** sait
 * écrire : `enum UserRole` de `apps/api/prisma/schema.prisma` n'en compte que
 * trois — `MANAGER` lui manque, et l'ajouter demande un `ALTER TYPE`.
 *
 * Les deux listes cohabitent au lieu de se confondre parce que la garde et la
 * colonne ne répondent pas à la même question. La garde décide « ce porteur
 * a-t-il le rang requis » : elle n'écrit rien, elle peut donc connaître un rang
 * que la colonne refuse. La colonne, elle, doit rester la vérité de ce qui est
 * stockable — un DTO qui accepterait `MANAGER` produirait une erreur Prisma en
 * 500 là où le contrat doit répondre 400.
 *
 * `MANAGER` est donc, à la date de ce ticket, **un rôle que l'autorisation sait
 * nommer et que la base sait encore refuser** — exactement ce qu'annonce le
 * contrat partagé (`packages/shared/src/constants/roles.ts`). La migration
 * additive `ALTER TYPE "UserRole" ADD VALUE 'MANAGER'` n'est pas portée ici :
 * `apps/api/prisma/**` est hors du périmètre de fichiers de #22. Le jour où elle
 * arrivera, `roles.spec.ts` rougira — c'est **lui** qui importe l'énumération
 * générée par Prisma et la compare à cette liste — et la correction tiendra en
 * une ligne : déplacer `MANAGER` dans `PERSISTABLE_USER_ROLES`.
 *
 * Le témoin est dans la suite de test et non dans ce fichier, délibérément :
 * `roles.ts` est importé par la garde, donc par tous les contrôleurs de tous les
 * modules. Y lire `@prisma/client` **comme valeur** ferait du client généré une
 * dépendance d'exécution de la couche d'autorisation, là où api-module §2
 * réserve cet import au repository — et une machine sans `prisma generate`
 * verrait échouer toutes les suites qui touchent la garde ou les jetons, au lieu
 * de la seule qui parle du schéma.
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

/** Les quatre rôles que l'autorisation sait nommer, du moins au plus capable. */
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
 * Les rôles que `enum UserRole` de PostgreSQL accepte aujourd'hui.
 *
 * `satisfies readonly UserRole[]` garantit qu'aucune valeur d'ici n'échappe au
 * vocabulaire d'autorisation ; la réciproque — que Prisma ne connaisse rien de
 * plus — est vérifiée à l'exécution par `roles.spec.ts`, seul endroit où
 * l'énumération générée est comparable à cette liste.
 */
export const PERSISTABLE_USER_ROLES = [
  'CLIENT',
  'STAFF',
  'ADMIN',
] as const satisfies readonly UserRole[];

export type PersistableUserRole = (typeof PERSISTABLE_USER_ROLES)[number];

/**
 * Rôles internes à l'établissement, par opposition au rôle `CLIENT`.
 *
 * C'est la définition de « compte staff » du CDC §1.4, et la liste que
 * `GET /api/v1/users` renvoie.
 */
export const STAFF_ROLES = ['STAFF', 'MANAGER', 'ADMIN'] as const satisfies readonly UserRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/** `true` si la valeur est l'un des rôles connus — à utiliser avant tout transtypage. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** `true` si le rôle est aujourd'hui stockable en base. */
export function isPersistableUserRole(role: UserRole): role is PersistableUserRole {
  return (PERSISTABLE_USER_ROLES as readonly UserRole[]).includes(role);
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

/**
 * Les rôles internes que la base sait **aujourd'hui** écrire, donc les seuls
 * qu'un `WHERE role IN (…)` puisse citer.
 *
 * Dérivé et non recopié, et c'est la seule forme sûre : PostgreSQL rejette une
 * comparaison à un libellé absent de l'énumération. Une liste écrite à la main
 * qui contiendrait `MANAGER` ferait échouer la requête — `invalid input value
 * for enum "UserRole"` — sur la totalité des tenants, jusqu'à ce que la
 * migration passe. Le jour où elle passera, `MANAGER` entrera ici tout seul.
 *
 * Le filtrage part de `PERSISTABLE_USER_ROLES` et non de `STAFF_ROLES`, et
 * l'ordre des deux n'est pas indifférent. Filtrer les rôles internes par
 * « stockable ? » donne le bon tableau **à l'exécution**, mais un type que
 * TypeScript ne sait pas rétrécir : le prédicat de garde annonce un ensemble qui
 * n'est pas un sous-ensemble de celui d'entrée, l'inférence retombe alors sur le
 * type d'entrée, et `MANAGER` reste dans le type. Prisma refuse ce tableau —
 * c'est ce qui l'a fait voir — mais le vrai danger était ailleurs : un type qui
 * contient un libellé que la valeur ne contiendra jamais dit exactement
 * l'inverse de ce que ce fichier promet. Filtrer les rôles stockables par
 * « interne ? » rend le type juste sans un seul transtypage.
 */
export const PERSISTABLE_STAFF_ROLES: readonly PersistableUserRole[] =
  PERSISTABLE_USER_ROLES.filter((role) => isStaffRole(role));
