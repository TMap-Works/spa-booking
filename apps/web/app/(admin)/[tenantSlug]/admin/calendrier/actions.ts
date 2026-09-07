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
 * ## Les écritures du comptoir (#50)
 *
 * Elles ont rejoint ce module : poser un rendez-vous, le déplacer, le solder, et
 * retrouver ou créer la fiche cliente au passage. Toutes suivent la même
 * discipline que la lecture — l'établissement ne circule jamais, `tenantSlug` ne
 * sert qu'à retrouver le cookie de session, et le corps est **revalidé ici**
 * avec le schéma de `@spa/shared` avant d'atteindre l'API (web-frontend §4).
 *
 * Le report par glisser-déposer (#51) passe par la même action que le tiroir —
 * `rescheduleDeskAppointmentAction` —, et c'était le pari de #50 : il n'y a que
 * le geste qui change, jamais le mécanisme. Une écriture de plus ici aurait
 * signifié qu'on avait laissé le glissement contourner le report.
 */

import {
  changeAppointmentStatusRequestSchema,
  createAppointmentRequestSchema,
  createCustomerRequestSchema,
  customerSearchQuerySchema,
  rescheduleAppointmentRequestSchema,
  slugSchema,
  uuidSchema,
  type Appointment,
  type Customer,
  type CustomerSummary,
  // Aliasé : `Notification` est aussi le composant du design system, et le nom
  // nu prêterait à confusion dans un module que le tiroir consomme.
  type Notification as NotificationTrace,
  type ServiceStaffMember,
} from '@spa/shared';

import {
  changeAppointmentStatus,
  createAppointment,
  createCustomer,
  fetchAppointmentNotifications,
  fetchAppointments,
  fetchServiceStaff,
  rescheduleDeskAppointment,
  searchCustomers,
} from '@/lib/api-client';
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

/**
 * Le jeton d'accès du back-office, ou le refus qui va avec.
 *
 * Écrit une fois : les six actions qui suivent commencent toutes par le même
 * geste, et une session expirée doit rendre exactement le même `UNAUTHORIZED`
 * partout — c'est lui, et lui seul, que les écrans traduisent par un retour à la
 * connexion.
 */
async function deskToken(
  tenantSlug: string,
): Promise<{ readonly token: string } | { readonly refusal: AdminActionResult<never> }> {
  if (!slugSchema.safeParse(tenantSlug).success) {
    return { refusal: invalid('Établissement inconnu.') };
  }

  const accessToken = await readAdminAccessToken();

  return accessToken === null ? { refusal: expired() } : { token: accessToken };
}

/**
 * Cherche une fiche cliente d'un seul terme — deuxième critère de #50.
 *
 * Le terme est revalidé par le schéma partagé : sous deux caractères, la
 * recherche n'est pas rendue à l'API du tout. Ce n'est pas une coquetterie de
 * confort — c'est la borne que `customerSearchQuerySchema` pose, et la respecter
 * ici évite un aller-retour dont on connaît déjà le refus.
 */
export async function searchDeskClientsAction(
  tenantSlug: string,
  term: string,
): Promise<AdminActionResult<{ readonly clients: CustomerSummary[] }>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = customerSearchQuerySchema.safeParse({ q: term });

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Recherche invalide.');
  }

  try {
    const page = await searchCustomers(access.token, { q: parsed.data.q });
    return { ok: true, data: { clients: page.items } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Crée une fiche cliente au comptoir — l'autre moitié du deuxième critère.
 *
 * Aucun mot de passe n'est demandé ni transmis : `createCustomerRequestSchema`
 * n'en porte pas, et une fiche saisie au téléphone n'est pas une identité de
 * connexion.
 */
export async function createDeskClientAction(
  tenantSlug: string,
  payload: unknown,
): Promise<AdminActionResult<Customer>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = createCustomerRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'La fiche cliente saisie est invalide.');
  }

  try {
    return { ok: true, data: await createCustomer(access.token, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Les praticiens qui tiennent une prestation donnée.
 *
 * C'est cette liste-là, et non l'équipe entière, que le tiroir propose : un
 * praticien qui ne pratique pas le soin choisi ne peut pas le recevoir, et le
 * proposer ferait refuser la réservation après la saisie. L'affectation est
 * servie par `GET /services/:id/staff` (#24).
 */
export async function loadDeskServiceStaffAction(
  tenantSlug: string,
  serviceId: string,
): Promise<AdminActionResult<{ readonly staff: ServiceStaffMember[] }>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(serviceId).success) {
    return invalid('Prestation inconnue.');
  }

  try {
    return { ok: true, data: { staff: await fetchServiceStaff(access.token, serviceId) } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Le journal d'envois d'un rendez-vous — cinquième critère de #70.
 *
 * Une lecture, comme `loadDeskServiceStaffAction`, et pour la même raison : le
 * tiroir est un Client Component, et le client HTTP de `lib/api-client.ts` est
 * serveur-only — c'est lui qui détient le cookie `httpOnly` de session.
 *
 * L'établissement ne circule pas : `tenantSlug` ne sert qu'à retrouver le
 * cookie, et l'API borne la lecture sur le jeton. Un rendez-vous d'un autre
 * salon rend donc une liste vide, jamais ses traces.
 */
export async function loadAppointmentNotificationsAction(
  tenantSlug: string,
  appointmentId: string,
): Promise<AdminActionResult<{ readonly notifications: readonly NotificationTrace[] }>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid('Rendez-vous inconnu.');
  }

  try {
    return {
      ok: true,
      data: { notifications: await fetchAppointmentNotifications(access.token, appointmentId) },
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Pose un rendez-vous depuis le planning — premier critère de #50.
 *
 * `startsAt` arrive **déjà** en ISO 8601 avec l'offset de l'établissement : la
 * conversion est faite par le tiroir, qui est le seul à connaître le fuseau du
 * salon au moment de la saisie (`lib/admin/appointment-desk.ts`). Le schéma la
 * normalise en UTC ici, et l'API la revalidera de son côté.
 *
 * Le `.strict()` du schéma refuse un `client` : cette action ne peut pas créer
 * de fiche au passage, c'est `createDeskClientAction` qui le fait, explicitement.
 */
export async function createDeskAppointmentAction(
  tenantSlug: string,
  payload: unknown,
): Promise<AdminActionResult<Appointment>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = createAppointmentRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Le rendez-vous saisi est invalide.');
  }

  try {
    return { ok: true, data: await createAppointment(access.token, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Déplace un rendez-vous — troisième critère de #50, et le geste de #51.
 *
 * La réponse est un rendez-vous **neuf** : un report est une annulation suivie
 * d'une création liée (booking-engine §5). L'écran remplace donc celui qu'il
 * gardait, il ne le met pas à jour.
 */
export async function rescheduleDeskAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  payload: unknown,
): Promise<AdminActionResult<Appointment>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid('Rendez-vous inconnu.');
  }

  const parsed = rescheduleAppointmentRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Le report saisi est invalide.');
  }

  try {
    return { ok: true, data: await rescheduleDeskAppointment(access.token, appointmentId, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Solde un rendez-vous — `completed` ou `no_show`, cinquième critère de #50.
 *
 * La transition est jugée par le serveur, pas ici : le tiroir ne propose que ce
 * que `APPOINTMENT_STATUS_TRANSITIONS` autorise, et l'API refuse le reste en
 * `INVALID_STATE_TRANSITION`. Les deux lisent la même table du contrat partagé.
 */
export async function markDeskAppointmentStatusAction(
  tenantSlug: string,
  appointmentId: string,
  payload: unknown,
): Promise<AdminActionResult<Appointment>> {
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid('Rendez-vous inconnu.');
  }

  const parsed = changeAppointmentStatusRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Statut de rendez-vous invalide.');
  }

  try {
    return {
      ok: true,
      data: await changeAppointmentStatus(access.token, appointmentId, parsed.data),
    };
  } catch (error) {
    return failure(error);
  }
}
