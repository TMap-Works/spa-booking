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
 * Elles ont rejoint ce module : poser un rendez-vous, le déplacer, le solder,
 * l'annuler (#754), et retrouver ou créer la fiche cliente au passage. Toutes suivent la même
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
  availabilityQuerySchema,
  cancelAppointmentRequestSchema,
  changeAppointmentStatusRequestSchema,
  createAppointmentRequestSchema,
  createCustomerRequestSchema,
  customerSearchQuerySchema,
  rescheduleAppointmentRequestSchema,
  slugSchema,
  timeZoneSchema,
  uuidSchema,
  type Appointment,
  type AvailabilitySlot,
  type BookedAppointment,
  type Customer,
  type CustomerSummary,
  type StaffTimeOff,
  // Aliasé : `Notification` est aussi le composant du design system, et le nom
  // nu prêterait à confusion dans un module que le tiroir consomme.
  type Notification as NotificationTrace,
  type ServiceStaffMember,
} from '@spa/shared';
import { getTranslations } from 'next-intl/server';

import {
  cancelDeskAppointment,
  changeAppointmentStatus,
  createAppointment,
  createCustomer,
  fetchAdminAvailability,
  fetchAppointmentNotifications,
  fetchAppointments,
  fetchServiceStaff,
  fetchStaffTimeOff,
  rescheduleDeskAppointment,
  searchCustomers,
} from '@/lib/api-client';
import {
  parseCalendarDate,
  parseCalendarView,
  rangeOf,
  type CalendarView,
  type WeekStart,
} from '@/lib/admin/calendar-range';
import { calendarTimeOffWindow } from '@/lib/admin/calendar-time-off';

import { failure, invalid, type AdminActionResult } from '../action-result';
import { adminActionAccess } from '../session';

/**
 * Les rendez-vous d'une période **et les absences qui la recoupent**, pour le
 * planning du comptoir.
 *
 * `view` et `date` arrivent en chaînes : ce sont les valeurs de l'URL, et une
 * action serveur est un point d'entrée public que rien n'oblige à appeler depuis
 * l'écran. Elles sont donc revalidées ici, exactement comme le formulaire du
 * catalogue revalide son corps — le front valide pour le confort, l'API pour la
 * sécurité, et l'action pour les deux (web-frontend §4).
 *
 * L'établissement ne circule pas : `tenantSlug` ne sert qu'à retrouver le cookie
 * de session. C'est le jeton qui désigne l'établissement à l'API.
 *
 * Les congés voyagent avec la période parce qu'ils en dépendent (#1158) : les
 * semaines de travail, elles, sont hebdomadaires et le rendu serveur les a déjà
 * passées une fois pour toutes. Leur échec ne fait pas tomber la réponse — un
 * planning sans congés reste l'écran d'avant ce ticket, un planning sans agenda
 * n'est plus un planning.
 */
export async function loadCalendarRangeAction(
  tenantSlug: string,
  view: string,
  date: string,
  /**
   * Le jour qui ouvre la semaine, tel que la région de l'établissement le veut
   * (#848) — `1` lundi, `0` dimanche.
   *
   * Il arrive de l'écran et n'est pas cru sur parole : une action serveur est un
   * point d'entrée public, et tout ce qui n'est pas exactement `0` retombe sur le
   * lundi. Il ne sert qu'à **borner la plage** demandée à l'API ; l'ancrage,
   * lui, a déjà été normalisé côté écran.
   */
  weekStart?: number,
  /**
   * Le fuseau de l'établissement, pour borner la fenêtre d'absences (#1158).
   *
   * Il arrive de l'écran pour la même raison que `weekStart`, et se juge de la
   * même façon : `timeZoneSchema` le refuse s'il n'est pas un fuseau IANA, et le
   * repli est UTC. Il ne désigne **rien** — l'établissement reste celui du jeton
   * — et ne sert qu'à poser deux bornes que `calendarTimeOffWindow` élargit
   * d'une journée de part et d'autre, précisément pour qu'un repli ne fasse
   * perdre aucune absence. Le lire sur la vitrine publique à chaque flèche
   * « jour suivant » aurait coûté un aller-retour de plus sur le chemin que le
   * planning existe pour rendre instantané.
   */
  timeZone?: string,
): Promise<
  AdminActionResult<{
    readonly appointments: Appointment[];
    readonly timeOff: readonly StaffTimeOff[];
  }>
