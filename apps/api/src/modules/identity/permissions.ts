import { PERMISSIONS, type Permission } from '@spa/shared';

import { USER_ROLES, type UserRole } from './roles';

/**
 * **La matrice de permissions — l'écriture unique de « qui a le droit de quoi »**
 * (#812, CDC §1.4 « comptes staff avec rôles et permissions »,
 * [ADR 0013](../../../../../docs/adr/0013-matrice-de-permissions-par-role.md)).
 *
 * ## Ce que ce fichier remplace, et pourquoi il a fallu le remplacer
 *
 * `roles.ts` le prévoyait, mot pour mot : « le jour où deux rôles cessent d'être
 * comparables, ce rang devient faux et il faut une vraie liste de permissions —
 * c'est une décision d'ADR, pas un ajout de ligne ». Le rang a cessé d'être vrai
 * au retour de test du PO du 16/09 : une praticienne connectée lisait le
 * planning de tout le salon, l'annuaire des comptes avec les adresses de ses
 * collègues, et les dix-sept fiches clientes avec leurs notes internes — parce
 * que `@AuthAtLeast('STAFF')` ouvre à `STAFF` tout ce que `STAFF` peut, et que
 * `STAFF` pouvait presque tout.
 *
 * Le rang n'était pas *trop bas*, il était **inapplicable** : ce qui sépare le
 * praticien du gérant n'est pas un cran de capacité mais un **ensemble
 * d'objets**. Les deux lisent des rendez-vous ; l'un les siens, l'autre ceux du
 * salon. Aucun entier n'ordonne cela, et c'est la définition de deux rôles non
 * comparables.
 *
 * ## Le rang survit, et ce n'est pas une contradiction
 *
 * `hasAtLeastRole` reste ce qui gouverne l'**administration des comptes** :
 * `MANAGER` corrige une fiche, `ADMIN` change un rôle, et ces deux-là sont bien
 * emboîtés. La matrice ci-dessous ne le nie pas, elle l'exprime — `admin` reçoit
 * tout ce que reçoit `manager`, et on peut le lire. Ce qu'elle ajoute est la
 * seule chose que le rang ne savait pas écrire : `staff` reçoit
 * `agenda:read:own` sans recevoir `agenda:read:all`, alors qu'il est **sous**
 * `manager` qui a les deux.
 *
 * ## Ce que la matrice ne décide pas
 *
 * L'appartenance à l'établissement. Elle ne la regarde même pas : le tenant
 * vient du jeton vérifié et borne déjà le client Prisma (tenant-isolation §2),
 * si bien qu'une permission accordée ici ne porte jamais au-delà du salon de son
 * porteur. C'est ce qui permet à la garde de permission de refuser en **403**
 * sans rien apprendre à personne : son refus porte sur la route, pas sur un
 * objet, exactement comme celui de `RolesGuard`.
 *
 * Le **403 de portée** (`OWN_SCOPE_ONLY`), lui, porte bien sur un objet — mais
 * sur un objet du même établissement, dont l'appelant connaît déjà l'existence.
 * Il est levé par les services, jamais par une garde, et la nuance est écrite
 * en tête d'`OWN_SCOPE_ONLY` dans le contrat.
 */

