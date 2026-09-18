import {
  ERROR_CODES,
  type CalendarDate,
  type MyStaffAgenda,
  type MyStaffAppointment,
  type MyStaffProfile,
  type MyStaffSchedule,
} from '@spa/shared';
import Link from 'next/link';

import { NavTabs } from '@/components/ui/nav-tabs';
import {
  ApiClientError,
  fetchMyAgenda,
  fetchMySchedule,
  fetchMyStaffProfile,
  fetchPublicTenant,
} from '@/lib/api-client';
import { parseCalendarDate, todayInTimeZone } from '@/lib/admin/calendar-range';
import { statusModifier } from '@/lib/admin/calendar-grid';
import {
  MY_PLANNING_VIEW_LABELS,
  MY_PLANNING_VIEWS,
  appointmentsByDay,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  parseMyPlanningView,
  planningRange,
  shiftPlanningAnchor,
  upcomingOnly,
  workingDay,
  type MyPlanningView,
} from '@/lib/admin/my-planning';
import { APPOINTMENT_STATUS_LABELS } from '@/lib/appointment-status';
import { formatCalendarDate, formatDuration, formatTimeInTimeZone } from '@/lib/format';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { MyAppointmentActions, MyPlanningAutoRefresh } from '../components/my-planning-client';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { loadAdminShell } from '../layout';
import { adminCalendarPath, adminMyPlanningPath } from '../paths';

/**
 * « Mon planning » — l'emploi du temps du praticien connecté (#813).
 *
 * ## Ce que l'écran montre, et d'où il le tient
 *
 * Ses rendez-vous (`GET /v1/me/appointments`), ses horaires, ses absences et
 * les jours de fermeture du salon (`GET /v1/me/schedule`) — **les siens
 * seulement** : les routes `me` résolvent la fiche par le jeton, aucun
 * identifiant n'y entre. C'est l'arbitrage du PO du 16/09 : « le praticien ne
 * voit que son propre planning ».
 *
 * ## Pensé pour le téléphone d'abord
 *
 * Une liste par journée plutôt qu'une grille horaire : entre deux soins, la
 * praticienne veut savoir **qui** vient **quand**, pas mesurer des colonnes.
 * Un appui sur un rendez-vous déplie son détail — référence, notes, gestes.
 *
 * ## Trois vues
 *
 * Jour (par défaut), Semaine, et « À venir » : les trente et un prochains
 * jours, rendez-vous encore attendus seulement. Vue et date sont dans
 * l'adresse, pour qu'un rafraîchissement ne ramène pas à aujourd'hui.
 */

export const dynamic = 'force-dynamic';

interface MyPlanningPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{
    readonly vue?: string;
    readonly date?: string;
    readonly session?: string | readonly string[];
  }>;
}

function periodLabel(view: MyPlanningView, from: CalendarDate, to: CalendarDate): string {
  if (view === 'jour') {
    return formatCalendarDate(from);
  }
  if (view === 'semaine') {
    return `Du ${formatCalendarDate(from)} au ${formatCalendarDate(to)}`;
  }
  return 'Les 31 prochains jours';
}

