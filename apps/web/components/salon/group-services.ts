/**
 * Regroupement du catalogue public par rubrique (#43).
 *
 * Logique de présentation **pure** — aucun JSX, aucun accès réseau — pour deux
 * raisons : elle se teste sans monter de composant, et elle reste le seul
 * endroit où l'ordre d'affichage du catalogue est décidé.
 *
 * ## Ce qui n'est *pas* décidé ici
 *
 * L'ordre des prestations à l'intérieur d'une rubrique est celui que l'API
 * renvoie. Le front ne le retrie pas : le classement du catalogue appartient au
 * salon, et un tri alphabétique posé côté client remonterait « Balayage » avant
 * « Coupe » sur une carte que le salon a rangée autrement.
 */

import type { PublicService, ServiceCategorySummary } from '@spa/shared';

/**
 * Clé de la rubrique fictive qui recueille les prestations non classées.
 *
 * `category` est `null` pour une prestation qu'aucune rubrique ne porte
 * (`serviceSchema.category`) — le contrat l'autorise explicitement, pour ne pas
 * obliger un salon à inventer une rubrique avant sa première prestation. Ces
 * prestations existent donc, et les taire les rendrait invisibles du catalogue
 * public alors qu'elles sont réservables.
 *
 * Une chaîne qui n'est pas un UUID : aucune rubrique réelle ne peut la porter,
 * la collision de clés est impossible.
 */
export const UNCLASSIFIED_KEY = 'sans-rubrique';

/** Titre affiché pour ces prestations-là. */
export const UNCLASSIFIED_TITLE = 'Autres prestations';

/** Une rubrique du catalogue et les prestations qu'elle porte. */
export interface CatalogSection {
  /** Identifiant de rubrique, ou `UNCLASSIFIED_KEY` — sert de clé de rendu. */
  readonly key: string;
  /** Libellé de la section, tel qu'il coiffe la liste. */
  readonly title: string;
  /** La rubrique elle-même, `null` pour la section des prestations non classées. */
  readonly category: ServiceCategorySummary | null;
  readonly services: readonly PublicService[];
}

/**
 * Range les prestations par rubrique, dans l'ordre de première apparition.
 *
 * Deux propriétés qui comptent :
 *
 * - **l'ordre des rubriques suit celui de l'API**, pas l'alphabet — même raison
 *   que pour les prestations ci-dessus ;
 * - **les prestations non classées ferment la marche**, quelle que soit leur
 *   position dans la réponse : une section « Autres prestations » au milieu du
 *   catalogue se lit comme une rubrique du salon, ce qu'elle n'est pas.
 */
export function groupServicesByCategory(
  services: readonly PublicService[],
): readonly CatalogSection[] {
  const sections = new Map<string, { category: ServiceCategorySummary | null; services: PublicService[] }>();

  for (const service of services) {
    const key = service.category?.id ?? UNCLASSIFIED_KEY;
    const existing = sections.get(key);

    if (existing === undefined) {
      sections.set(key, { category: service.category, services: [service] });
    } else {
      existing.services.push(service);
    }
  }

  const grouped = [...sections.entries()].map(([key, section]) => ({
    key,
    title: section.category?.name ?? UNCLASSIFIED_TITLE,
    category: section.category,
    services: section.services,
  }));

  return [
    ...grouped.filter((section) => section.key !== UNCLASSIFIED_KEY),
    ...grouped.filter((section) => section.key === UNCLASSIFIED_KEY),
  ];
}
