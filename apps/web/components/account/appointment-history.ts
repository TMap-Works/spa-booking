import type { AppointmentStatus, TimeZone } from '@spa/shared';

import type { AppointmentBrief } from './appointment-brief';

/**
 * Ce qui range l'historique de l'espace client — filtre, regroupement par mois,
 * pagination — #1054.
 *
 * ## Pourquoi un module sans JSX, et séparé de `rebook.ts`
 *
 * Deux raisons, et la seconde n'est pas une préférence de style.
 *
 * 1. **Il se teste comme une fonction.** Le regroupement d'une liste par mois
 *    dans le fuseau du salon est exactement le genre de calcul qu'un rendu ne
 *    prouve pas : « 30 septembre 23 h à Paris » est encore septembre, et
 *    « 1er octobre 00 h 30 » ne l'est plus, alors que les deux instants UTC sont
 *    à une heure l'un de l'autre. Une suite qui lit un DOM ne dirait pas
 *    lequel des deux a basculé (web-frontend §8).
 * 2. **Il traverse la frontière client.** L'écran filtre sans recharger la page
 *    — troisième critère d'acceptation de #1054 —, donc le filtre et le
 *    regroupement s'exécutent dans le navigateur, et ce module part dans le
 *    bundle. C'est pourquoi la fabrication du lien « Réserver à nouveau » vit
 *    ailleurs (`rebook.ts`) : elle lit le registre de clés du tunnel, qui
 *    emporte Zod et les schémas partagés avec lui. Ce lien est une chaîne que le
 *    serveur calcule une fois ; il n'avait aucune raison d'emmener un validateur
 *    dans le navigateur avec lui.
 */

/** Un rendez-vous de l'historique, augmenté de ce que sa ligne sait faire. */
export interface HistoryEntry {
  readonly brief: AppointmentBrief;
  /**
   * Le tunnel ouvert sur la même prestation et le même praticien (BM-HISTO-02),
   * ou `null` quand il n'y a rien à rouvrir — voir `rebook.ts`.
   */
  readonly rebookHref: string | null;
}

/** Les trois filtres de la rangée segmentée, dans l'ordre où ils s'affichent. */
export type HistoryFilter = 'tous' | 'honores' | 'annules';

export interface HistoryFilterItem {
  readonly id: HistoryFilter;
  readonly label: string;
  /** Ce qu'on lit quand ce filtre ne retient rien. */
  readonly empty: string;
}

/**
 * « Tous · Honorés · Annulés », et rien d'autre.
 *
 * Un filtre par statut aurait fait cinq pastilles — dont « À confirmer » et
 * « Non honoré », qui ne comptent chacune qu'une poignée de lignes sur une vie
 * de cliente — et la rangée aurait défilé horizontalement avant d'avoir servi.
 * Les trois retenues sont celles que l'audit `d20260918-1` nomme, et « Tous »
 * reste la vue par défaut : aucune ligne n'est jamais hors d'atteinte.
 */
export const HISTORY_FILTERS: readonly HistoryFilterItem[] = [
  { id: 'tous', label: 'Tous', empty: 'Votre historique est vide.' },
  {
    id: 'honores',
    label: 'Honorés',
    empty: 'Aucune visite honorée dans votre historique pour l’instant.',
  },
  {
    id: 'annules',
    label: 'Annulés',
    empty: 'Aucun rendez-vous annulé — tant mieux.',
  },
] as const;

/**
 * Le rendez-vous entre-t-il dans ce filtre ?
 *
 * « Annulés » retient le statut `cancelled` **quel qu'en soit l'auteur**, donc
 * y compris la ligne d'origine d'un report, que l'espace client nomme
 * « Déplacé » (`lib/appointment-status.ts`). Les séparer aurait demandé une
 * quatrième pastille pour deux ou trois lignes, et la cliente qui cherche
 * « ce qui n'a pas eu lieu » cherche les deux à la fois.
 */
export function matchesHistoryFilter(status: AppointmentStatus, filter: HistoryFilter): boolean {
  if (filter === 'tous') {
    return true;
  }

  return filter === 'honores' ? status === 'completed' : status === 'cancelled';
}

