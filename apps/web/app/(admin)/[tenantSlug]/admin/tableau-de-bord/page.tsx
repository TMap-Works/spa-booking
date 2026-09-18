import type { Appointment, CalendarDate, PublicTenant, TimeZone } from '@spa/shared';
import Link from 'next/link';

import { Icon, type IconName } from '@/components/ui/icon';
import {
  fetchAppointmentVolumeReport,
  fetchAppointments,
  fetchNoShowReport,
  fetchOwnProfile,
  fetchPublicTenant,
  fetchRevenueReport,
} from '@/lib/api-client';
import { statusModifier } from '@/lib/admin/calendar-grid';
import { rangeOf, todayInTimeZone } from '@/lib/admin/calendar-range';
import type { AppointmentVolumeReport } from '@/lib/admin/reporting-contract';
import { formatCount, formatRate, revenueByCurrency } from '@/lib/admin/reporting-view';
import { rangeOfPeriod, shortDayLabel, windowOfRange } from '@/lib/admin/reporting-window';
import { appointmentOutcomeLabel } from '@/lib/appointment-status';
import { addCalendarDays } from '@/lib/booking/calendar';
import { formatCalendarDate, formatMoney, formatTimeInTimeZone } from '@/lib/format';
import { initialsOf } from '@/lib/initials';

import { adminClientsPath } from '../clients/paths';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import {
  adminCalendarPath,
  adminCheckoutPath,
  adminDashboardPath,
  adminNewServicePath,
  adminReportingPath,
} from '../paths';
import { adminStaffPath } from '../personnel/paths';

/**
 * Le tableau de bord — l'écran d'arrivée de la gérance.
 *
 * Il répond à la question qu'on se pose en ouvrant le back-office le matin :
 * « qu'est-ce qui m'attend aujourd'hui, et comment va le salon ? ». Quatre
 * indicateurs du jour, les prochains rendez-vous, l'activité de la semaine, et
 * des raccourcis vers les gestes courants.
 *
 * Il ne calcule rien que le reporting ne sache déjà : il lit les mêmes routes
 * (`/reports/*`, `/appointments`) sur des fenêtres plus courtes. Réservé à qui
 * lit le reporting (`reporting:read`) : le sommaire ne le propose qu'à la
 * gérance, et l'API refuse de toute façon les rapports aux autres.
 */

export const dynamic = 'force-dynamic';

/** Combien de rendez-vous à venir la liste montre avant de renvoyer au planning. */
const UPCOMING_LIMIT = 6;

interface DashboardPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

