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
import { parseCalendarDate, rangeLabel, todayInTimeZone } from '@/lib/admin/calendar-range';
import { statusModifier } from '@/lib/admin/calendar-grid';
import {
  MY_PLANNING_VIEWS,
  UPCOMING_DAYS,
  agendaDate,
  appointmentsByDay,
  bookedCount,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  myPlanningViewLabels,
  nextAppointment,
  parseMyPlanningView,
  planningRange,
  shiftPlanningAnchor,
  showsToday,
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
import { PeriodNav } from '../components/period-nav';
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
 * ## La reprise de conception
 *
 * L'écran empilait trois niveaux de cadre — barre en carte, journée en carte,
 * rendez-vous en carte — et la vue semaine rangeait sept boîtes de hauteurs
 * inégales en deux colonnes : on y voyait des boîtes, pas une semaine. Il est
 * désormais **un agenda** : une seule surface (`.spa-my-agenda`), où une
 * journée est une section à colonne de date et un rendez-vous une ligne séparée
 * par un filet. Le détail s'y déplie dans la ligne, qui devient un bloc teinté.
 *
 * Il dessinait aussi sa propre barre de période et son propre libellé de
 * semaine ; il emprunte désormais ceux du reste du back-office — `PeriodNav`
 * dans une `.spa-admin-toolbar`, `rangeLabel` pour la période. Trois conséquences
 * qui se voient :
 *
 *   - le retour « Aujourd'hui » se **désactive** quand la période ouverte
 *     contient déjà la journée du salon. C'est l'état où l'écran s'ouvre : le
 *     lien pointait la page où l'on était déjà, et le tout premier clic de la
 *     praticienne ne produisait rien ;
 *   - la date n'est plus écrite trois fois — barre du haut, sous-titre, en-tête
 *     de journée — mais une fois, entre les deux chevrons ;
 *   - la barre dit ce que la période pèse, annulés exclus.
 *
 * Le reste est dans `styles/admin/my-planning.css`, qui porte le détail de la
 * mise en page et la discipline de l'accent — il était sur chaque ligne, il ne
 * reste que là où il désigne (BM-VISUEL-01).
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

/**
 * Ce qu'annonce la barre de période.
 *
 * Les deux vues datées empruntent `rangeLabel` — le libellé du planning du
 * salon et de l'encaissement. Il n'y a ainsi qu'une écriture d'une période dans
 * le back-office, et la semaine s'y dit « 21 – 27 septembre 2026 » là où cet
 * écran l'écrivait en toutes lettres des deux côtés : à 360 px, les
 * cinquante-quatre caractères de « Du lundi 21 septembre 2026 au dimanche 27
 * septembre 2026 » chassaient les deux chevrons sur trois lignes.
 *
 * `rangeLabel` compte la semaine du lundi par défaut — c'est aussi ce que
 * `planningRange` demande à l'API, et les deux ne peuvent donc pas diverger.
 *
 * « À venir » n'est pas une période datée mais un horizon : son libellé reste
 * une phrase du catalogue, paramétrée par la borne de l'API.
 */
function periodLabel(
  view: MyPlanningView,
  anchor: CalendarDate,
  t: MyPlanningTranslator,
  display: DisplayLocale,
): string {
  return view === 'a-venir'
    ? t('period.upcoming', { days: UPCOMING_DAYS })
    : rangeLabel(view, anchor, display);
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
  const shown =
    view === 'a-venir' ? upcomingOnly(agenda.appointments, now) : agenda.appointments;
  const byDay = appointmentsByDay(shown, zone);
  const days = view === 'a-venir' ? [...byDay.keys()] : daysOf(agenda.from, agenda.to);
  // Le prochain rendez-vous est désigné sur **toute** la période affichée et non
  // journée par journée : une semaine dont le lundi est passé met la marque au
  // mardi, ce qu'un calcul par jour ne saurait pas faire.
  const next = nextAppointment(shown, now);

  return (
    <section aria-labelledby="mon-planning-titre" className="spa-my-planning">
      <MyPlanningAutoRefresh />

      <header className="spa-my-planning__head">
        <span className="spa-my-planning__who">{profile.displayName}</span>
        <h1 className="spa-admin__title" id="mon-planning-titre">
          {t('title')}
        </h1>
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

      {/*
       * La barre de période est celle du planning du salon et de l'encaissement
       * (`PeriodNav`, #629) : même geste, même rendu, même place. Elle remplace
       * trois liens dessinés à part, où la date était à chercher dans l'en-tête
       * plutôt qu'entre les deux chevrons.
       *
       * Des liens et non des gestes : l'écran est rendu par le serveur, et la
       * vue comme la date vivent dans l'adresse (web-frontend §1).
       */}
      <div className="spa-admin-toolbar">
        {view === 'a-venir' ? (
          <span className="spa-admin-toolbar__caption">
            {periodLabel(view, anchor, t, display)}
          </span>
        ) : (
          <PeriodNav
            label={periodLabel(view, anchor, t, display)}
            next={{
              href: adminMyPlanningPath(tenantSlug, {
                view,
                date: shiftPlanningAnchor(view, anchor, 1),
              }),
            }}
            nextLabel={view === 'semaine' ? t('nav.nextWeek') : t('nav.nextDay')}
            previous={{
              href: adminMyPlanningPath(tenantSlug, {
                view,
                date: shiftPlanningAnchor(view, anchor, -1),
              }),
            }}
            previousLabel={view === 'semaine' ? t('nav.previousWeek') : t('nav.previousDay')}
            today={{ href: adminMyPlanningPath(tenantSlug, { view }) }}
            todayIsCurrent={showsToday(agenda.from, agenda.to, today)}
          />
        )}

        <div className="spa-admin-toolbar__group spa-admin-toolbar__spacer">
          <span className="spa-admin-toolbar__hint">
            {t('toolbar.load', { count: bookedCount(shown) })}
          </span>
        </div>
      </div>

      {days.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">{t('empty.title')}</p>
          <p className="spa-empty-state__description">
            {t('empty.body', { days: UPCOMING_DAYS })}
          </p>
        </div>
      ) : (
        <div className="spa-my-agenda">
          {days.map((day) => (
            <MyDay
              appointments={byDay.get(day) ?? []}
              day={day}
              display={display}
              key={day}
              nextId={next?.id ?? null}
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
  nextId,
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
  /** Le rendez-vous à suivre, désigné sur toute la période — ou aucun. */
  readonly nextId: string | null;
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
  const date = agendaDate(day, display);

  return (
    <section
      aria-labelledby={headingId}
      className={`spa-my-day${day === today ? ' spa-my-day--today' : ''}`}
    >
      {/* La colonne de date — une bande au-dessus des lignes sur téléphone, une
          colonne à leur gauche dès 48 rem. Elle porte tout ce qui vaut pour la
          journée entière : sa date, ses horaires, ses absences. */}
      <div className="spa-my-day__rail">
        <h2 className="spa-my-day__date" id={headingId}>
          {/* La date entière pour qui écoute l'écran, les abréviations pour qui le
              regarde : « mer. 23 sept. » ne s'annonce pas, il se lit. */}
          <span className="spa-visually-hidden">{formatCalendarDate(day, display)}</span>
          <span aria-hidden="true" className="spa-my-day__weekday">
            {date.weekday}
          </span>
          <span aria-hidden="true" className="spa-my-day__number">
            {date.number}
          </span>
          <span aria-hidden="true" className="spa-my-day__month">
            {date.month}
          </span>
        </h2>
        {day === today ? <span className="spa-my-day__today">{t('day.today')}</span> : null}
        {showSchedule ? (
          <p className="spa-my-day__hours">
            {/* Une plage par élément, et non une chaîne jointe par un point
                médian : dans une colonne de neuf rem, « 09:00 – 13:00 · 14:00 –
                19:00 » se coupait entre le tiret et l'heure de fin. Ce sont les
                plages qui se rangent l'une sous l'autre, pas les heures. */}
            {work.closed
              ? t('day.closed')
              : work.hours.length === 0
                ? t('day.noShift')
                : work.hours.map((range, rank) => (
                    <span key={`${day}-${String(rank)}`}>{range}</span>
                  ))}
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
      </div>

      {appointments.length === 0 ? (
        <p className="spa-my-day__empty">{t('day.empty')}</p>
      ) : (
        <ol className="spa-my-day__list" role="list">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <MyAppointment
                appointment={appointment}
                display={display}
                isNext={appointment.id === nextId}
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
  isNext,
  now,
  t,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: MyStaffAppointment;
  readonly display: DisplayLocale;
  /** Celui vers lequel l'œil doit aller — le prochain encore attendu. */
  readonly isNext: boolean;
  readonly now: Date;
  readonly t: MyPlanningTranslator;
  readonly tenantSlug: string;
  readonly timeZone: string;
}) {
  const classes = [
    'spa-my-appointment',
    appointment.status === 'cancelled' ? 'spa-my-appointment--cancelled' : null,
    isNext ? 'spa-my-appointment--next' : null,
  ]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <details className={classes}>
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
        {/* Statut et marque « prochain » dans la même boîte : ils occupent la même
            place dans la lecture d'une ligne, et c'est cette boîte que la mise en
            page large déplace à droite d'un seul tenant. */}
        <span className="spa-my-appointment__tags">
          <span
            className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
          >
            {appointmentStatusLabels(display.locale)[appointment.status]}
          </span>
          {isNext ? (
            <span className="spa-my-appointment__flag">{t('appointment.next')}</span>
          ) : null}
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
        {/* L'heure du soin part telle quelle, et l'instant du rendu avec elle :
            la règle « on ne constate pas ce qui n'a pas eu lieu » est lue par le
            composant, dans le contrat partagé, et non recalculée ici (#1210).
            `renderedAt` est la graine de son horloge — c'est ce qui rend le
            premier rendu du navigateur identique à celui-ci. */}
        <MyAppointmentActions
          appointmentId={appointment.id}
          renderedAt={now.toISOString()}
          startsAt={appointment.startsAt}
          status={appointment.status}
          tenantSlug={tenantSlug}
        />
      </div>
    </details>
  );
}
