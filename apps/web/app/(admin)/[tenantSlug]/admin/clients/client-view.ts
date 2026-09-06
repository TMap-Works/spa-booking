/**
 * Ce que l'écran du fichier client déduit de l'URL et de la réponse de l'API.
 *
 * Un module ordinaire, à côté de la page et des actions : ce sont des fonctions
 * **pures**, donc testables sans monter un arbre React ni simuler un routeur, et
 * elles n'ont leur place ni dans `page.tsx` — qui ne serait plus lisible — ni
 * dans `actions.ts`, dont chaque export est un point d'entrée appelable depuis
 * le navigateur.
 */

import {
  CUSTOMER_SEARCH_MAX_LENGTH,
  CUSTOMER_SEARCH_MIN_LENGTH,
  type AppointmentStatus,
  type CustomerSummary,
} from '@spa/shared';

/**
 * Le terme de recherche tel que l'API accepte de le recevoir, ou `null`.
 *
 * L'URL est une **entrée**, au même titre qu'un champ de formulaire : elle se
 * partage, se met en favori et se corrige à la main. `?recherche=a` y arrive
 * donc tôt ou tard, et l'envoyer tel quel ferait répondre 400 à
 * `GET /customers` — soit un écran en erreur pour une saisie qui n'est
 * qu'incomplète.
 *
 * Les deux bornes sont celles du contrat (`customerSearchQuerySchema`), lues et
 * non recopiées : un terme d'une lettre ramènerait la quasi-totalité du fichier
 * à chaque frappe, et un terme plus long que la colonne la plus large ne peut
 * rien trouver.
 *
 * Le paramètre est typé `string | string[]` parce que c'est ce que Next rend :
 * une clé répétée — `?recherche=a&recherche=b`, qu'un copier-coller d'URL
 * produit sans effort — arrive en **tableau**. Le prendre pour une chaîne et lui
 * demander `.trim()` lèverait une `TypeError` dans le Server Component, soit
 * l'écran en erreur que cette fonction existe précisément pour éviter. Un terme
 * répété n'en désigne aucun : on n'en retient donc aucun.
 */
export function parseSearchTerm(raw: string | string[] | undefined): string | null {
  const term = typeof raw === 'string' ? raw.trim() : '';

  return term.length >= CUSTOMER_SEARCH_MIN_LENGTH && term.length <= CUSTOMER_SEARCH_MAX_LENGTH
    ? term
    : null;
}

/**
 * Le numéro de page demandé, ramené à la première dès qu'il n'a pas de sens.
 *
 * Même raison que ci-dessus : `?page=0`, `?page=-3`, `?page=deux` et la clé
 * répétée `?page=1&page=2` sont des entrées possibles, et l'API refuserait les
 * premières en 400. Retomber sur la première page est le seul repli qui affiche
 * quelque chose de juste.
 */
export function parsePageNumber(raw: string | string[] | undefined): number {
  const page = Number(typeof raw === 'string' ? raw : Number.NaN);

  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * `true` si le prix de cette visite n'a jamais été encaissé.
 *
 * Une annulation et une absence portent le prix **figé à la réservation** — la
 * réponse de l'API le rend pour toutes les visites — mais aucune des deux n'a
 * produit de recette : `totalSpent` ne compte que les visites honorées. Les
 * afficher comme les autres laisserait lire un chiffre d'affaires qui n'existe
 * pas ; les masquer effacerait l'ordre de grandeur de ce qui a été perdu. Ils
 * sont donc rendus, barrés.
 *
 * Un rendez-vous encore à venir n'est pas de ceux-là : son prix tient toujours.
 */
export function isVoidVisit(status: AppointmentStatus): boolean {
  return status === 'cancelled' || status === 'no_show';
}

/**
 * La ligne de coordonnées d'une fiche dans la liste — ce qu'on lit à voix haute.
 *
 * Le téléphone d'abord : c'est ce qu'un comptoir compose. L'adresse ensuite,
 * seule quand le numéro manque — une fiche saisie au comptoir n'en a pas
 * toujours, et une ligne vide obligerait à ouvrir la fiche pour savoir si la
 * personne est joignable.
 */
export function customerContactLine(customer: CustomerSummary): string {
  return customer.phone === null ? customer.email : `${customer.phone} · ${customer.email}`;
}