const DENIAL = {
  deniedTitle: 'Accès réservé',
  deniedHint:
    'Le tableau de bord est réservé à la gestion du salon. Le planning reste accessible depuis le menu.',
  failedTitle: 'Tableau de bord indisponible',
};

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminDashboardPath(tenantSlug));

  let tenant: PublicTenant;
  try {
    tenant = await fetchPublicTenant(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, DENIAL);
  }

  const timeZone = tenant.timezone;
  const today = todayInTimeZone(timeZone);
  const week = rangeOfPeriod('sept-jours', timeZone);
  const month = rangeOfPeriod('trente-jours', timeZone);

  let firstName: string | null;
  let appointments: Appointment[];
  let revenueToday: Awaited<ReturnType<typeof fetchRevenueReport>>;
  let revenueWeek: Awaited<ReturnType<typeof fetchRevenueReport>>;
  let volumeWeek: AppointmentVolumeReport;
  let noShows: Awaited<ReturnType<typeof fetchNoShowReport>>;
  try {
    const [profile, ...rest] = await Promise.all([
      fetchOwnProfile(accessToken).catch(() => null),
      fetchAppointments(accessToken, rangeOf('jour', today)),
      fetchRevenueReport(accessToken, windowOfRange({ from: today, to: today }, timeZone)),
      fetchRevenueReport(accessToken, windowOfRange(week, timeZone)),
      fetchAppointmentVolumeReport(accessToken, windowOfRange(week, timeZone), 'day'),
      fetchNoShowReport(accessToken, windowOfRange(month, timeZone)),
    ]);
    firstName = profile?.firstName ?? null;
    [appointments, revenueToday, revenueWeek, volumeWeek, noShows] = rest;
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, DENIAL);
  }

  const now = Date.now();
  const booked = appointments.filter((one) => one.status !== 'cancelled');
  const pending = booked.filter((one) => one.status === 'pending');
  const done = booked.filter((one) => one.status === 'completed');
  const upcoming = booked
    .filter((one) => Date.parse(one.endsAt) > now && one.status !== 'no_show')
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const todayTotals = revenueByCurrency(revenueToday.totals);
  const weekTotals = revenueByCurrency(revenueWeek.totals);

  return (
    <section aria-labelledby="tableau-titre" className="spa-admin-dashboard">
      <header className="spa-admin-dashboard__hero">
        <div className="spa-admin-dashboard__greeting">
          <p className="spa-admin-dashboard__eyebrow">Aujourd’hui · {formatCalendarDate(today)}</p>
          <h1 className="spa-admin__title" id="tableau-titre">
            {firstName === null ? 'Bonjour' : `Bonjour ${firstName}`}
          </h1>
          <p className="spa-admin-dashboard__lead">
            {booked.length === 0
              ? `Aucun rendez-vous au programme de ${tenant.name} aujourd’hui.`
              : `${formatCount(booked.length)} rendez-vous au programme de ${tenant.name} aujourd’hui${
                  pending.length === 0 ? '.' : `, dont ${formatCount(pending.length)} à confirmer.`
                }`}
          </p>
        </div>
        <div className="spa-admin-dashboard__hero-actions">
          <Link className="spa-button spa-button--neutral" href={adminCheckoutPath(tenantSlug)}>
            <Icon name="card" />
            Encaisser
          </Link>
          <Link className="spa-button spa-button--accent" href={adminCalendarPath(tenantSlug)}>
            <Icon name="calendar" />
            Ouvrir le planning
          </Link>
        </div>
      </header>

      <div className="spa-admin-dashboard__kpis">
        <Kpi
          icon="calendar"
          label="Rendez-vous aujourd’hui"
          tone="accent"
          value={formatCount(booked.length)}
          detail={`${formatCount(done.length)} honoré${done.length > 1 ? 's' : ''} · ${formatCount(upcoming.length)} à venir`}
        />
        <Kpi
          icon="card"
          label="Encaissé aujourd’hui"
          tone="success"
          value={
            todayTotals[0] === undefined
              ? formatMoney({ amountMinor: 0, currency: tenant.defaultCurrency })
              : formatMoney({
                  amountMinor: todayTotals[0].netAmountMinor,
                  currency: todayTotals[0].currency,
                })
          }
          detail={
            todayTotals[0] === undefined
              ? 'Aucun encaissement pour l’instant'
              : `${formatCount(todayTotals[0].transactions)} encaissement${todayTotals[0].transactions > 1 ? 's' : ''}`
          }
        />
        <Kpi
          icon="bell"
          label="À confirmer"
          tone="warning"
          value={formatCount(pending.length)}
          detail={pending.length === 0 ? 'Tout est confirmé' : 'Demandes en attente de réponse'}
        />
        <Kpi
          icon="chart"
          label="Non honorés · 30 jours"
          tone="danger"
          value={formatRate(noShows.rate)}
          detail={`${formatCount(noShows.noShows)} sur ${formatCount(noShows.noShows + noShows.honored)} rendez-vous échus`}
        />
      </div>

      <div className="spa-admin-dashboard__grid">
        <section aria-labelledby="tableau-prochains" className="spa-admin__section">
          <div className="spa-admin-dashboard__section-head">
            <h2 className="spa-admin__section-title" id="tableau-prochains">
              Prochains rendez-vous
            </h2>
            <Link className="spa-admin-dashboard__more" href={adminCalendarPath(tenantSlug)}>
              Tout le planning
              <Icon name="arrow" />
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">Plus rien au programme aujourd’hui</p>
              <p className="spa-empty-state__description">
                Les rendez-vous de la journée sont passés. Le planning montre les jours suivants.
              </p>
            </div>
          ) : (
            <ol className="spa-admin-dashboard__agenda" role="list">
              {upcoming.slice(0, UPCOMING_LIMIT).map((appointment) => (
                <UpcomingRow appointment={appointment} key={appointment.id} timeZone={timeZone} />
              ))}
            </ol>
          )}
        </section>

        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="tableau-semaine" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="tableau-semaine">
                Les 7 derniers jours
              </h2>
              <Link className="spa-admin-dashboard__more" href={adminReportingPath(tenantSlug)}>
                Reporting
                <Icon name="arrow" />
              </Link>
            </div>
            <p className="spa-admin-dashboard__week-total">
              <span className="spa-admin-dashboard__week-value">
                {weekTotals[0] === undefined
                  ? formatMoney({ amountMinor: 0, currency: tenant.defaultCurrency })
                  : formatMoney({
                      amountMinor: weekTotals[0].netAmountMinor,
                      currency: weekTotals[0].currency,
                    })}
              </span>
              <span className="spa-admin-dashboard__week-caption">
                encaissés · {formatCount(volumeWeek.total)} rendez-vous
              </span>
            </p>
            <WeekBars from={week.from} volume={volumeWeek} />
          </section>

          <nav aria-labelledby="tableau-raccourcis" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="tableau-raccourcis">
              Raccourcis
            </h2>
            <ul className="spa-admin-dashboard__shortcuts">
              <Shortcut href={adminNewServicePath(tenantSlug)} icon="tag" label="Nouvelle prestation" />
              <Shortcut href={adminClientsPath(tenantSlug)} icon="users" label="Fichier client" />
              <Shortcut href={adminStaffPath(tenantSlug)} icon="team" label="Équipe et horaires" />
              <Shortcut external href={`/${tenantSlug}`} icon="store" label="Ma vitrine" />
            </ul>
          </nav>
        </div>
      </div>
    </section>
  );
}

