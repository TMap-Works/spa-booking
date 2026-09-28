/**
 * Le catalogue `admin-staff`, lu **hors de React** — #848.
 *
 * Même raison d'être que `calendar-messages.ts`, pour l'autre moitié du ticket :
 * `staff-schedule.ts`, `staff-time-off.ts` et `staff-directory.ts` sont des
 * fonctions pures — elles nomment un jour, jugent une grille d'horaires, écrivent
 * une absence — et sont appelées depuis un Server Component, depuis un Client
 * Component et depuis des tests sans DOM. Aucun crochet n'y est disponible ; les
 * deux fichiers de langue sont donc importés directement, et ce sont les mêmes
 * que ceux qu'`useTranslations('admin-staff')` sert aux composants.
 */

import { DEFAULT_LOCALE, type Locale } from '@spa/shared';

import en from '@/messages/en/admin-staff.json';
import fr from '@/messages/fr/admin-staff.json';

const CATALOG = { fr, en } as const;

/** Voir `CALENDAR_FALLBACK_LOCALE` — même arbitrage, même raison, #1297 compris. */
export const STAFF_FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;

/** Le catalogue du personnel, dans la langue demandée. */
export function staffWords(locale: Locale = STAFF_FALLBACK_LOCALE): typeof en {
  return CATALOG[locale];
}

export { fillMessage } from './calendar-messages';
