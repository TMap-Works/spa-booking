/**
 * Rôles de compte — CDC §1.4 « comptes staff avec rôles et permissions », #22.
 *
 * Cette énumération est **stable** : ses valeurs voyagent dans les claims des
 * jetons d'accès (#21), dans les réponses de l'API et dans les conditions
 * d'affichage du front. En changer une n'est pas un refactor, c'est une
 * migration de données doublée d'une invalidation de tous les jetons en
 * circulation.
 *
 * Les valeurs sont en minuscules, comme toutes les énumérations de ce contrat.
 * Le stockage PostgreSQL utilise, lui, des libellés en majuscules
 * (`enum UserRole` de `apps/api/prisma/schema.prisma`) : la conversion est la
 * responsabilité de la couche repository, qui est déjà la seule à connaître le
 * schéma (api-module §2). Rien de ce fichier ne doit dépendre de Prisma.
 *
 * **Les quatre rôles existent des deux côtés.** Ils sont ceux qu'exige #22
 * (« Rôles client, staff, manager et admin »), et le contrat les a posés en
 * premier, conformément à api-module §4 : un changement de contrat commence par
 * ce paquet, les erreurs de compilation qui en découlent dans `apps/*` sont la
 * liste de travail. `enum UserRole` a longtemps compté un libellé de moins ;
 * la migration additive `20260826100000_add_manager_user_role` a refermé cet
 * écart (#202), et `manager` est depuis un rôle que le contrat nomme *et* que la
 * base stocke.
 *
 * **L'ordre de cette liste est celui de la colonne**, et pas seulement son
 * contenu. PostgreSQL ordonne un `enum` par son ordre de déclaration, et c'est
 * lui que rend un `orderBy` sur le rôle : la migration insère donc `MANAGER`
 * *avant* `ADMIN` plutôt qu'en queue d'énumération, pour que le tri de la base
 * suive la hiérarchie de `USER_ROLE_RANK`.
 *
 * **Deux témoins, et aucun ne couvre l'autre.** `apps/api` ne dépend pas encore
 * de ce paquet : il porte sa propre liste, en majuscules
 * (`apps/api/src/modules/identity/roles.ts`), et c'est elle — pas celle-ci — que
 * `apps/api/src/modules/identity/__tests__/roles.spec.ts` compare à
 * l'énumération générée par Prisma, contenu **et** ordre, avant de relire le SQL
 * appliqué pour vérifier le voisinage `MANAGER` / `ADMIN` que le client généré ne
 * peut pas trahir. De ce côté-ci, seul `__tests__/constants.spec.ts` fige le
 * contenu et l'ordre de la liste ci-dessous ; rien ne les confronte
 * automatiquement au schéma. Un cinquième rôle ajouté ici se propage donc à la
 * main : cette liste, celle d'`apps/api`, puis la migration additive — et c'est
 * la suite d'`apps/api` qui rougit s'il manque la dernière. Le jour où `apps/api`
 * importera `@spa/shared`, les deux listes n'en feront plus qu'une et le témoin
 * vaudra pour les deux.
 */

export const USER_ROLES = ['client', 'staff', 'manager', 'admin'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Ordre d'inclusion des rôles, du moins au plus capable.
 *
 * Le MVP n'a pas de matrice de permissions : ses quatre rôles sont strictement
 * emboîtés — un `admin` peut tout ce que peut un `manager`, qui peut tout ce
 * que peut un `staff`. Un rang numérique suffit donc à exprimer « au moins ce
 * rôle », et c'est ce que consommera la garde déclarative de #22.
 *
 * Le jour où deux rôles cessent d'être comparables (un comptable qui voit le
 * chiffre d'affaires mais aucun agenda), ce rang devient faux et il faut une
 * vraie liste de permissions — c'est une décision d'ADR, pas un ajout de ligne.
 */
export const USER_ROLE_RANK: Readonly<Record<UserRole, number>> = {
  client: 0,
  staff: 1,
  manager: 2,
  admin: 3,
};

/**
 * Rôles internes à l'établissement, par opposition au rôle `client`.
 *
 * Sert au partage du tableau de bord admin : un `client` authentifié n'y entre
 * pas, quel que soit son tenant.
 */
export const STAFF_ROLES = ['staff', 'manager', 'admin'] as const satisfies readonly UserRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/** `true` si `value` est un rôle connu — à utiliser avant tout transtypage. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** `true` si `role` est au moins aussi capable que `minimum`. */
export function hasAtLeastRole(role: UserRole, minimum: UserRole): boolean {
  return USER_ROLE_RANK[role] >= USER_ROLE_RANK[minimum];
}

/** `true` si `role` est un rôle interne à l'établissement (tout sauf `client`). */
export function isStaffRole(role: UserRole): role is StaffRole {
  return role !== 'client';
}