type KpiTone = 'accent' | 'success' | 'warning' | 'danger';

function Kpi({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: KpiTone;
}) {
  return (
    <div className={`spa-admin-metric spa-admin-dashboard__kpi spa-admin-dashboard__kpi--${tone}`}>
      <span className="spa-admin-dashboard__kpi-head">
        <span className="spa-admin-dashboard__kpi-icon">
          <Icon name={icon} />
        </span>
        <span className="spa-admin-dashboard__kpi-label">{label}</span>
      </span>
      <span className="spa-admin-metric__value">{value}</span>
      <span className="spa-admin-metric__label">{detail}</span>
    </div>
  );
}

function UpcomingRow({
  appointment,
  timeZone,
}: {
  readonly appointment: Appointment;
  readonly timeZone: TimeZone;
}) {
  const client = `${appointment.client.firstName} ${appointment.client.lastName}`;
  const minutes = Math.round(
    (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000,
  );
  return (
    <li className="spa-admin-dashboard__slot">
      <span className="spa-admin-dashboard__time">
        <strong>{formatTimeInTimeZone(appointment.startsAt, timeZone)}</strong>
        <span>{minutes} min</span>
      </span>
      <span aria-hidden="true" className="spa-admin-dashboard__avatar">
        {initialsOf(client)}
      </span>
      <span className="spa-admin-dashboard__who">
        <strong>{client}</strong>
        <span>
          {appointment.service.name} · {appointment.staff.displayName}
        </span>
      </span>
      <span className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}>
        {appointmentOutcomeLabel(appointment)}
      </span>
    </li>
  );
}

/** Sept barres, une par jour, hautes du nombre de rendez-vous. */
function WeekBars({
  from,
  volume,
}: {
  readonly from: CalendarDate;
  readonly volume: AppointmentVolumeReport;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(from, index));
  const counts = days.map((day) => volume.rows.find((row) => row.key === day)?.total ?? 0);
  const peak = Math.max(1, ...counts);
  return (
    <ol aria-label="Rendez-vous par jour" className="spa-admin-dashboard__bars" role="list">
      {days.map((day, index) => {
        const count = counts[index] ?? 0;
        return (
          <li className="spa-admin-dashboard__bar" key={day}>
            <span className="spa-admin-dashboard__bar-value">{count}</span>
            <span className="spa-admin-dashboard__bar-track">
              <span
                className="spa-admin-dashboard__bar-fill"
                style={{ blockSize: `${Math.max(4, Math.round((count / peak) * 100))}%` }}
              />
            </span>
            <span className="spa-admin-dashboard__bar-label">{shortDayLabel(day)}</span>
            <span className="spa-visually-hidden">
              {` : ${count} rendez-vous le ${formatCalendarDate(day)}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Shortcut({
  href,
  icon,
  label,
  external = false,
}: {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly external?: boolean;
}) {
  return (
    <li>
      <Link
        className="spa-admin-dashboard__shortcut"
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener' } : {})}
      >
        <span className="spa-admin-dashboard__shortcut-icon">
          <Icon name={icon} />
        </span>
        <span>{label}</span>
        {external ? <span className="spa-visually-hidden"> (nouvel onglet)</span> : null}
        <Icon className="spa-admin-dashboard__shortcut-arrow" name="arrow" />
      </Link>
    </li>
  );
}
