import {
  ERROR_CODES,
  type CalendarDate,
  type MyStaffAgenda,
  type MyStaffAppointment,
  type MyStaffProfile,
  type MyStaffSchedule,
} from '@spa/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

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
  MY_PLANNING_VIEWS,
  UPCOMING_DAYS,
  appointmentsByDay,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  myPlanningViewLabels,
  parseMyPlanningView,
  planningRange,
  shiftPlanningAnchor,
  upcomingOnly,
  workingDay,
  type MyPlanningView,
} from '@/lib/admin/my-planning';
import { appointmentStatusLabels } from '@/lib/appointment-status';
import {
  formatCalendarDate,
  formatDuration,
  formatTimeInTimeZone,
  type DisplayLocale,
} from '@/lib/format';
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
 *
 * ## La langue (#1104)
 *
 * Les mots viennent du namespace `admin-my-planning` — sauf le statut d'un
 * rendez-vous, qui vient de `lib/appointment-status.ts`, seul endroit du front
 * où ce vocabulaire s'écrit. Les **clés** de vue restent françaises : ce sont des
 * segments d'URL (`?vue=semaine`), et les traduire changerait les adresses d'un
 * salon anglophone sans rien lui apprendre.
 *
 * Le **fuseau reste celui du salon**, dans les deux langues : l'agenda le porte
 * (`agenda.timezone`) et c'est lui qui décide de la journée sur laquelle on
 * ouvre. La langue et la région — le pays de l'établissement, lu sur la coquille
 * du back-office — ne disent que la façon d'écrire une heure, jamais quelle heure
 * il est (`CLAUDE.md`).
 */

export const dynamic = 'force-dynamic';

type MyPlanningTranslator = Awaited<ReturnType<typeof getTranslations<'admin-my-planning'>>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-my-planning');

  return { title: t('metadata.title') };
}

interface MyPlanningPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{
    readonly vue?: string;
    readonly date?: string;
    readonly session?: string | readonly string[];
  }>;
}

function periodLabel(
  view: MyPlanningView,
  from: CalendarDate,
  to: CalendarDate,
  t: MyPlanningTranslator,
  display: DisplayLocale,
): string {
  if (view === 'jour') {
    return formatCalendarDate(from, display);
  }
  if (view === 'semaine') {
    return t('period.week', {
      from: formatCalendarDate(from, display),
      to: formatCalendarDate(to, display),
    });
  }
  return t('period.upcoming', { days: UPCOMING_DAYS });
}

