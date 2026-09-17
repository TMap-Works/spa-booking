/**
 * Permissions nommées — CDC §1.4 « comptes staff avec **rôles et permissions** »,
 * #812, [ADR 0013](../../../../docs/adr/0013-matrice-de-permissions-par-role.md).
 *
 * ## Pourquoi cette liste existe, alors que le rang suffisait
 *
 * Jusqu'à #812, l'autorisation du produit tenait dans un rang : `staff` <
 * `manager` < `admin`, et `@AuthAtLeast('STAFF')` ouvrait à un praticien tout ce
 * qu'un rang au-dessus pouvait faire. `USER_ROLE_RANK` le disait déjà :
 * « le jour où deux rôles cessent d'être comparables, ce rang devient faux et il
 * faut une vraie liste de permissions — c'est une décision d'ADR ».
 *
 * Ce jour est arrivé par le haut et non par le bas : le praticien ne fait pas
 * *moins* que le gérant sur les mêmes objets, il fait **la même chose sur un
 * autre ensemble d'objets** — les siens. `agenda:read:own` et `agenda:read:all`
 * ne sont pas deux crans d'une même échelle, et aucun entier ne les ordonne.
 *
 * ## Ce que cette liste est, et ce qu'elle n'est pas
 *
 * C'est le **vocabulaire**, pas la matrice. Qui a quoi est décidé côté serveur
 * (`apps/api/src/modules/identity/permissions.ts`) et servi au front par
 * `GET /api/v1/auth/me`. Le front ne recopie donc aucune table de rôles : il lit
 * la liste effective du compte connecté et s'y conforme. Une matrice recopiée
 * dans `apps/web` aurait divergé au premier ticket — c'est exactement ce qui
 * s'était produit sur les seuils du sommaire du back-office (#458, #480, #484).
 *
 * ## Le suffixe `:own` / `:all`, et pourquoi il est dans le nom
 *
 * Parce que la portée est une permission distincte, pas un paramètre. Une route
 * qui accepterait `agenda:read` puis déciderait de la portée d'après le rôle
 * aurait remis la matrice là où on vient de la retirer. Ici, la garde ne juge
 * que l'appartenance à la liste, et la portée se lit dans le nom qu'elle a
 * trouvé.
 *
 * ## Stabilité
 *
 * Ces chaînes voyagent dans les réponses de `GET /auth/me` et dans les
 * conditions d'affichage du back-office. En renommer une est un changement de
 * contrat, pas un refactor.
 */

export const PERMISSIONS = [
  /** Lire son propre agenda — `GET /api/v1/me/appointments` (#811). */
  'agenda:read:own',
  /** Lire l'agenda de tout l'établissement — `GET /api/v1/appointments`. */
  'agenda:read:all',
  /** Agir sur ses propres rendez-vous : statut, report, annulation. */
  'appointment:write:own',
  /** Agir sur n'importe quel rendez-vous de l'établissement, et en poser. */
  'appointment:write:all',
  /** Lire les fiches des clientes de ses propres rendez-vous, et elles seules. */
  'customers:read:own',
  /** Lire le fichier client entier de l'établissement. */
  'customers:read:all',
  /** Créer et modifier une fiche cliente, l'exporter, l'anonymiser. */
  'customers:write',
  /** Lire l'annuaire des comptes du salon — `GET /api/v1/users`. */
  'accounts:read',
  /** Administrer les comptes du salon : inviter, changer un rôle, désactiver. */
  'accounts:write',
  /** Encaisser au comptoir : tickets, règlements, remboursements. */
  'checkout:collect',
  /** Lire les indicateurs de l'établissement. */
  'reporting:read',
  /** Configurer l'établissement : fuseau, horaires, mentions de ticket. */
  'settings:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

/** `true` si la valeur est l'une des permissions connues — avant tout transtypage. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && KNOWN_PERMISSIONS.has(value);
}

/**
 * `true` si `granted` contient **au moins une** des permissions exigées.
 *
 * La sémantique est « l'une d'elles » et non « toutes », et c'est ce que les
 * routes à double portée réclament : `GET /api/v1/customers` se sert aussi bien
 * avec `customers:read:own` qu'avec `customers:read:all`, et c'est la portée
 * retenue — pas l'accès — qui change ensuite le contenu de la réponse.
 *
 * Écrit ici plutôt que dans chaque appelant : la garde du serveur et le sommaire
 * du back-office posent la même question, et deux réponses écrites séparément
 * finissent par différer.
 */
export function hasAnyPermission(
  granted: readonly Permission[],
  required: readonly Permission[],
): boolean {
  return required.some((permission) => granted.includes(permission));
}
