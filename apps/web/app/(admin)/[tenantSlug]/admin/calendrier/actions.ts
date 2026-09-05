'use server';

/**
 * L'action serveur du planning — charger une période, et rien d'autre (#49).
 *
 * ## Pourquoi une action plutôt qu'une navigation
 *
 * Changer de jour ne change pas d'écran : la barre d'outils, la gouttière des
 * heures et les en-têtes de colonnes sont les mêmes. Repasser par une navigation
 * complète rejouerait tout le rendu serveur pour remplacer le contenu de sept
 * colonnes — et le planning est l'écran qu'on parcourt le plus vite, jour après
 * jour, en cherchant un trou.
 *
 * L'action rend donc les rendez-vous seuls ; le composant garde ce qu'il a déjà
 * chargé et précharge les deux périodes voisines. C'est le deuxième critère du
 * ticket : **seule la plage visible est chargée**, et la suivante est prête avant
 * qu'on la demande.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Aucune écriture. Le report par glisser-déposer relève de #51, la création
 * manuelle de #50 : ce module reste en lecture seule, et sa surface exposée au
 * navigateur se résume à un export.
 */

import { slugSchema, type Appointment } from '@spa/shared';

import { fetchAppointments } from '@/lib/api-client';
import {
  parseCalendarDate,
  parseCalendarView,
  rangeOf,
  type CalendarView,
} from '@/lib/admin/calendar-range';

import { expired, failure, invalid, type AdminActionResult } from '../action-result';
import { readAdminAccessToken } from '../session';

/**
 * Les rendez-vous d'une période, pour le planning du comptoir.
 *
 * `view` et `date` arrivent en chaînes : ce sont les valeurs de l'URL, et une
 * action serveur est un point d'entrée public que rien n'oblige à appeler depuis
 * l'écran. Elles sont donc revalidées ici, exactement comme le formulaire du
 * catalogue revalide son corps — le front valide pour le confort, l'API pour la
 * sécurité, et l'action pour les deux (web-frontend §4).
 *
 * L'établissement ne circule pas : `tenantSlug` ne sert qu'à retrouver le cookie
 * de session. C'est le jeton qui désigne l'établissement à l'API.
 */
export async function loadCalendarRangeAction(
  tenantSlug: string,
  view: string,
  date: string,
): Promise<AdminActionResult<{ readonly appointments: Appointment[] }>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const anchor = parseCalendarDate(date);

  if (anchor === null) {
    return invalid('Date de planning invalide.');
  }

  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    return expired();
  }

  const parsedView: CalendarView = parseCalendarView(view);
  const range = rangeOf(parsedView, anchor);

  try {
    return { ok: true, data: { appointments: await fetchAppointments(accessToken, range) } };
  } catch (error) {
    return failure(error);
  }
}
