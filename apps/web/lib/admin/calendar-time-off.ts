/**
 * La fenêtre d'absences que couvre une période du planning — #1158.
 *
 * ## Pourquoi un module à part, et pas trois lignes dans la page
 *
 * Deux appelants la composent et doivent la composer **à l'identique** : le
 * rendu serveur du planning, qui amorce trois périodes, et son action serveur,
 * qui charge les suivantes. Deux écritures auraient fini par borner deux
 * fenêtres différentes pour la même journée, et un congé aurait été visible à
 * l'ouverture de l'écran puis absent après un clic sur la flèche — le genre
 * d'écart qu'on met une campagne de QA à retrouver.
 *
 * Il n'est **pas** importé par la grille ni par le composant du planning, et
 * c'est délibéré : il tire `lib/admin/staff-time-off.ts`, donc les schémas Zod
 * du contrat d'absences, dont un Client Component n'a que faire. L'écran le
 * plus dense du back-office n'a pas à les embarquer pour afficher des congés
 * qu'on lui sert déjà lus.
 *
 * ## Pourquoi une journée de marge de part et d'autre
 *
 * Les bornes partent du fuseau de l'établissement, et l'action serveur le reçoit
 * de l'écran — elle ne le croit pas sur parole, mais un repli sur UTC décalerait
 * la fenêtre de quelques heures. Une journée de marge absorbe l'écart sans rien
 * coûter : l'API retient une absence dès qu'elle **recoupe** la fenêtre, et la
 * grille écrête ensuite chaque absence à la journée qu'elle peint. Une absence
 * de trop dans la réponse ne se voit donc nulle part ; une absence manquante se
 * verrait sur la première et la dernière colonne de chaque période.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

import { addCalendarDays } from '../booking/calendar';
import { daysInView, rangeOf, type CalendarView, type WeekStart } from './calendar-range';
import { timeOffWindow } from './staff-time-off';

/** Les bornes à offset explicite qu'attend `GET /v1/staff-time-off`. */
export function calendarTimeOffWindow(
  view: CalendarView,
  anchor: CalendarDate,
  weekStart: WeekStart,
  timeZone: TimeZone,
): { readonly from: string; readonly to: string } {
  const range = rangeOf(view, anchor, weekStart);

  return timeOffWindow(addCalendarDays(range.from, -1), daysInView(view) + 2, timeZone);
}
