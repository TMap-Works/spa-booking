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
 * **Écart connu avec la base, à la date de ce ticket** : `enum UserRole` ne
 * compte que `CLIENT`, `STAFF` et `ADMIN` — `MANAGER` lui manque. Les quatre
 * rôles ci-dessous sont ceux qu'exige #22 (« Rôles client, staff, manager et
 * admin »), et le contrat les pose en premier, conformément à api-module §4 :
 * un changement de contrat commence par ce paquet, les erreurs de compilation
 * qui en découlent dans `apps/*` sont la liste de travail. #22 doit donc porter
 * la migration additive `ALTER TYPE "UserRole" ADD VALUE 'MANAGER'` avant de
 * persister un compte dans ce rôle : jusque-là, `manager` est un rôle que le
 * contrat sait nommer et que la base sait encore refuser.
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