/** Un mois d'historique et ses lignes — l'intertitre et ce qu'il coiffe. */
export interface HistoryMonth {
  /** « 2026-09 » — stable, triable, et utilisable en `id` de section. */
  readonly key: string;
  /** « Septembre 2026 ». */
  readonly label: string;
  readonly entries: readonly HistoryEntry[];
}

/**
 * Les lignes groupées par mois, le plus récent d'abord.
 *
 * ## Le mois est celui du **salon**
 *
 * `Intl` reçoit le fuseau de l'établissement, comme partout ailleurs dans le
 * parcours (ADR 0006) : un rendez-vous du 1er octobre à 0 h 30 à Antananarivo
 * est encore le 30 septembre à Paris, et l'intertitre doit dire ce que la
 * cliente a vécu sur place, pas ce que dit l'horloge du serveur.
 *
 * ## Le tri est refait ici, bien que l'API l'ait déjà fait
 *
 * `listForClient` sert `scope=past` en `startsAt desc`
 * (`appointments.repository.ts`). Le refaire coûte un tri sur vingt éléments et
 * rend cette fonction **totale** : son résultat ne dépend plus de la discipline
 * de l'appelant, et la suite peut lui passer une liste dans le désordre pour
 * prouver le regroupement sans dépendre de l'ordre de service de l'API.
 */
export function groupHistoryByMonth(
  entries: readonly HistoryEntry[],
  timeZone: TimeZone,
): readonly HistoryMonth[] {
  // Les deux formateurs sont construits une fois pour toute la liste :
  // `Intl.DateTimeFormat` est coûteux à instancier, et le faire par ligne se
  // paierait à chaque frappe sur un filtre.
  const monthParts = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  });
  const monthLabel = new Intl.DateTimeFormat('fr-FR', { timeZone, year: 'numeric', month: 'long' });

  const months = new Map<string, { label: string; entries: HistoryEntry[] }>();

  for (const entry of sortHistoryMostRecentFirst(entries)) {
    const date = new Date(entry.brief.appointment.startsAt);
    const key = monthKey(monthParts, date);
    const month = months.get(key);

    if (month === undefined) {
      months.set(key, { label: capitalize(monthLabel.format(date)), entries: [entry] });
    } else {
      month.entries.push(entry);
    }
  }

  // `Map` conserve l'ordre d'insertion : la liste étant triée du plus récent au
  // plus ancien, le premier mois rencontré est le plus récent.
  return [...months].map(([key, month]) => ({ key, label: month.label, entries: month.entries }));
}

/** Combien de lignes avant que « Voir plus » ne prenne le relais. */
export const HISTORY_PAGE_SIZE = 10;

/**
 * La liste du plus récent au plus ancien, sans toucher à celle qu'on reçoit.
 *
 * Exportée parce que **la pagination doit trancher dans une liste déjà triée** :
 * « Voir plus » coupe les dix premières lignes avant de les grouper, et couper
 * avant de trier ferait dépendre le contenu de la première page de l'ordre où
 * l'API a servi les rendez-vous — le tri interne de `groupHistoryByMonth`
 * arriverait trop tard pour le rattraper, et une liste servie autrement ouvrirait
 * sur dix lignes au hasard.
 */
export function sortHistoryMostRecentFirst(
  entries: readonly HistoryEntry[],
): readonly HistoryEntry[] {
  return [...entries].sort(mostRecentFirst);
}

function mostRecentFirst(left: HistoryEntry, right: HistoryEntry): number {
  return (
    new Date(right.brief.appointment.startsAt).getTime() -
    new Date(left.brief.appointment.startsAt).getTime()
  );
}

/**
 * « 2026-09 » à partir des morceaux qu'`Intl` rend dans le fuseau du salon.
 *
 * Les morceaux plutôt qu'une chaîne formatée : `format` rendrait « 09/2026 »
 * dans une locale et « 9/2026 » dans une autre, et la clé — qui sert d'`id` de
 * section HTML — ne doit dépendre ni de la locale ni de la ponctuation qu'elle
 * choisit.
 */
function monthKey(format: Intl.DateTimeFormat, date: Date): string {
  const parts = format.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year').padStart(4, '0')}-${value('month').padStart(2, '0')}`;
}

/** « septembre 2026 » → « Septembre 2026 » : un intertitre commence une ligne. */
function capitalize(label: string): string {
  return label.charAt(0).toLocaleUpperCase('fr-FR') + label.slice(1);
}
