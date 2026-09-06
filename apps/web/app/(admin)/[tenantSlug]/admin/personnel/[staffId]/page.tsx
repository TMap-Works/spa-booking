import {
  hasAtLeastRole,
  type AvailabilityResponse,
  type SessionUser,
  type StaffMember,
  type StaffSchedule,
  type StaffTimeOff,
} from '@spa/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ApiClientError,
  fetchAvailability,
  fetchOwnProfile,
  fetchServiceStaff,
  fetchServices,
  fetchStaffMembers,
  fetchStaffSchedule,
  fetchStaffTimeOff,
} from '@/lib/api-client';
import { todayInTimeZone } from '@/lib/admin/calendar-range';
import { staffInitials } from '@/lib/admin/staff-directory';
import { timeOffWindow } from '@/lib/admin/staff-time-off';
import { addCalendarDays } from '@/lib/booking/calendar';
import { formatCalendarDate, formatTimeInTimeZone } from '@/lib/format';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { StaffScheduleEditor } from '../components/staff-schedule-editor';
import { StaffServicesPanel, type StaffServiceChoice } from '../components/staff-services-panel';
import { StaffTimeOffPanel } from '../components/staff-time-off-panel';
import { adminStaffMemberPath, adminStaffPath } from '../paths';

/**
 * La fiche d'un praticien — horaires, absences, prestations (#53, critères 2 à 5).
 *
 * ## Ce que cette page prouve, et qu'aucun test ne prouve à sa place
 *
 * Le cinquième critère — « les modifications se reflètent immédiatement dans les
 * créneaux proposés » — est le seul qui ne se vérifie pas en lisant du code. La
 * page rend donc, à côté de la grille, **les créneaux réellement calculés** par
 * le moteur pour ce praticien, lus par la route publique de disponibilité. Les
 * actions d'écriture périment cette page (`revalidatePath`), si bien qu'un
 * horaire enregistré ou un congé posé déplace visiblement cette liste, sans
 * recharger la fenêtre.
 *
 * Ce n'est pas un doublon du planning : le planning montre les rendez-vous
 * **pris**, celui-ci montre les créneaux **libres**, c'est-à-dire l'effet direct
 * de ce qui vient d'être saisi juste au-dessus.
 *
 * ## La fenêtre d'absences est bornée, et elle doit l'être
 *
 * `GET /v1/staff-time-off` exige `from` et `to`, bornés à un an : sans eux, un
 * salon de dix ans d'historique rendrait dix ans d'absences à chaque ouverture.
 * Six mois couvrent le horizon de réservation d'un spa sans faire de cette fiche
 * une archive.
 *
 * ## Pourquoi une lecture par prestation
 *
 * L'API relie praticien et prestation dans un seul sens —
 * `GET /v1/services/{id}/staff`. Il n'existe pas de « prestations de ce
 * praticien », et le catalogue public, qui porterait l'information, omet les
 * prestations désactivées et les praticiens suspendus : s'en servir ici ferait
 * disparaître une affectation qu'on vient précisément consulter pour la
 * corriger. Les lectures partent donc en parallèle, une par prestation, sur un
 * catalogue de back-office dont la taille est bornée par ce que le salon vend.
 */

export const dynamic = 'force-dynamic';

/** Six mois d'absences — l'horizon d'un planning de salon, pas une archive. */
const TIME_OFF_WINDOW_DAYS = 180;

/** Une semaine de créneaux : de quoi voir l'effet d'une saisie, sans plus. */
const AVAILABILITY_PREVIEW_DAYS = 7;

interface StaffMemberPageProps {
  readonly params: Promise<{ readonly tenantSlug: string; readonly staffId: string }>;
}

