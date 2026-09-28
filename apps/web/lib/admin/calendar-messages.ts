/**
 * Le catalogue `admin-planning`, lu **hors de React** — #848.
 *
 * ## Pourquoi un accès direct aux JSON
 *
 * Le planning met son calcul hors des composants : `calendar-range.ts` décide de
 * la période, `calendar-grid.ts` en fait des colonnes, `calendar-start.ts` dit
 * ce qu'un planning vide doit proposer. Ce sont des **fonctions pures**, appelées
 * depuis un Server Component, depuis un Client Component et depuis des tests
 * sans DOM : aucun crochet de `next-intl` n'y est disponible.
 *
 * Elles lisent donc leurs mots comme `lib/appointment-status.ts` et
 * `lib/format.ts` lisent les leurs — par import direct des deux fichiers de
 * langue. Ce sont **les mêmes fichiers** que ceux qu'`useTranslations` sert aux
 * composants : il n'y a qu'une écriture de ce vocabulaire, et le test de parité
 * des catalogues la garde entière dans les deux langues.
 *
 * ## Pourquoi pas de formateur ICU
 *
 * Les messages lus ici n'ont que des paramètres nommés, sans pluriel ni
 * sélection — le seul comptage du planning (« 2 RDV ») porte deux clés
 * distinctes plutôt qu'une règle de pluriel, parce que la forme du singulier
 * n'est pas celle du pluriel dans les deux langues. Un remplacement littéral
 * suffit, et évite d'embarquer un formateur ICU dans le chemin de chaque cellule
 * de la grille — une vue semaine en peint plusieurs centaines.
 */

import { DEFAULT_LOCALE, type Locale } from '@spa/shared';

import en from '@/messages/en/admin-planning.json';
import fr from '@/messages/fr/admin-planning.json';

/** Les deux catalogues, dans l'ordre où le front les sert. */
const CATALOG = { fr, en } as const;

/**
 * La langue employée quand l'appelant n'en passe pas.
 *
 * `DEFAULT_LOCALE` depuis #1297, et non plus `'fr'`. Le défaut français gardait
 * le comportement d'avant l'épique #843 pour les rares appelants hors du
 * périmètre du ticket d'alors — le tableau de bord, l'encaissement. Ils passent
 * tous leur langue résolue désormais, et un repli qui promet du français est
 * devenu l'inverse de ce que le produit rend par défaut.
 */
export const CALENDAR_FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;

/** Le catalogue du planning, dans la langue demandée. */
export function planningWords(locale: Locale = CALENDAR_FALLBACK_LOCALE): typeof en {
  return CATALOG[locale];
}

/**
 * Le remplacement des paramètres d'un message lu hors de React.
 *
 * Même fonction que celle de `lib/format.ts`, et pour la même raison : ces
 * messages n'ont que des paramètres nommés, et `String.replaceAll` les pose sans
 * qu'un formateur ait à être monté.
 */
export function fillMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    message,
  );
}
