import { accountPath, bookingPath } from './(account)/[tenantSlug]/compte/paths';
import { adminLoginPath } from './(admin)/[tenantSlug]/admin/paths';

/**
 * Les portes d'un salon que la page d'accueil sait ouvrir (#927).
 *
 * Module sans dépendance serveur ni React : l'accueil et son formulaire — un
 * Client Component — y lisent la liste des portes et le chemin de chacune. Le
 * souvenir du dernier salon vit à part, dans `last-salon.ts`, parce qu'il lit
 * les cookies.
 *
 * ## Trois portes, pas davantage
 *
 * La racine du domaine ne mène qu'aux espaces qu'un salon **possède déjà** : son
 * tunnel de réservation, l'espace de sa clientèle, son back-office. Elle ne
 * liste aucun salon — un annuaire est une place de marché, hors périmètre
 * (CDC §1.4) — et n'en crée aucun.
 *
 * Le back-office s'ouvre sur sa **connexion** plutôt que sur une section : cet
 * écran renvoie de lui-même une session ouverte vers la première section de son
 * rang (#760), si bien qu'il n'y a qu'un chemin à connaître d'ici.
 *
 * ## Il ne nomme plus les portes (#1233)
 *
 * Il a porté `SALON_DOOR_LABELS`, une table de libellés figés en français. Elle
 * n'avait plus d'appelant de production depuis #846 — l'accueil et le
 * formulaire composent chacun la leur, des **deux sources traduites** que sont
 * `publicExitLabels(locale)` et le catalogue de l'écran —, et un module pur ne
 * peut de toute façon résoudre aucune langue. Ce qui reste ici ne se traduit
 * pas : une liste d'identifiants et trois chemins.
 *
 * Le fichier, lui, n'est pas supprimé : `SALON_DOORS`, `SalonDoor`,
 * `salonDoorPath` et `isSalonDoor` sont lus par `app/page.tsx`,
 * `app/actions.ts` et `components/home/salon-finder.tsx`.
 */
export const SALON_DOORS = ['reservation', 'compte', 'back-office'] as const;

export type SalonDoor = (typeof SALON_DOORS)[number];

export function salonDoorPath(tenantSlug: string, door: SalonDoor): string {
  switch (door) {
    case 'reservation':
      return bookingPath(tenantSlug);
    case 'compte':
      return accountPath(tenantSlug);
    case 'back-office':
      return adminLoginPath(tenantSlug);
  }
}

export function isSalonDoor(value: unknown): value is SalonDoor {
  return typeof value === 'string' && (SALON_DOORS as readonly string[]).includes(value);
}