export default async function StaffMemberPage({ params }: StaffMemberPageProps) {
  const { tenantSlug, staffId } = await params;
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminStaffMemberPath(tenantSlug, staffId),
  );

  let profile: SessionUser | undefined;
  let member: StaffMember | undefined;
  let schedule: StaffSchedule | undefined;
  let timeOff: readonly StaffTimeOff[] = [];
  let services: readonly StaffServiceChoice[] = [];
  let availability: AvailabilityResponse | null = null;
  let loadError: unknown = null;

  try {
    // Le rôle, la fiche et sa semaine partent ensemble : elles ne dépendent pas
    // les unes des autres, et les enchaîner ajouterait deux allers-retours à
    // l'ouverture.
    const [loadedProfile, members, loadedSchedule] = await Promise.all([
      fetchOwnProfile(accessToken),
      fetchStaffMembers(accessToken),
      fetchStaffSchedule(accessToken, staffId),
    ]);

    profile = loadedProfile;
    member = members.find((candidate) => candidate.id === staffId);
    schedule = loadedSchedule;

    if (member !== undefined) {
      const timezone = loadedSchedule.timezone;
      const today = todayInTimeZone(timezone);
      const catalog = await fetchServices(accessToken);

      const [absences, assignments] = await Promise.all([
        fetchStaffTimeOff(accessToken, {
          staffId,
          ...timeOffWindow(today, TIME_OFF_WINDOW_DAYS, timezone),
        }),
        Promise.all(catalog.map((service) => fetchServiceStaff(accessToken, service.id))),
      ]);

      timeOff = absences;
      services = catalog.map((service, index) => ({
        id: service.id,
        name: service.name,
        isActive: service.isActive,
        assigned: (assignments[index] ?? []).some((assigned) => assigned.id === staffId),
      }));

      const preview = services.find((service) => service.assigned && service.isActive);

      if (preview !== undefined) {
        // Cette lecture-ci a son propre `try` : c'est un aperçu, et la route
        // publique rend **404** pour une prestation retirée du catalogue entre
        // les deux appels. Laissée dans le `try` d'ensemble, ce 404-là passerait
        // pour « ce praticien n'existe pas » et la fiche entière disparaîtrait
        // derrière un `notFound()`.
        try {
          availability = await fetchAvailability(tenantSlug, {
            serviceId: preview.id,
            staffId,
            from: today,
            to: addCalendarDays(today, AVAILABILITY_PREVIEW_DAYS - 1),
          });
        } catch {
          availability = null;
        }
      }
    }
  } catch (error) {
    loadError = error;
  }

  // `notFound()` et `redirect()` lèvent : ils sont appelés **hors** du `try`,
  // sans quoi le `catch` avalerait la navigation qu'ils déclenchent et la page
  // rendrait une erreur à la place d'un 404.
  if (loadError instanceof ApiClientError && loadError.status === 404) {
    notFound();
  }

  if (loadError !== null) {
    return adminLoadFailure(loadError, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Les horaires du personnel sont réservés aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Fiche indisponible',
    });
  }

  // Une fiche absente de la liste de l'établissement est une fiche d'un autre
  // établissement, ou une fiche supprimée : les deux se répondent **404**,
  // indistinctement (tenant-isolation §4).
  if (member === undefined || schedule === undefined || profile === undefined) {
    notFound();
  }

  const timezone = schedule.timezone;
  const today = todayInTimeZone(timezone);
  // La fenêtre interrogée est `[aujourd'hui, aujourd'hui + 180[`, borne haute
  // exclue : le dernier jour qu'elle couvre est le 179e, et annoncer le 180e
  // ferait chercher une absence que la liste ne contient pas.
  const lastDay = addCalendarDays(today, TIME_OFF_WINDOW_DAYS - 1);
  const previewService = services.find((service) => service.assigned && service.isActive);
  /*
   * Le rang qui **écrit** sur cette fiche, et il n'est pas celui qui l'ouvre.
   *
   * `PUT /v1/staff/:id/schedule`, `POST` et `DELETE /v1/staff-time-off` et
   * l'affectation d'une prestation sont toutes `@AuthAtLeast('MANAGER')`, quand
   * la lecture s'ouvre dès le rang praticien. Sans cette borne, un compte
   * `staff` obtenait la grille et ses boutons — et un 403 à chaque
   * enregistrement. Comme sur la liste du personnel, ce filtrage ne protège
   * rien : la seule garde qui compte est celle de l'API.
   */
  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="praticien-titre">
      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminStaffPath(tenantSlug)}>
          ← Personnel
        </Link>
      </div>

      <h1 className="spa-admin__title" id="praticien-titre">
        <span aria-hidden="true" className="spa-admin-staff__initials">
          {staffInitials(member.displayName)}
        </span>{' '}
        {member.displayName}
      </h1>

      {member.isActive ? null : (
        <p className="spa-admin-toolbar__hint">
          Cette fiche est suspendue&nbsp;: aucun créneau n’est proposé pour ce praticien, quels que
          soient les horaires ci-dessous.
        </p>
      )}

      {/* Pas de `spa-admin__split` ici : sa première colonne est bornée à 22 rem
          — elle est faite pour une liste, pas pour une grille de sept jours à
          deux champs horaires. La semaine y repliait chaque plage sur trois
          lignes. Les sections s'empilent donc sur toute la largeur, dans l'ordre
          où on les remplit : les horaires, puis ce qu'ils produisent. */}
      <StaffScheduleEditor
        canManage={canManage}
        schedule={schedule}
        staffId={member.id}
        tenantSlug={tenantSlug}
      />

      <section className="spa-admin__section" aria-labelledby="creneaux-titre">
        <h2 className="spa-admin__section-title" id="creneaux-titre">
          Créneaux proposés
        </h2>
        <p className="spa-admin-toolbar__hint">
          {previewService === undefined
            ? 'Affectez une prestation active pour voir ce que le moteur propose.'
            : `Prochains créneaux libres pour « ${previewService.name} », tels que la page de réservation les calcule.`}
        </p>

        {availability === null || availability.days.every((day) => day.slots.length === 0) ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun créneau sur les sept prochains jours</p>
            <p className="spa-empty-state__description">
              Une semaine de travail vide, une fiche suspendue, une prestation non affectée ou un
              congé couvrant la période produisent tous ce résultat.
            </p>
          </div>
        ) : (
          <ul className="spa-admin-schedule__exceptions">
            {availability.days
              .filter((day) => day.slots.length > 0)
              .map((day) => (
                <li className="spa-admin-schedule__exception" key={day.date}>
                  <span className="spa-admin-schedule__exception-date">
                    {formatCalendarDate(day.date)}
                  </span>
                  <span className="spa-admin-schedule__exception-label">
                    {day.slots
                      .slice(0, 6)
                      .map((slot) => formatTimeInTimeZone(slot.startsAt, availability.timezone))
                      .join(' · ')}
                    {day.slots.length > 6 ? ` … ${String(day.slots.length)} au total` : ''}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <StaffTimeOffPanel
        canManage={canManage}
        staffId={member.id}
        tenantSlug={tenantSlug}
        timeOff={timeOff}
        timeZone={timezone}
        windowLabel={`Absences du ${formatCalendarDate(today)} au ${formatCalendarDate(lastDay)}.`}
      />

      <StaffServicesPanel
        canManage={canManage}
        services={services}
        staffId={member.id}
        tenantSlug={tenantSlug}
      />
    </section>
  );
}
