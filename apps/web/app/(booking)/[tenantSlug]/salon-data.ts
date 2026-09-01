/**
 * Chargement et adressage de la page publique du salon (#43).
 *
 * ## Pourquoi `cache()` de React
 *
 * La page est rendue **deux fois** par requête, au sens du chargement des
 * données : Next appelle `generateMetadata` avant le composant, et les deux ont
 * besoin de l'établissement — l'un pour le titre et la description, l'autre pour
 * le contenu. Sans mémoïsation, une page vue coûterait deux appels à
 * `GET /public/{slug}` alors que le critère d'acceptation vise un LCP sous
 * 2,5 s en 4G.
 *
 * `cache()` mémoïse **par requête** et non entre requêtes : deux visiteurs ne
 * partagent jamais un résultat, et le catalogue n'est pas servi depuis un cache
 * qui aurait vieilli. On ne s'appuie pas sur la mémoïsation de `fetch` de Next,
 * qui ne s'applique pas aux requêtes `cache: 'no-store'` — celles que fait
 * `lib/api-client.ts`.
 *
 * ## Ce module ne dépend d'aucun tenant en dur
 *
 * Le slug vient toujours du segment d'URL. Il n'est ni lu d'un en-tête ni
 * déduit d'une session : l'API le résout elle-même contre la table `tenants` et
 * répond 404 pour un salon inconnu ou désactivé (tenant-isolation §4).
 */

import type { PublicService, PublicTenant } from '@spa/shared';
import { cache } from 'react';

import { fetchPublicServices, fetchPublicTenant } from '@/lib/api-client';

/** Vitrine de l'établissement, chargée une fois par requête. */
export const loadSalonTenant = cache((tenantSlug: string): Promise<PublicTenant> =>
  fetchPublicTenant(tenantSlug),
);

/** Catalogue public de l'établissement, chargé une fois par requête. */
export const loadSalonServices = cache((tenantSlug: string): Promise<PublicService[]> =>
  fetchPublicServices(tenantSlug),
);

/**
 * Origine publique du front — celle sous laquelle un moteur de recherche voit
 * cette page.
 *
 * Lue d'`APP_URL`, la variable que `.env.example` déclare déjà pour le front, et
 * **non** de l'en-tête `Host` de la requête : un en-tête est fourni par
 * l'appelant, et le recopier dans une URL canonique ou dans des données
 * structurées laisserait un tiers désigner le domaine que les moteurs
 * associeront au salon.
 *
 * Sans préfixe `NEXT_PUBLIC_` : elle n'est lue que côté serveur, au rendu.
 */
export function siteOrigin(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** Chemin canonique de la page publique d'un salon. */
export function salonPath(tenantSlug: string): string {
  return `/${encodeURIComponent(tenantSlug)}`;
}

/** Chemin du tunnel de réservation du même salon. */
export function reservationPath(tenantSlug: string): string {
  return `${salonPath(tenantSlug)}/reservation`;
}

/** Adresse absolue de la page publique — ce qu'exigent `url` et `@id` du graphe. */
export function salonUrl(tenantSlug: string): string {
  return `${siteOrigin()}${salonPath(tenantSlug)}`;
}
