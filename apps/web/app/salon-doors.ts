
import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';

import { accountPath, bookingPath } from './(account)/[tenantSlug]/compte/paths';
import { adminLoginPath } from './(admin)/[tenantSlug]/admin/paths';

/**
 * Les portes d'un salon que la page d'accueil sait ouvrir (#927).
 *
 * Module sans dépendance serveur : le formulaire de l'accueil, qui est un
 * Client Component, en lit les libellés. Le souvenir du dernier salon vit à
 * part, dans `last-salon.ts`, parce qu'il lit les cookies.
 *
 * ## Trois portes, pas davantage
 *
 * La racine du domaine ne mène qu'aux espaces qu'un salon **possède déjà** : son
 * tunnel de réservation, l'espace de sa clientèle, son back-office. Elle ne
 * liste aucun salon — un annuaire est une place de marché, hors périmètre
 * (CDC §1.4) — et n'en crée aucun.
 *
 * Les deux premiers libellés viennent de `PUBLIC_EXIT_LABELS` et ne sont pas
 * réécrits : la vitrine et le tunnel nomment déjà ces destinations, et la même
 * page ne doit pas s'appeler « Mes rendez-vous » sur la vitrine et « Mon compte »
 * ici. Le back-office garde le nom que son propre écran de connexion lui donne.
 *
 * Le back-office s'ouvre sur sa **connexion** plutôt que sur une section : cet
 * écran renvoie de lui-même une session ouverte vers la première section de son
 * rang (#760), si bien qu'il n'y a qu'un chemin à connaître d'ici.
 */
export const SALON_DOORS = ['reservation', 'compte', 'back-office'] as const;

export type SalonDoor = (typeof SALON_DOORS)[number];

export const SALON_DOOR_LABELS: Readonly<Record<SalonDoor, string>> = {
  reservation: PUBLIC_EXIT_LABELS.reservation,
  compte: PUBLIC_EXIT_LABELS.compte,
  'back-office': 'Back-office du salon',
};

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
