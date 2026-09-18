import { hasAnyPermission, type Permission } from '@spa/shared';

import type { AdminNavEntry } from './navigation';

/**
 * Ce que **chaque entrée du sommaire exige**, en permissions — #812, cinquième
 * critère.
 *
 * ## Ce que ce fichier est, et ce qu'il n'est pas
 *
 * Ce n'est **pas** la matrice de permissions. Celle-là vit côté serveur
 * (`apps/api/src/modules/identity/permissions.ts`, [ADR
 * 0013](../../../../../../docs/adr/0013-matrice-de-permissions-par-role.md)) et
 * arrive ici par `GET /api/v1/auth/me` : le front lit la liste effective du
 * compte connecté, il ne rejoue pas la table des rôles. C'est exactement ce que
 * le critère demande, et ce qui évite la divergence qui a valu trois corrections
 * successives aux seuils de ce sommaire (#458, #480, #484).
 *
 * Ce fichier dit autre chose : **quelle permission chaque écran consomme**. C'est
 * une propriété de l'écran, pas du rôle — elle se lit sur l'`@AuthWith(...)` des
 * routes que la page appelle — et elle n'a nulle part ailleurs où vivre.
 *
 * ## Le rôle filtre encore, et il ne protège toujours rien
 *
 * `adminNavigation` écarte déjà les entrées au-dessus du rang de l'appelant. Ce
 * filtre-ci s'applique **après**, sur ce qui reste, et pour les cas que le rang
 * ne sait pas exprimer — un praticien est bien au rang `staff`, mais il n'a plus
 * ni le planning du salon ni l'encaissement.
 *
 * Comme le rang, c'est du **confort** : la seule frontière est la garde de l'API,
 * qu'aucun front ne peut contourner. Un sommaire qui se tromperait afficherait
 * une entrée de trop ; il n'ouvrirait aucune donnée.
 */

/**
 * Les permissions qu'une entrée exige — « l'une d'elles » suffit, comme côté
 * serveur.
 *
 * Une entrée **absente** de cette table n'exige rien de particulier : son rang
 * suffit. C'est le cas de « Prestations », dont les lectures
 * (`GET /v1/services`) n'ont pas changé de garde.
 */
const ENTRY_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  // `GET /v1/appointments` — l'agenda du salon, fermé au praticien depuis #812.
  // Le sien passe par l'espace praticien, qui n'est pas une entrée de ce
  // sommaire.
  'tableau-de-bord': ['reporting:read'],
  planning: ['agenda:read:all'],
  // `GET /v1/customers` — l'écran s'ouvre aux deux portées, et c'est l'API qui
  // borne ensuite la liste à la clientèle de l'appelant.
  clients: ['customers:read:own', 'customers:read:all'],
  // `GET /v1/users` et la fiche praticien — l'annuaire des comptes.
  personnel: ['accounts:read'],
  // `POST /v1/payments/cash`, `GET /v1/sales` — et l'écran liste la journée de
  // tout le salon, ce qui est la raison même de sa fermeture.
  encaissement: ['checkout:collect'],
  // `GET /v1/reports/*` — inchangé, ces routes étaient déjà au rang gérant.
  reporting: ['reporting:read'],
  // `GET /v1/tenant` — inchangé, déjà au rang administrateur.
  reglages: ['settings:write'],
  // `GET /v1/billing/subscription` — la même permission que les réglages.
  abonnement: ['settings:write'],
};

/**
 * Le sommaire, réduit à ce que les permissions du compte ouvrent réellement.
 *
 * `permissions === null` se lit « le serveur n'a pas dit » — `/auth/me` n'a pas
 * répondu, ou sert une version d'API antérieure à #812 : le sommaire reste alors
 * celui que le rang produit, sans filtre supplémentaire. Le repli est donc le
 * comportement d'avant plutôt qu'un sommaire vide : un rail effacé sur une panne
 * de lecture ferait croire à une session dégradée, là où un rail trop large ne
 * fait que proposer un écran qui répondra 403.
 */
export function entriesAllowedBy(
  entries: readonly AdminNavEntry[],
  permissions: readonly Permission[] | null,
): readonly AdminNavEntry[] {
  if (permissions === null) {
    return entries;
  }

  return entries.filter((entry) => {
    const required = ENTRY_PERMISSIONS[entry.key];

    return required === undefined || hasAnyPermission(permissions, required);
  });
}