> {
  const t = await getTranslations('admin-planning');
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid(t('actions.unknownTenant'));
  }

  const anchor = parseCalendarDate(date);

  if (anchor === null) {
    return invalid(t('actions.invalidDate'));
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  const { accessToken } = access;

  const parsedView: CalendarView = parseCalendarView(view);
  const start: WeekStart = weekStart === 0 ? 0 : 1;
  const range = rangeOf(parsedView, anchor, start);
  const zone = timeZoneSchema.safeParse(timeZone);

  try {
    const [appointments, timeOff] = await Promise.all([
      fetchAppointments(accessToken, range),
      fetchStaffTimeOff(
        accessToken,
        calendarTimeOffWindow(parsedView, anchor, start, zone.success ? zone.data : 'UTC'),
      ).catch((): readonly StaffTimeOff[] => []),
    ]);

    return { ok: true, data: { appointments, timeOff } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Le jeton d'accès du back-office, ou le refus qui va avec.
 *
 * Écrit une fois : les six actions qui suivent commencent toutes par le même
 * geste, et une session expirée doit rendre exactement le même `UNAUTHORIZED`
 * partout — c'est lui, et lui seul, que les écrans traduisent par un passage à
 * la route de renouvellement. Un cookie d'accès expiré ne le produit plus : il
 * est renouvelé sur place (#856), et seul un renouvellement impossible remonte.
 */
async function deskToken(
  tenantSlug: string,
): Promise<{ readonly token: string } | { readonly refusal: AdminActionResult<never> }> {
  const t = await getTranslations('admin-planning');
  if (!slugSchema.safeParse(tenantSlug).success) {
    return { refusal: invalid(t('actions.unknownTenant')) };
  }

  const access = await adminActionAccess(tenantSlug);

  return access.ok ? { token: access.accessToken } : { refusal: access };
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = customerSearchQuerySchema.safeParse({ q: term });

  if (!parsed.success) {
    return invalid(t('actions.invalidSearch'));
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = createCustomerRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(t('actions.invalidClient'));
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(serviceId).success) {
    return invalid(t('actions.unknownService'));
  }

  try {
    return { ok: true, data: { staff: await fetchServiceStaff(access.token, serviceId) } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Les créneaux qu'une journée offre réellement, pour le tiroir de rendez-vous (#611).
 *
 * ## Pourquoi cette lecture existe
 *
 * L'API n'accepte une écriture que sur un créneau que le moteur a lui-même
 * rendu — égalité stricte de l'instant, sinon `SLOT_NO_LONGER_AVAILABLE`. Le
 * tiroir ne peut donc pas laisser saisir une heure quelconque : il faut qu'il
 * connaisse la liste. Voir l'en-tête de `deskSlotOptions`.
 *
 * ## Pourquoi la route gardée, et non la publique (#642)
 *
 * `GET /public/{slug}/availability` et `GET /v1/availability` appellent la
 * **même** `AvailabilityQueryService.slotsFor` avec les mêmes paramètres : la
 * charge utile est identique, à l'octet près. Ce qui les sépare est la porte, et
 * la porte décide de deux choses.
 *
 * Le quota, d'abord. La publique sert le tunnel de réservation et se protège
 * d'un quota de cent vingt interrogations par minute **et par adresse** ; or une
 * action serveur s'exécute sur le serveur Next, si bien que l'API y voit une
 * seule adresse pour tous les comptoirs de tous les établissements **et** pour
 * tous les visiteurs du tunnel. Le budget aurait donc été partagé par le
 * déploiement entier, et l'épuiser aurait dégradé chaque tiroir en saisie libre
 * d'heure — c'est-à-dire précisément le chemin vers le
 * `SLOT_NO_LONGER_AVAILABLE` que #611 supprime. La route gardée, au seuil
 * `STAFF`, n'en porte aucun.
 *
 * L'établissement, ensuite. Sur la publique, il vient du slug d'URL ; sur la
 * gardée, du jeton — et c'est la discipline de tout le reste du back-office
 * (tenant-isolation §2). `tenantSlug` ne sert donc plus ici qu'à retrouver le
 * cookie de session, comme dans les cinq autres lectures du comptoir.
 *
 * La session était déjà exigée avant ce changement, pour une raison d'écran : un
 * tiroir ouvert sur une session expirée doit partir au renouvellement comme les
 * cinq autres lectures, et non afficher une liste de créneaux au milieu d'un
 * écran qui va se fermer. Elle est désormais exigée pour les deux raisons.
 *
 * ## Ce que la fenêtre vaut
 *
 * Une seule journée civile — celle du champ « Date ». Le tiroir ne propose des
 * heures que pour la journée affichée, et une fenêtre plus large ferait calculer
 * au serveur des journées que personne ne regarde.
 */
export async function loadDeskAvailabilityAction(
  tenantSlug: string,
  query: unknown,
): Promise<AdminActionResult<{ readonly slots: readonly AvailabilitySlot[] }>> {
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (typeof query !== 'object' || query === null) {
    return invalid(t('actions.invalidAvailabilityQuery'));
  }

  const raw: Record<string, unknown> = { ...query };
  // Les champs sont repris un par un — et `day` étalé sur les deux bornes — parce
  // que `availabilityQuerySchema` est `.strict()` : lui passer l'objet du tiroir
  // tel quel ferait refuser la requête sur le nom d'un champ, pas sur son
  // contenu. Les facultatifs sont étalés plutôt que posés à `undefined`, comme
  // partout ailleurs sous `exactOptionalPropertyTypes`.
  const parsed = availabilityQuerySchema.safeParse({
    serviceId: raw.serviceId,
    from: raw.day,
    to: raw.day,
    ...(raw.staffId === undefined ? {} : { staffId: raw.staffId }),
    ...(raw.excludeAppointmentId === undefined
      ? {}
      : { excludeAppointmentId: raw.excludeAppointmentId }),
  });

  if (!parsed.success) {
    return invalid(t('actions.invalidAvailabilityQuery'));
  }

  try {
    const view = await fetchAdminAvailability(access.token, parsed.data);

    // Aplati : la fenêtre ne porte qu'une journée, et rendre le découpage
    // obligerait l'appelant à le défaire pour la seule journée qu'il a demandée.
    return { ok: true, data: { slots: view.days.flatMap((day) => day.slots) } };
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid(t('actions.unknownAppointment'));
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  const parsed = createAppointmentRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(t('actions.invalidAppointment'));
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid(t('actions.unknownAppointment'));
  }

  const parsed = rescheduleAppointmentRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(t('actions.invalidReschedule'));
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
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid(t('actions.unknownAppointment'));
  }

  const parsed = changeAppointmentStatusRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(t('actions.invalidStatus'));
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

/**
 * Annule un rendez-vous depuis le comptoir — #754.
 *
 * ## Pourquoi elle ne passe pas par `markDeskAppointmentStatusAction`
 *
 * `cancelled` n'est pas un statut que `POST /appointments/:id/status` accepte :
 * l'annulation a sa propre route, parce qu'elle a son propre corps — un motif —
 * et parce qu'elle inscrit **qui** l'a décidée. Le passage par la route de
 * statut aurait perdu les deux.
 *
 * ## Ce que cette action ne transmet pas, et ne doit pas transmettre
 *
 * `cancelledBy`. Il se déduit de la porte, côté API : cette route-ci, gardée au
 * seuil `STAFF`, inscrit `STAFF` ; la route publique du tunnel inscrit `CLIENT`.
 * Le `.strict()` de `cancelAppointmentRequestSchema` refuserait de toute façon
 * le champ — c'est ce qui empêche un écran d'attribuer au salon une annulation
 * qu'il n'a pas décidée, donc de fausser le seul chiffre que cette colonne
 * existe pour établir (CDC §1.4).
 *
 * Le motif, lui, est **facultatif** : l'exiger ferait renoncer à l'annulation au
 * téléphone, donc laisserait des créneaux fantômes bloqués. Il est revalidé ici
 * avec le schéma partagé avant d'atteindre l'API — le front valide pour le
 * confort, l'API pour la sécurité (web-frontend §4).
 *
 * ## Ce qu'elle rend, et pourquoi ce n'est pas un `Appointment`
 *
 * La route d'annulation rend un `BookedAppointment` — des identifiants nus et
 * `cancelledBy` —, jamais la ligne d'agenda à *summaries* imbriqués. Le tiroir
 * n'en consomme rien : il recharge la période et se referme. Le type est rendu
 * tel quel plutôt que remodelé, parce qu'un remodelage ici inventerait des noms
 * que la réponse ne porte pas.
 */
export async function cancelDeskAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  payload: unknown,
): Promise<AdminActionResult<BookedAppointment>> {
  const t = await getTranslations('admin-planning');
  const access = await deskToken(tenantSlug);

  if ('refusal' in access) {
    return access.refusal;
  }

  if (!uuidSchema.safeParse(appointmentId).success) {
    return invalid(t('actions.unknownAppointment'));
  }

  const parsed = cancelAppointmentRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return invalid(t('actions.invalidCancelReason'));
  }

  try {
    return {
      ok: true,
      data: await cancelDeskAppointment(access.token, appointmentId, parsed.data),
    };
  } catch (error) {
    return failure(error);
  }
}
