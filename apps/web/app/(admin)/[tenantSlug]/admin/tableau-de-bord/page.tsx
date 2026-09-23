import type { Appointment, CalendarDate, PublicTenant, TimeZone } from '@spa/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

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
import { rangeOfPeriod, windowOfRange } from '@/lib/admin/reporting-window';
import { appointmentOutcomeLabel } from '@/lib/appointment-status';
import { addCalendarDays } from '@/lib/booking/calendar';
import {
  formatCalendarDate,
  formatMoney,
  formatTimeInTimeZone,
  formattingLocale,
  type DisplayLocale,
} from '@/lib/format';
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
 *
 * ## La langue (#1104)
 *
 * Tous les mots viennent du namespace `admin-dashboard`. Les chiffres, eux,
 * suivent deux règles distinctes qu'il ne faut pas confondre :
 *
 * - **la langue** décide de la façon d'écrire — séparateur de milliers, symbole
 *   de devise, nom du jour. Elle vient de la session (`getLocale`), et la
 *   **région** du pays de l'établissement (`Tenant.address.country`), comme
 *   partout dans l'épique #843 : un salon montréalais écrit ses dates comme le
 *   Québec, en français comme en anglais ;
 * - **le fuseau** décide de l'heure qu'il est, et il reste celui de
 *   l'établissement (`Tenant.timezone`). C'est la règle de `CLAUDE.md` : stockage
 *   en UTC, conversion à l'affichage dans le fuseau du tenant. La journée que cet
 *   écran résume est celle que l'équipe travaille, jamais celle du navigateur qui
 *   la regarde.
 *
 * Les accords de nombre passent par des formes plurielles ICU (`{count, plural,
 * …}`) plutôt que par un `s` ajouté en JavaScript : « 1 encaissement » et
 * « 1 payment » ne se pluralisent pas aux mêmes seuils, et un ternaire sur
 * `> 1` est une règle française déguisée en code.
 */

export const dynamic = 'force-dynamic';

/** Combien de rendez-vous à venir la liste montre avant de renvoyer au planning. */
const UPCOMING_LIMIT = 6;

/** Combien de barres l'activité de la semaine trace — une par jour. */
const WEEK_DAYS = 7;

type DashboardTranslator = Awaited<ReturnType<typeof getTranslations<'admin-dashboard'>>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-dashboard');

  return { title: t('metadata.title') };
}