export default async function MyPlanningPage({ params, searchParams }: MyPlanningPageProps) {
  const { tenantSlug } = await params;
  const query = await searchParams;
  const t = await getTranslations('admin-my-planning');
  const locale = await getLocale();
  const view = parseMyPlanningView(query.vue);
  const requested = parseCalendarDate(query.date);
  const here = adminMyPlanningPath(tenantSlug, {
    view,
    ...(requested === null ? {} : { date: requested }),
  });
  const renewal = { returnTo: here, attempted: isRenewalReturn(query[RENEWAL_PARAM]) };
  const accessToken = await requireAdminAccessToken(tenantSlug, here);

  // Le fuseau du salon, déjà lu par le layout ; relu de la vitrine si le shell
  // n'a pas pu le dire. La journée par défaut est **celle du salon**. Le pays
  // vient de la même source, et ne sert qu'à la mise en forme (#1104).
  const shell = await loadAdminShell(tenantSlug);
  let timeZone = shell?.timeZone ?? null;
  let countryCode = shell?.countryCode ?? null;

  let profile: MyStaffProfile;
  let agenda: MyStaffAgenda;
  let schedule: MyStaffSchedule;

  try {
    if (timeZone === null) {
      const vitrine = await fetchPublicTenant(tenantSlug);
      timeZone = vitrine.timezone;
      countryCode ??= vitrine.address?.country ?? null;
    }
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
            {t('title')}
          </h1>
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('noProfile.title')}</p>
            <p className="spa-empty-state__description">{t('noProfile.body')}</p>
            {shell?.permissions?.includes('agenda:read:all') === true ? (
              <Link className="spa-button spa-button--neutral" href={adminCalendarPath(tenantSlug)}>
                <span className="spa-button__label">{t('noProfile.openCalendar')}</span>
              </Link>
            ) : null}
          </div>
        </section>
      );
    }
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.hint'),
      failedTitle: t('denied.failedTitle'),
      renewal,
    });
  }

  const zone = agenda.timezone;
  const display: DisplayLocale = { locale, countryCode };
  const now = new Date();
  const today = todayInTimeZone(zone);
  const anchor = requested ?? today;
  const viewLabels = myPlanningViewLabels(locale);
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
          {t('title')}
        </h1>
        <p className="spa-my-planning__period">
          {periodLabel(view, agenda.from, agenda.to, t, display)}
        </p>
      </header>

      <NavTabs
        items={MY_PLANNING_VIEWS.map((candidate) => ({
          href: adminMyPlanningPath(tenantSlug, {
            view: candidate,
            ...(requested === null || candidate === 'a-venir' ? {} : { date: requested }),
          }),
          label: viewLabels[candidate],
          current: candidate === view,
        }))}
        label={t('tabsLabel')}
      />

      {view === 'a-venir' ? null : (
        <nav aria-label={t('nav.label')} className="spa-my-planning__nav">
          <Link
            className="spa-button spa-button--neutral"
            href={adminMyPlanningPath(tenantSlug, {
              view,
              date: shiftPlanningAnchor(view, anchor, -1),
            })}
          >
            <span aria-hidden="true">‹</span>
            <span className="spa-visually-hidden">
              {view === 'semaine' ? t('nav.previousWeek') : t('nav.previousDay')}
            </span>
          </Link>
          <Link className="spa-button spa-button--quiet" href={adminMyPlanningPath(tenantSlug, { view })}>
            {t('nav.today')}
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
              {view === 'semaine' ? t('nav.nextWeek') : t('nav.nextDay')}
            </span>
          </Link>
        </nav>
      )}

      {days.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">{t('empty.title')}</p>
          <p className="spa-empty-state__description">
            {t('empty.body', { days: UPCOMING_DAYS })}
          </p>
        </div>
      ) : (
        <div className="spa-my-planning__days">
          {days.map((day) => (
            <MyDay
              appointments={byDay.get(day) ?? []}
              day={day}
              display={display}
              key={day}
              now={now}
              schedule={schedule}
              showSchedule={view !== 'a-venir'}
              t={t}
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
  display,
  now,
  schedule,
  showSchedule,
  t,
  tenantSlug,
  today,
}: {
  readonly appointments: readonly MyStaffAppointment[];
  readonly day: CalendarDate;
  readonly display: DisplayLocale;
  readonly now: Date;
  readonly schedule: MyStaffSchedule;
  readonly showSchedule: boolean;
  readonly t: MyPlanningTranslator;
  readonly tenantSlug: string;
  readonly today: CalendarDate;
}) {
  const bounds = dayBoundsInTimeZone(day, schedule.timezone);
  const work = workingDay(schedule, day, bounds.start, bounds.end, display);
  const headingId = `jour-${day}`;

  return (
    <section aria-labelledby={headingId} className="spa-my-day">
      <header className="spa-my-day__head">
        <h2 className="spa-my-day__title" id={headingId}>
          {formatCalendarDate(day, display)}
          {day === today ? <span className="spa-my-day__today">{t('day.today')}</span> : null}
        </h2>
        {showSchedule ? (
          <p className="spa-my-day__hours">
            {work.closed
              ? t('day.closed')
              : work.hours.length === 0
                ? t('day.noShift')
                : work.hours.join(' · ')}
          </p>
        ) : null}
        {/* La clé est le rang et non le texte : deux absences du même praticien
            peuvent tomber sur le même créneau avec le même motif — l'API les
            accepte — et React signalait alors deux enfants de même clé, en
            promettant d'en omettre un (relevé en recette de #1104). */}
        {work.absences.map((absence, rank) => (
          <p className="spa-my-day__absence" key={`${day}-${String(rank)}`}>
            {t('day.absence', { span: absence })}
          </p>
        ))}
      </header>

      {appointments.length === 0 ? (
        <p className="spa-my-day__empty">{t('day.empty')}</p>
      ) : (
        <ol className="spa-my-day__list" role="list">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <MyAppointment
                appointment={appointment}
                display={display}
                now={now}
                t={t}
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
  display,
  now,
  t,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: MyStaffAppointment;
  readonly display: DisplayLocale;
  readonly now: Date;
  readonly t: MyPlanningTranslator;
  readonly tenantSlug: string;
  readonly timeZone: string;
}) {
  const cancelled = appointment.status === 'cancelled';

  return (
    <details className={`spa-my-appointment${cancelled ? ' spa-my-appointment--cancelled' : ''}`}>
      <summary className="spa-my-appointment__summary">
        <span className="spa-my-appointment__time">
          <strong>{formatTimeInTimeZone(appointment.startsAt, timeZone, display)}</strong>
          <span>{formatTimeInTimeZone(appointment.endsAt, timeZone, display)}</span>
        </span>
        <span className="spa-my-appointment__what">
          <strong>{appointment.service.name}</strong>
          <span>
            {clientLabel(appointment)} ·{' '}
            {formatDuration(appointment.service.durationMinutes, display)}
          </span>
        </span>
        <span className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}>
          {appointmentStatusLabels(display.locale)[appointment.status]}
        </span>
      </summary>
      <div className="spa-my-appointment__details">
        <dl className="spa-my-appointment__facts">
          <div>
            <dt>{t('appointment.reference')}</dt>
            <dd>{appointment.reference}</dd>
          </div>
          <div>
            <dt>{t('appointment.clientNote')}</dt>
            <dd>{appointment.clientNote ?? t('appointment.noNote')}</dd>
          </div>
          {appointment.staffNote === undefined ? null : (
            <div>
              <dt>{t('appointment.staffNote')}</dt>
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
