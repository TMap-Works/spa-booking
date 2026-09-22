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
 *
 * ## La langue (#846)
 *
 * Un seul mot de ce module s'affiche : le titre de la rubrique fictive qui
 * recueille les prestations non classées. Tous les autres titres sont ceux que
 * le salon a saisis, et ils ne se traduisent pas.
 *
 * Ce module est pur et sans React : il ne peut appeler aucun crochet. Le titre
 * traduit lui est donc **passé en dernier paramètre, facultatif** — c'est la
 * forme que le brief de l'épique #843 prescrit pour un helper — et le défaut
 * reste le français, pour le seul appelant qui ne le résout pas : le squelette
 * de l'étape « prestation », qui ne rend aucun titre.
 */

import type { PublicService, ServiceCategorySummary } from '@spa/shared';

import fr from '@/messages/fr/booking.json';

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

/**
 * Titre affiché pour ces prestations-là, en français.
 *
 * @deprecated Transitoire (#846). Lu dans le catalogue plutôt que réécrit ici,
 * pour qu'il n'y ait qu'une écriture de ce libellé ; les appelants qui résolvent
 * la langue passent le leur en paramètre de `groupServicesByCategory`. Le seul
 * à ne pas le faire est `components/booking/step-skeleton.tsx`, et c'est sans
 * conséquence : son dessin ne rend aucun titre — il ne se sert du groupement que
 * pour compter les lignes à réserver. Même arbitrage que `PUBLIC_EXIT_LABELS` :
 * garder le français évite de basculer en anglais des écrans dont la traduction
 * n'a pas encore été relue.
 */
export const UNCLASSIFIED_TITLE: string = fr.salon.catalog.unclassified;

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
 *
 * `unclassifiedTitle` est le seul mot que l'appelant a à fournir (#846) : les
 * autres titres sont ceux du salon. Facultatif, il retombe sur le français —
 * voir {@link UNCLASSIFIED_TITLE}.
 */
export function groupServicesByCategory(
  services: readonly PublicService[],
  unclassifiedTitle: string = UNCLASSIFIED_TITLE,
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
    title: section.category?.name ?? unclassifiedTitle,
    category: section.category,
    services: section.services,
  }));

  return [
    ...grouped.filter((section) => section.key !== UNCLASSIFIED_KEY),
    ...grouped.filter((section) => section.key === UNCLASSIFIED_KEY),
  ];
}
