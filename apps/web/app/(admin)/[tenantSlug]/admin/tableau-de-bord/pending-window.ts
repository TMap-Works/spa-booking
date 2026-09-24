import type { CalendarDate } from '@spa/shared';

import type { CalendarRange } from '@/lib/admin/calendar-range';
import { addCalendarDays } from '@/lib/booking/calendar';

/**
 * La fenêtre sur laquelle le tableau de bord compte les demandes à confirmer
 * (#1159).
 *
 * ## Pourquoi une fenêtre, alors que le ticket demandait « toutes dates »
 *
 * Parce que l'API ne sert pas « toutes dates ». `appointmentListQuerySchema`
 * borne l'agenda à `MAX_APPOINTMENT_RANGE_DAYS` et `resolveAgendaRange` refuse
 * au-delà en 422 `APPOINTMENT_RANGE_TOO_WIDE` — une lecture non bornée est une
 * réponse dont la taille ne dépend que de l'appelant. Le critère d'acceptation
 * ouvrait explicitement une seconde branche : *« ou dit clairement qu'il ne
 * porte que sur »* sa portée. C'est celle-ci qui est tenue, et le libellé du
 * compteur nomme la fenêtre (`kpi.pending.label`).
 *
 * Ce qui est corrigé, c'est le fond du bug : le compteur était tiré de
 * `rangeOf('jour', today)`, c'est-à-dire de la **seule journée courante**, et
 * affichait « Tout est confirmé » quand six demandes attendaient la semaine
 * suivante. Une fenêtre d'un mois le rend de nouveau utilisable comme signal de
 * travail — c'est le salon qui confirme à la main (décision du 2026-09-19).
 *
 * ## Vers l'avant, et depuis aujourd'hui
 *
 * Une demande en attente pour une date passée n'est plus une demande : elle ne
 * se confirme plus utilement, et la compter gonflerait le signal de travail d'un
 * arriéré sur lequel il n'y a rien à faire. La fenêtre s'ouvre donc à la journée
 * du salon — celle que `todayInTimeZone` donne, jamais celle du navigateur — et
 * court vers l'avant.
 *
 * ## Trente et non trente et un
 *
 * La borne du contrat est de 31 journées, bornes comprises. La fenêtre en prend
 * 30 : c'est un nombre que le libellé peut écrire sans mentir (« 30 prochains
 * jours »), et cela laisse une journée de marge sous un plafond que le serveur
 * refuse en 422 — un compteur qui fait tomber le tableau de bord entier serait
 * un bug plus grave que celui qu'on corrige.
 */
export const PENDING_WINDOW_DAYS = 30;

/**
 * Les bornes civiles — incluses — sur lesquelles les demandes à confirmer se
 * comptent, à partir de la journée du salon.
 */
export function pendingWindow(today: CalendarDate): CalendarRange {
  return { from: today, to: addCalendarDays(today, PENDING_WINDOW_DAYS - 1) };
}