/**
 * Qui a quoi — **la table du premier critère de #812**.
 *
 * | Permission | `CLIENT` | `STAFF` | `MANAGER` | `ADMIN` | La raison de la case |
 * |---|:-:|:-:|:-:|:-:|---|
 * | `agenda:read:own` | | ✓ | ✓ | ✓ | Un praticien doit voir sa journée en arrivant (#811). Un manager qui donne des soins a aussi la sienne. |
 * | `agenda:read:all` | | | ✓ | ✓ | **Arbitrage du PO (16/09) : le praticien ne voit que son propre planning.** L'agenda du salon porte les noms des clientes de ses collègues. |
 * | `appointment:write:own` | | ✓ | ✓ | ✓ | Marquer honoré ou non présenté, noter, libérer un créneau : la conduite de sa propre journée, et elle n'attend pas un manager. |
 * | `appointment:write:all` | | | ✓ | ✓ | Poser un rendez-vous pour une cliente et un praticien qu'on désigne est un geste de comptoir, pas de fauteuil. |
 * | `customers:read:own` | | ✓ | ✓ | ✓ | Le praticien a besoin de la fiche de la personne qu'il va recevoir — allergie, préférence — et d'aucune autre. |
 * | `customers:read:all` | | | ✓ | ✓ | Le fichier entier, c'est dix-sept dossiers avec téléphone, e-mail et note interne (capture 3 du ticket). |
 * | `customers:write` | | | ✓ | ✓ | Créer, corriger, exporter, anonymiser : des décisions **sur** le fichier, pas des lectures dedans. |
 * | `accounts:read` | | | ✓ | ✓ | L'annuaire du salon expose l'adresse et le rôle de chaque compte, administratrice comprise (capture 2). |
 * | `accounts:write` | | | | ✓ | Inviter, changer un rôle, désactiver — le rang le plus élevé, inchangé depuis #55. |
 * | `checkout:collect` | | | ✓ | ✓ | L'écran d'encaissement liste la journée **de tout le salon** : c'est un agenda complet par une autre porte. |
 * | `reporting:read` | | | ✓ | ✓ | Le chiffre d'affaires de l'établissement — inchangé, les rapports étaient déjà au seuil `MANAGER`. |
 * | `settings:write` | | | | ✓ | Fuseau, horaires, mentions légales du ticket — inchangé, `GET /v1/tenant` était déjà au seuil `ADMIN`. |
 *
 * ## Ce que `CLIENT` n'a pas, et pourquoi la ligne est vide plutôt qu'absente
 *
 * Une cliente connectée est une identité de l'établissement comme une autre :
 * elle obtient un jeton, et rien n'empêche de le présenter à une route du
 * back-office. Sa ligne existe donc — vide — pour que la garde ait quelque chose
 * à lire plutôt qu'un `undefined` qu'un `?? []` distrait aurait pu retourner en
 * « aucune exigence ». Son propre périmètre passe par des routes qui ne
 * demandent aucune permission : `GET /auth/me`, `PATCH /users/me`,
 * `GET /appointments/mine`.
 */
const MATRIX: Readonly<Record<UserRole, readonly Permission[]>> = {
  CLIENT: [],
  STAFF: ['agenda:read:own', 'appointment:write:own', 'customers:read:own'],
  MANAGER: [
    'agenda:read:own',
    'agenda:read:all',
    'appointment:write:own',
    'appointment:write:all',
    'customers:read:own',
    'customers:read:all',
    'customers:write',
    'accounts:read',
    'checkout:collect',
    'reporting:read',
  ],
  ADMIN: [
    'agenda:read:own',
    'agenda:read:all',
    'appointment:write:own',
    'appointment:write:all',
    'customers:read:own',
    'customers:read:all',
    'customers:write',
    'accounts:read',
    'accounts:write',
    'checkout:collect',
    'reporting:read',
    'settings:write',
  ],
};

/**
 * La matrice, **rendue dans l'ordre du vocabulaire** et figée.
 *
 * L'ordre n'est pas cosmétique : la liste part sur le fil par `GET /auth/me`, et
 * deux réponses qui énuméreraient les mêmes droits dans deux ordres différents
 * produiraient des corps distincts pour un même état — de quoi faire échouer une
 * comparaison de recette pour une raison qui n'en est pas une.
 *
 * Le tri se fait **une fois**, au chargement du module, et non à chaque
 * requête : la matrice ne change pas d'un appel à l'autre.
 */
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> =
  Object.freeze(
    Object.fromEntries(
      USER_ROLES.map((role) => [
        role,
        Object.freeze(PERMISSIONS.filter((permission) => MATRIX[role].includes(permission))),
      ]),
    ) as Record<UserRole, readonly Permission[]>,
  );

/**
 * Les permissions effectives d'un rôle — ce que `GET /auth/me` émet.
 *
 * Rend un tableau gelé : l'appelant qui voudrait y ajouter quelque chose se
 * heurte à la matrice plutôt que de la modifier pour tout le processus.
 */
export function permissionsOf(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** `true` si le rôle porte cette permission. */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * `true` si le rôle porte **au moins une** des permissions exigées.
 *
 * « L'une d'elles » et non « toutes » : une route à double portée — le fichier
 * client se sert avec `customers:read:own` comme avec `customers:read:all` —
 * doit s'ouvrir aux deux, et c'est ensuite la portée retenue qui décide du
 * contenu de la réponse, pas de l'accès.
 */
export function roleHasAnyPermission(
  role: UserRole,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => roleHasPermission(role, permission));
}
