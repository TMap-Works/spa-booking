/**
 * Les chemins de l'écran du personnel (#53).
 *
 * Écrits ici plutôt qu'ajoutés à `../paths.ts` : ce module-là est partagé par
 * tout le back-office et une autre branche du jalon le réécrit en ce moment
 * même. Deux fichiers qui grandissent chacun de leur côté fusionnent ; un seul
 * que deux branches allongent au même endroit, non. La discipline reste la même
 * — **aucun composant ne concatène d'URL** —, et la racine vient d'un seul
 * endroit, `adminPath`.
 */

import { adminPath } from '../paths';

/** Le personnel : liste des comptes et des fiches praticien. */
export function adminStaffPath(tenantSlug: string): string {
  return `${adminPath(tenantSlug)}/personnel`;
}

/**
 * La fiche d'un praticien — horaires, absences, prestations pratiquées.
 *
 * L'identifiant est celui de la **fiche**, pas du compte : c'est lui qu'attendent
 * `PUT /v1/staff/{id}/schedule` et `POST /v1/services/{id}/staff`, et les
 * confondre est exactement ce qui rendait la première affectation impossible.
 *
 * Il est encodé bien qu'il vienne d'une réponse d'API et non d'une saisie : un
 * chemin se construit toujours de la même façon, sans exception qu'il faudrait
 * ensuite se rappeler.
 */
export function adminStaffMemberPath(tenantSlug: string, staffId: string): string {
  return `${adminStaffPath(tenantSlug)}/${encodeURIComponent(staffId)}`;
}

/*
 * Les deux gestes de l'écran, et pourquoi ils ont chacun une adresse (#766).
 *
 * L'audit de conception a relevé que /personnel n'offrait aucune action en tête
 * d'écran : ses deux boutons accentués étaient ceux de deux formulaires
 * déployés en permanence, à 700 et 1 050 px de défilement. La correction est
 * celle que /catalogue tient déjà — une barre d'outils sous le titre, dont
 * l'action accentuée **mène** au formulaire au lieu de le laisser traîner sous
 * la liste.
 *
 * Les deux segments sont des mots et non des identifiants : aucune collision
 * avec `/personnel/{staffId}`, dont le segment est un UUID, et Next fait de
 * toute façon primer le segment statique sur le dynamique — c'est déjà ce qui
 * fait cohabiter `/catalogue/nouveau` et `/catalogue/{serviceId}`.
 */

/** Créer une fiche praticien à partir d'un compte du personnel. */
export function adminNewStaffMemberPath(tenantSlug: string): string {
  return `${adminStaffPath(tenantSlug)}/nouveau`;
}

/** Inviter un compte du personnel — l'accès, pas l'agenda. */
export function adminStaffInvitePath(tenantSlug: string): string {
  return `${adminStaffPath(tenantSlug)}/inviter`;
}