interface DashboardPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tenantSlug } = await params;
  const t = await getTranslations('admin-dashboard');
  const locale = await getLocale();
  const accessToken = await requireAdminAccessToken(tenantSlug, adminDashboardPath(tenantSlug));

  const denial = {
    deniedTitle: t('denied.title'),
    deniedHint: t('denied.hint'),
    failedTitle: t('denied.failedTitle'),
  };

  let tenant: PublicTenant;
  try {
    tenant = await fetchPublicTenant(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, denial);
  }

  const timeZone = tenant.timezone;
  // Le pays de l'établissement — la **région** des formats, lue sur l'adresse
  // publiée. Il ne touche pas au fuseau : la langue et la région disent comment
  // une heure s'écrit, jamais quelle heure il est.
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };
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
    return adminLoadFailure(error, tenantSlug, denial);
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
          <p className="spa-admin-dashboard__eyebrow">
            {t('hero.eyebrow', { date: formatCalendarDate(today, display) })}
          </p>
          <h1 className="spa-admin__title" id="tableau-titre">
            {firstName === null ? t('hero.greeting') : t('hero.greetingNamed', { firstName })}
          </h1>
          <p className="spa-admin-dashboard__lead">
            {pending.length === 0
              ? t('hero.lead', { count: booked.length, salon: tenant.name })
              : t('hero.leadPending', {
                  count: booked.length,
                  pending: formatCount(pending.length, display),
                  salon: tenant.name,
                })}
          </p>
        </div>
        <div className="spa-admin-dashboard__hero-actions">
          <Link className="spa-button spa-button--neutral" href={adminCheckoutPath(tenantSlug)}>
            <Icon name="card" />
            {t('hero.checkout')}
          </Link>
          <Link className="spa-button spa-button--accent" href={adminCalendarPath(tenantSlug)}>
            <Icon name="calendar" />
            {t('hero.openCalendar')}
          </Link>
        </div>
      </header>

      <div className="spa-admin-dashboard__kpis">
        <Kpi
          icon="calendar"
          label={t('kpi.appointments.label')}
          tone="accent"
          value={formatCount(booked.length, display)}
          detail={t('kpi.appointments.detail', {
            done: done.length,
            upcoming: formatCount(upcoming.length, display),
          })}
        />
        <Kpi
          icon="card"
          label={t('kpi.revenue.label')}
          tone="success"
          value={
            todayTotals[0] === undefined
              ? formatMoney({ amountMinor: 0, currency: tenant.defaultCurrency }, display)
              : formatMoney(
                  {
                    amountMinor: todayTotals[0].netAmountMinor,
                    currency: todayTotals[0].currency,
                  },
                  display,
                )
          }
          detail={
            todayTotals[0] === undefined
              ? t('kpi.revenue.detailEmpty')
              : t('kpi.revenue.detail', { count: todayTotals[0].transactions })
          }
        />
        <Kpi
          icon="bell"
          label={t('kpi.pending.label')}
          tone="warning"
          value={formatCount(pending.length, display)}
          detail={pending.length === 0 ? t('kpi.pending.detailNone') : t('kpi.pending.detail')}
        />
        <Kpi
          icon="chart"
          label={t('kpi.noShow.label')}
          tone="danger"
          value={formatRate(noShows.rate, display)}
          detail={t('kpi.noShow.detail', {
            noShows: formatCount(noShows.noShows, display),
            // Le dénominateur porte le nom : il passe donc en nombre, et c'est la
            // forme plurielle ICU qui accorde « rendez-vous échu » — « 1 sur 1
            // rendez-vous échus » était un accord faux, et « 1 of 1 appointments »
            // un anglais faux.
            total: noShows.noShows + noShows.honored,
          })}
        />
      </div>

      <div className="spa-admin-dashboard__grid">
        <section aria-labelledby="tableau-prochains" className="spa-admin__section">
          <div className="spa-admin-dashboard__section-head">
            <h2 className="spa-admin__section-title" id="tableau-prochains">
              {t('upcoming.title')}
            </h2>
            <Link className="spa-admin-dashboard__more" href={adminCalendarPath(tenantSlug)}>
              {t('upcoming.more')}
              <Icon name="arrow" />
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">{t('upcoming.emptyTitle')}</p>
              <p className="spa-empty-state__description">{t('upcoming.emptyBody')}</p>
            </div>
          ) : (
            <ol className="spa-admin-dashboard__agenda" role="list">
              {upcoming.slice(0, UPCOMING_LIMIT).map((appointment) => (
                <UpcomingRow
                  appointment={appointment}
                  display={display}
                  key={appointment.id}
                  t={t}
                  timeZone={timeZone}
                />
              ))}
            </ol>
          )}
        </section>

        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="tableau-semaine" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="tableau-semaine">
                {t('week.title')}
              </h2>
              <Link className="spa-admin-dashboard__more" href={adminReportingPath(tenantSlug)}>
                {t('week.more')}
                <Icon name="arrow" />
              </Link>
            </div>
            <p className="spa-admin-dashboard__week-total">
              <span className="spa-admin-dashboard__week-value">
                {weekTotals[0] === undefined
                  ? formatMoney({ amountMinor: 0, currency: tenant.defaultCurrency }, display)
                  : formatMoney(
                      {
                        amountMinor: weekTotals[0].netAmountMinor,
                        currency: weekTotals[0].currency,
                      },
                      display,
                    )}
              </span>
              <span className="spa-admin-dashboard__week-caption">
                {t('week.caption', { count: volumeWeek.total })}
              </span>
            </p>
            <WeekBars display={display} from={week.from} t={t} volume={volumeWeek} />
          </section>

          <nav aria-labelledby="tableau-raccourcis" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="tableau-raccourcis">
              {t('shortcuts.title')}
            </h2>
            <ul className="spa-admin-dashboard__shortcuts">
              <Shortcut
                href={adminNewServicePath(tenantSlug)}
                icon="tag"
                label={t('shortcuts.newService')}
              />
              <Shortcut
                href={adminClientsPath(tenantSlug)}
                icon="users"
                label={t('shortcuts.clients')}
              />
              <Shortcut href={adminStaffPath(tenantSlug)} icon="team" label={t('shortcuts.staff')} />
              <Shortcut
                external
                externalHint={t('shortcuts.newTab')}
                href={`/${tenantSlug}`}
                icon="store"
                label={t('shortcuts.storefront')}
              />
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
  display,
  t,
  timeZone,
}: {
  readonly appointment: Appointment;
  readonly display: DisplayLocale;
  readonly t: DashboardTranslator;
  readonly timeZone: TimeZone;
}) {
  const client = `${appointment.client.firstName} ${appointment.client.lastName}`;
  const minutes = Math.round(
    (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000,
  );
  return (
    <li className="spa-admin-dashboard__slot">
      <span className="spa-admin-dashboard__time">
        <strong>{formatTimeInTimeZone(appointment.startsAt, timeZone, display)}</strong>
        <span>{t('upcoming.duration', { minutes })}</span>
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
        {appointmentOutcomeLabel(appointment, 'desk', display.locale)}
      </span>
    </li>
  );
}

/**
 * L'abscisse d'une barre — « 3 sept. », « Sep 3 », selon la langue et la région.
 *
 * Écrite ici et non lue de `lib/admin/reporting-window.ts`, dont `shortDayLabel`
 * fixe encore `fr-FR` : ce module est **hors de l'empreinte de ce ticket**, que
 * la vague de l'épique #843 a découpée écran par écran pour mener les tickets de
 * front. La revue de #1104 a proposé d'y ajouter le paramètre de langue et de
 * n'avoir qu'une écriture de cette abscisse ; c'est le bon geste, mais il
 * appartient au ticket du reporting (#851) — une issue de suivi le porte.
 *
 * `timeZone: 'UTC'` pour la même raison que `formatCalendarDate` : une date
 * civile **est déjà** celle de l'établissement, et la reprojeter dans son fuseau
 * la décalerait d'un jour sous certains décalages.
 */
function barDayLabel(day: CalendarDate, display: DisplayLocale): string {
  return new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T00:00:00Z`));
}

/** Sept barres, une par jour, hautes du nombre de rendez-vous. */
function WeekBars({
  display,
  from,
  t,
  volume,
}: {
  readonly display: DisplayLocale;
  readonly from: CalendarDate;
  readonly t: DashboardTranslator;
  readonly volume: AppointmentVolumeReport;
}) {
  const days = Array.from({ length: WEEK_DAYS }, (_, index) => addCalendarDays(from, index));
  const counts = days.map((day) => volume.rows.find((row) => row.key === day)?.total ?? 0);
  const peak = Math.max(1, ...counts);
  return (
    <ol aria-label={t('week.barsLabel')} className="spa-admin-dashboard__bars" role="list">
      {days.map((day, index) => {
        const count = counts[index] ?? 0;
        return (
          <li className="spa-admin-dashboard__bar" key={day}>
            <span className="spa-admin-dashboard__bar-value">{formatCount(count, display)}</span>
            <span className="spa-admin-dashboard__bar-track">
              <span
                className="spa-admin-dashboard__bar-fill"
                style={{ blockSize: `${Math.max(4, Math.round((count / peak) * 100))}%` }}
              />
            </span>
            <span className="spa-admin-dashboard__bar-label">{barDayLabel(day, display)}</span>
            <span className="spa-visually-hidden">
              {t('week.barDescription', { count, date: formatCalendarDate(day, display) })}
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
  externalHint = '',
}: {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly external?: boolean;
  /** Ce que le lecteur d'écran entend en plus, quand le lien ouvre un onglet. */
  readonly externalHint?: string;
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
        {external ? <span className="spa-visually-hidden">{externalHint}</span> : null}
        <Icon className="spa-admin-dashboard__shortcut-arrow" name="arrow" />
      </Link>
    </li>
  );
}