export default async function MyPlanningPage({ params, searchParams }: MyPlanningPageProps) {
  const { tenantSlug } = await params;
  const query = await searchParams;
  const view = parseMyPlanningView(query.vue);
  const requested = parseCalendarDate(query.date);
  const here = adminMyPlanningPath(tenantSlug, {
    view,
    ...(requested === null ? {} : { date: requested }),
  });
  const renewal = { returnTo: here, attempted: isRenewalReturn(query[RENEWAL_PARAM]) };
  const accessToken = await requireAdminAccessToken(tenantSlug, here);

  // Le fuseau du salon, déjà lu par le layout ; relu de la vitrine si le shell
  // n'a pas pu le dire. La journée par défaut est **celle du salon**.
  const shell = await loadAdminShell(tenantSlug);
  let timeZone = shell?.timeZone ?? null;

  let profile: MyStaffProfile;
  let agenda: MyStaffAgenda;
  let schedule: MyStaffSchedule;

  try {
    timeZone ??= (await fetchPublicTenant(tenantSlug)).timezone;
    const today = todayInTimeZone(timeZone);
    const range = planningRange(view, requested ?? today, today);

    [profile, agenda, schedule] = await Promise.all([
      fetchMyStaffProfile(accessToken),
      fetchMyAgenda(accessToken, range),
      fetchMySchedule(accessToken, range),
    ]);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === ERROR_CODES.STAFF_PROFILE_NOT_FOUND) {
      return (
        <section aria-labelledby="mon-planning-titre" className="spa-my-planning">
          <h1 className="spa-admin__title" id="mon-planning-titre">
            Mon planning
          </h1>
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Pas encore de fiche praticien</p>
            <p className="spa-empty-state__description">
              Votre compte n’est rattaché à aucune fiche praticien : aucun rendez-vous ne peut vous
              être attribué. Demandez à la gérance de créer votre fiche dans « Personnel ».
            </p>
            {shell?.permissions?.includes('agenda:read:all') === true ? (
              <Link className="spa-button spa-button--neutral" href={adminCalendarPath(tenantSlug)}>
                <span className="spa-button__label">Ouvrir le planning du salon</span>
              </Link>
            ) : null}
          </div>
        </section>
      );
    }
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint: 'Ce compte n’a pas d’agenda à consulter dans ce salon.',
      failedTitle: 'Planning indisponible',
      renewal,
    });
  }

  const zone = agenda.timezone;
  const now = new Date();
  const today = todayInTimeZone(zone);
  const anchor = requested ?? today;
  const byDay = appointmentsByDay(
    view === 'a-venir' ? upcomingOnly(agenda.appointments, now) : agenda.appointments,
    zone,
  );
  const days =
    view === 'a-venir' ? [...byDay.keys()] : daysOf(agenda.from, agenda.to);

  return (
    <section aria-labelledby="mon-planning-titre" className="spa-my-planning">
      <MyPlanningAutoRefresh />

      <header className="spa-my-planning__head">
        <span className="spa-my-planning__who">{profile.displayName}</span>
        <h1 className="spa-admin__title" id="mon-planning-titre">
          Mon planning
        </h1>
        <p className="spa-my-planning__period">{periodLabel(view, agenda.from, agenda.to)}</p>
      </header>

      <NavTabs
        items={MY_PLANNING_VIEWS.map((candidate) => ({
          href: adminMyPlanningPath(tenantSlug, {
            view: candidate,
            ...(requested === null || candidate === 'a-venir' ? {} : { date: requested }),
          }),
          label: MY_PLANNING_VIEW_LABELS[candidate],
          current: candidate === view,
        }))}
        label="Vue du planning"
      />

      {view === 'a-venir' ? null : (
        <nav aria-label="Période" className="spa-my-planning__nav">
          <Link
            className="spa-button spa-button--neutral"
            href={adminMyPlanningPath(tenantSlug, {
              view,
              date: shiftPlanningAnchor(view, anchor, -1),
            })}
          >
            <span aria-hidden="true">‹</span>
            <span className="spa-visually-hidden">
              {view === 'semaine' ? 'Semaine précédente' : 'Jour précédent'}
            </span>
          </Link>
          <Link className="spa-button spa-button--quiet" href={adminMyPlanningPath(tenantSlug, { view })}>
            Aujourd’hui
          </Link>
          <Link
            className="spa-button spa-button--neutral"
            href={adminMyPlanningPath(tenantSlug, {
              view,
              date: shiftPlanningAnchor(view, anchor, 1),
            })}
          >
            <span aria-hidden="true">›</span>
            <span className="spa-visually-hidden">
              {view === 'semaine' ? 'Semaine suivante' : 'Jour suivant'}
            </span>
          </Link>
        </nav>
      )}

      {days.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Rien de prévu pour l’instant</p>
          <p className="spa-empty-state__description">
            Aucun rendez-vous ne vous attend dans les 31 prochains jours. Les nouvelles réservations
            apparaissent ici d’elles-mêmes.
          </p>
        </div>
      ) : (
        <div className="spa-my-planning__days">
          {days.map((day) => (
            <MyDay
              appointments={byDay.get(day) ?? []}
              day={day}
              key={day}
              now={now}
              schedule={schedule}
              showSchedule={view !== 'a-venir'}
              tenantSlug={tenantSlug}
              today={today}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Une journée : ses horaires, ses absences, puis ses rendez-vous. */
function MyDay({
  appointments,
  day,
  now,
  schedule,
  showSchedule,
  tenantSlug,
  today,
}: {
  readonly appointments: readonly MyStaffAppointment[];
  readonly day: CalendarDate;
  readonly now: Date;
  readonly schedule: MyStaffSchedule;
  readonly showSchedule: boolean;
  readonly tenantSlug: string;
  readonly today: CalendarDate;
}) {
  const bounds = dayBoundsInTimeZone(day, schedule.timezone);
  const work = workingDay(schedule, day, bounds.start, bounds.end);
  const headingId = `jour-${day}`;

  return (
    <section aria-labelledby={headingId} className="spa-my-day">
      <header className="spa-my-day__head">
        <h2 className="spa-my-day__title" id={headingId}>
          {formatCalendarDate(day)}
          {day === today ? <span className="spa-my-day__today">Aujourd’hui</span> : null}
        </h2>
        {showSchedule ? (
          <p className="spa-my-day__hours">
            {work.closed
              ? 'Salon fermé'
              : work.hours.length === 0
                ? 'Pas de plage de travail'
                : work.hours.join(' · ')}
          </p>
        ) : null}
        {work.absences.map((absence) => (
          <p className="spa-my-day__absence" key={absence}>
            Absence : {absence}
          </p>
        ))}
      </header>

      {appointments.length === 0 ? (
        <p className="spa-my-day__empty">Aucun rendez-vous.</p>
      ) : (
        <ol className="spa-my-day__list" role="list">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <MyAppointment
                appointment={appointment}
                now={now}
                tenantSlug={tenantSlug}
                timeZone={schedule.timezone}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Un rendez-vous — l'essentiel à l'œil, le détail à l'appui (`<details>`,
 * natif : clavier, lecteur d'écran et tactile viennent avec).
 */
function MyAppointment({
  appointment,
  now,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: MyStaffAppointment;
  readonly now: Date;
  readonly tenantSlug: string;
  readonly timeZone: string;
}) {
  const cancelled = appointment.status === 'cancelled';

  return (
    <details className={`spa-my-appointment${cancelled ? ' spa-my-appointment--cancelled' : ''}`}>
      <summary className="spa-my-appointment__summary">
        <span className="spa-my-appointment__time">
          <strong>{formatTimeInTimeZone(appointment.startsAt, timeZone)}</strong>
          <span>{formatTimeInTimeZone(appointment.endsAt, timeZone)}</span>
        </span>
        <span className="spa-my-appointment__what">
          <strong>{appointment.service.name}</strong>
          <span>
            {clientLabel(appointment)} · {formatDuration(appointment.service.durationMinutes)}
          </span>
        </span>
        <span className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}>
          {APPOINTMENT_STATUS_LABELS[appointment.status]}
        </span>
      </summary>
      <div className="spa-my-appointment__details">
        <dl className="spa-my-appointment__facts">
          <div>
            <dt>Référence</dt>
            <dd>{appointment.reference}</dd>
          </div>
          <div>
            <dt>Note de la cliente</dt>
            <dd>{appointment.clientNote ?? 'Aucune'}</dd>
          </div>
          {appointment.staffNote === undefined ? null : (
            <div>
              <dt>Note interne</dt>
              <dd>{appointment.staffNote}</dd>
            </div>
          )}
        </dl>
        <MyAppointmentActions
          appointmentId={appointment.id}
          started={Date.parse(appointment.startsAt) <= now.getTime()}
          status={appointment.status}
          tenantSlug={tenantSlug}
        />
      </div>
    </details>
  );
}
