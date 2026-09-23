import type { PaymentMethod, PublicTenant } from '@spa/shared';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  fetchAppointmentVolumeReport,
  fetchNoShowReport,
  fetchPublicTenant,
  fetchRevenueReport,
} from '@/lib/api-client';
import { formatMoney, formatMoneyCompact, type DisplayLocale } from '@/lib/format';
import type {
  AppointmentVolumeReport,
  DailyRevenueReport,
  NoShowReport,
} from '@/lib/admin/reporting-contract';
// Les libellés de statut viennent du module de vocabulaire du front, et non plus
// de ce contrat-ci (#917) : un rapport compte des rendez-vous, d'où la table
// accordée au pluriel — les mêmes mots que la pastille du planning et que
// l'espace client, et non plus « En attente » et « No-shows » pour eux seuls.
// La tuile de tête et le graphique de volume lisent la **même** table : nommer
// « No-shows » sur l'une ce que la table des statuts appelle « Non honorés »
// aurait rejoué la divergence à l'intérieur d'un seul écran.
import {
  appointmentStatusPluralLabelInSentence,
  appointmentStatusPluralLabels,
} from '@/lib/appointment-status';
import {
  filterOptions,
  formatCount,
  formatRate,
  parseReportScope,
  revenueByCurrency,
  revenueSeries,
  scopedActivity,
  upcomingPluralLabel,
  volumePoints,
  volumeQualification,
  wholeTenant,
  type ReportFilterOption,
  type ReportScope,
  type ScopedActivity,
} from '@/lib/admin/reporting-view';
import {
  daysInRange,
  parseReportDate,
  parseReportPeriod,
  rangeLabel,
  rangeRefusal,
  resolveReportRange,
  shortDayLabel,
  windowOfRange,
  type ReportPeriod,
  type ReportRange,
} from '@/lib/admin/reporting-window';
import { Notification } from '@/components/ui/notification';

import { ReportChart } from '../components/report-chart';
import { ReportExportButton } from '../components/report-export-button';
import { ReportFilters } from '../components/report-filters';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { adminReportingPath } from '../paths';

/**
 * Les indicateurs d'activité du salon — #75, et l'écran que le README du module
 * `reporting` annonce depuis #74 : « l'écran et l'export CSV n'en font pas
 * partie non plus : c'est #75, côté `apps/web` ».
 *
 * ## Un écran, aucun endpoint
 *
 * Les trois routes de lecture existent, elles sont au rang `MANAGER`, et elles
 * ne prennent qu'une fenêtre : tout ce que cette page ajoute est de la lecture,
 * de la mise en forme et un fichier. Le module `reporting` ne possède aucune
 * table et n'écrit jamais — cet écran non plus.
 *
 * ## Server Component, et cinq lectures menées de front
 *
 * Rien de ce qui est peint ici n'a d'état : ce sont des chiffres et des
 * rectangles. Seuls la barre de filtres et le bouton d'export basculent côté
 * client, aussi bas que possible dans l'arbre (web-frontend §1). Les cinq
 * lectures partent ensemble — trois axes de volume, le revenu, les no-shows —
 * parce qu'aucune ne dépend d'une autre ; les enchaîner ferait payer cinq
 * allers-retours à l'ouverture.
 *
 * Les deux axes `staff` et `service` ne sont pas du luxe : ils **sont** les
 * filtres. `GET /reports/appointments` ne prend ni `staffId` ni `serviceId`, et
 * la liste des praticiens qui ont travaillé sur la période ne s'obtient pas
 * autrement.
 *
 * ## Le fuseau vient de la vitrine publique
 *
 * `GET /public/{slug}` sert le fuseau **sans jeton**, comme pour le planning et
 * l'encaissement. Le lire de `GET /v1/tenant` aurait fermé l'écran à tout rang
 * inférieur à `ADMIN`, alors que les trois routes de rapport s'ouvrent au rang
 * `MANAGER` (#458, même défaut).
 *
 * Il est lu **avant** les rapports parce que la conversion des dates civiles en
 * fenêtre d'API en dépend : « du 1er au 30 septembre » n'est pas le même
 * intervalle d'instants à Papeete et à Paris.
 *
 * ## La langue (#851)
 *
 * Tous les mots viennent du namespace `admin-reporting`. Les chiffres, eux,
 * suivent deux règles qu'il ne faut pas confondre :
 *
 * - **la langue** décide de la façon d'écrire — séparateur de milliers, symbole
 *   de devise, nom du mois. Elle vient de la session (`getLocale`), et la
 *   **région** du pays de l'établissement (`Tenant.address.country`) : un salon
 *   montréalais écrit ses dates comme le Québec, en français comme en anglais ;
 * - **le fuseau** décide de quelles journées on parle, et il reste celui de
 *   l'établissement. La langue n'y touche pas — un rapport mal fuseau-horairé
 *   est un bug de sévérité haute (`CLAUDE.md`).
 *
 * La même `DisplayLocale` descend dans les trois modules de calcul de cet écran
 * (`reporting-window`, `reporting-view`, `format`), ce qui garantit que la
 * légende d'une barre, l'étiquette de son axe et la ligne du tableau masqué qui
 * la double annoncent la même chose.
 *
 * Ce que la langue ne change **pas** : les paramètres de l'URL. `?periode=`,
 * `?du=`, `?au=`, `?filtre=praticien:<id>` restent français, parce qu'un lien
 * partagé entre deux collègues doit ouvrir le même écran quelle que soit la
 * langue de chacun.
 *
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait le chiffre d'affaires du premier arrivé à tout le monde.
 */

export const dynamic = 'force-dynamic';

/** Le traducteur du namespace, passé aux fonctions de composition de l'écran. */
type ReportingTranslator = Awaited<ReturnType<typeof getTranslations<'admin-reporting'>>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-reporting');

  return { title: t('metadata.title') };
}

interface ReportingPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{
    readonly periode?: string;
    readonly du?: string;
    readonly au?: string;
    readonly filtre?: string;
  }>;
}

export default async function ReportingPage({ params, searchParams }: ReportingPageProps) {
  const { tenantSlug } = await params;
  const { periode, du, au, filtre } = await searchParams;
  const t = await getTranslations('admin-reporting');
  const locale = await getLocale();

  // Lus **avant** la garde : ils ne demandent aucun jeton, et c'est ce qui
  // permet de dire à la garde où revenir après un renouvellement de session —
  // sur la période regardée, pas sur le défaut (#458).
  const period = parseReportPeriod(periode);
  const requestedFrom = parseReportDate(du);
  const requestedTo = parseReportDate(au);
  const currentPath = adminReportingPath(tenantSlug, {
    period,
    ...(requestedFrom === null ? {} : { from: requestedFrom }),
    ...(requestedTo === null ? {} : { to: requestedTo }),
    scope: filtre ?? null,
  });
  const accessToken = await requireAdminAccessToken(tenantSlug, currentPath);

  let tenant: PublicTenant;
  try {
    tenant = await fetchPublicTenant(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.storefrontHint'),
      failedTitle: t('denied.failedTitle'),
    });
  }

  // Le pays de l'établissement — la **région** des formats, lue sur l'adresse
  // publiée. Il ne touche pas au fuseau : la langue et la région disent comment
  // une date s'écrit, jamais de quelle journée il s'agit.
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };
  const range = resolveReportRange(period, requestedFrom, requestedTo, tenant.timezone);
  const refusal = rangeRefusal(range, locale);

  // Une plage refusée n'est pas demandée : l'API répondrait 422, et l'écran
  // n'aurait rien de plus à dire que ce qu'il sait déjà. La barre de filtres
  // reste peinte, pour qu'on puisse corriger sans repartir de l'URL.
  if (refusal !== null) {
    return (
      <ReportingShell
        period={period}
        range={range}
        scope={wholeTenant(locale)}
        services={[]}
        staff={[]}
        t={t}
        tenantSlug={tenantSlug}
        timeZone={tenant.timezone}
      >
        <Notification tone="warning" title={t('impossiblePeriod.title')}>
          <p>{refusal}</p>
        </Notification>
      </ReportingShell>
    );
  }

  // `reportWindow` et non `window` : le nom global existe même côté serveur dans
  // certains contextes de rendu, et l'ombrer rendrait toute lecture ambiguë.
  const reportWindow = windowOfRange(range, tenant.timezone);

  let revenue: DailyRevenueReport;
  let byDay: AppointmentVolumeReport;
  let byStaff: AppointmentVolumeReport;
  let byService: AppointmentVolumeReport;
  let noShows: NoShowReport;

  try {
    [revenue, byDay, byStaff, byService, noShows] = await Promise.all([
      fetchRevenueReport(accessToken, reportWindow),
      fetchAppointmentVolumeReport(accessToken, reportWindow, 'day'),
      fetchAppointmentVolumeReport(accessToken, reportWindow, 'staff'),
      fetchAppointmentVolumeReport(accessToken, reportWindow, 'service'),
      fetchNoShowReport(accessToken, reportWindow),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.reportsHint'),
      failedTitle: t('denied.failedTitle'),
    });
  }

  const staffOptions = filterOptions(byStaff, display);
  const serviceOptions = filterOptions(byService, display);
  const scope = parseReportScope(filtre, staffOptions, serviceOptions, locale);
  const axis = scope.kind === 'praticien' ? byStaff : scope.kind === 'prestation' ? byService : byDay;
  const activity = scopedActivity(scope, axis, noShows, byDay);

  const qualification = volumeQualification(activity, display);
  const totals = revenueByCurrency(revenue.totals);
  const series = revenueSeries(revenue, range);
  // `shortDayLabel` est passée **par référence** : on l'enveloppe donc dans une
  // lambda qui referme sur la langue, plutôt que de faire voyager un contexte
  // d'affichage à travers une signature qui n'a rien à en connaître.
  const volume = volumePoints(scope, axis, range, (date) => shortDayLabel(date, display), display);
  const days = daysInRange(range);
  const periodLabel = rangeLabel(range, display);
  const noShowWord = appointmentStatusPluralLabelInSentence('no_show', locale);

  return (
    <ReportingShell
      period={period}
      range={range}
      scope={scope}
      services={serviceOptions}
      staff={staffOptions}
      t={t}
      tenantSlug={tenantSlug}
      timeZone={revenue.timeZone}
    >
      <div className="spa-admin-toolbar">
        <p className="spa-admin-toolbar__caption">
          {t('toolbar.caption', { range: periodLabel, days, scope: scope.label })}
        </p>
        <span className="spa-admin-toolbar__spacer" />
        <ReportExportButton tenantSlug={tenantSlug} window={reportWindow} />
      </div>

      <div className="spa-admin-report-metrics">
        {totals.length === 0 ? (
          <div className="spa-admin-metric">
            <span className="spa-admin-metric__value">—</span>
            <span className="spa-admin-metric__label">{t('metrics.revenueEmpty')}</span>
          </div>
        ) : (
          totals.map((total) => (
            <div className="spa-admin-metric" key={total.currency}>
              <span className="spa-admin-metric__value">
                {formatMoney(
                  { amountMinor: total.netAmountMinor, currency: total.currency },
                  display,
                )}
              </span>
              <span className="spa-admin-metric__label">
                {t('metrics.revenue', {
                  transactions: total.transactions,
                  refunded: formatMoney(
                    { amountMinor: total.refundedAmountMinor, currency: total.currency },
                    display,
                  ),
                })}
              </span>
            </div>
          ))
        )}

        <div className="spa-admin-metric">
          <span className="spa-admin-metric__value">{formatCount(activity.appointments, display)}</span>
          {/* La tuile dit ce qu'elle compte, comme ses deux voisines (#772). Sans
              cette ligne, « 17 rendez-vous » et « 50 % de non honorés » se
              lisaient comme deux faces du même ensemble, alors que 8 des 17
              étaient des annulations et 7 des rendez-vous à venir — un écart
              qu'il fallait descendre jusqu'à la table des statuts pour voir. */}
          <span className="spa-admin-metric__label">
            {qualification === null
              ? t('metrics.appointments', { scope: scope.label })
              : t('metrics.appointmentsQualified', { scope: scope.label, qualification })}
          </span>
        </div>

        <div className="spa-admin-metric">
          <span className="spa-admin-metric__value">{formatRate(activity.noShows.rate, display)}</span>
          {/* Le même mot que la table des statuts trois blocs plus bas, et que
              la pastille du planning — pris à la table de vocabulaire plutôt
              qu'écrit ici (#917). « No-shows » sur la tuile et « Non honorés »
              dans la table auraient rejoué, sur un seul écran, la divergence que
              le ticket vient de fermer entre trois écrans. */}
          <span className="spa-admin-metric__label">
            {t('metrics.noShows', {
              status: appointmentStatusPluralLabels(locale).no_show,
              noShows: formatCount(activity.noShows.noShows, display),
              due: activity.noShows.honored + activity.noShows.noShows,
            })}
          </span>
        </div>
      </div>

      {scope.key === null ? null : (
        <Notification tone="info" title={t('scopeNotice.title')}>
          <p>{t('scopeNotice.body', { scope: scope.label })}</p>
        </Notification>
      )}

      <div className="spa-admin__section">
        {series.length === 0 ? (
          <ReportChart
            bars={[]}
            display={display}
            emptyLabel={t('revenueChart.empty')}
            labelHeader={t('chart.labelHeader')}
            layout="colonnes"
            seriesLabel={t('revenueChart.series')}
            summary={t('revenueChart.summary', { range: periodLabel })}
            title={t('revenueChart.title')}
            valueHeader={t('revenueChart.valueHeader')}
          />
        ) : (
          series.map((currencySeries) => (
            <ReportChart
              bars={currencySeries.days.map((day) => ({
                key: day.date,
                label: shortDayLabel(day.date, display),
                value: Math.max(day.netAmountMinor, 0),
                valueLabel: formatMoney(
                  { amountMinor: day.netAmountMinor, currency: currencySeries.currency },
                  display,
                ),
              }))}
              display={display}
              emptyLabel={t('revenueChart.empty')}
              // Les barres portent des unités mineures — la donnée ne se
              // convertit pas en chemin. C'est l'échelle qui les met en forme
              // dans la devise, comme le tableau de la même figure (#614).
              formatScaleValue={(value) =>
                formatMoneyCompact(
                  { amountMinor: value, currency: currencySeries.currency },
                  display,
                )
              }
              key={currencySeries.currency}
              labelHeader={t('chart.labelHeader')}
              layout="colonnes"
              seriesLabel={t('revenueChart.seriesCurrency', { currency: currencySeries.currency })}
              summary={t('revenueChart.summaryCurrency', {
                currency: currencySeries.currency,
                range: periodLabel,
                timeZone: revenue.timeZone,
              })}
              title={t('revenueChart.titleCurrency', { currency: currencySeries.currency })}
              valueHeader={t('revenueChart.valueHeader')}
            />
          ))
        )}
      </div>

      <div className="spa-admin__section">
        <ReportChart
          bars={volume.map((point) => ({
            key: point.key,
            label: point.label,
            value: point.total,
            valueLabel: t('volumeChart.valueLabel', { count: point.total }),
            inner: point.noShows,
            innerLabel: formatCount(point.noShows, display),
            ...(point.selected ? { highlighted: true } : {}),
          }))}
          display={display}
          emptyLabel={t('volumeChart.empty')}
          innerHeader={t('volumeChart.innerHeader', { noShows: noShowWord })}
          innerSeriesLabel={t('volumeChart.innerSeries', { noShows: noShowWord })}
          labelHeader={volumeLabelHeader(axis.groupBy, t)}
          layout={axis.groupBy === 'day' ? 'colonnes' : 'barres'}
          seriesLabel={t('volumeChart.series')}
          summary={volumeSummary(axis.groupBy, range, noShowWord, t)}
          title={volumeTitle(axis.groupBy, t)}
          valueHeader={t('volumeChart.valueHeader')}
        />
      </div>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">
          {t('statuses.title', { scope: scope.label })}
        </h2>
        <table className="spa-admin-table">
          <caption className="spa-visually-hidden">
            {t('statuses.caption', { scope: scope.label })}
          </caption>
          <thead>
            <tr>
              <th className="spa-admin-table__head" scope="col">
                {t('statuses.status')}
              </th>
              <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                {t('statuses.appointments')}
              </th>
            </tr>
          </thead>
          <tbody>
            {statusRows(activity, locale).map((row) => (
              <tr className="spa-admin-table__row" key={row.label}>
                <td className="spa-admin-table__cell">{row.label}</td>
                <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                  {formatCount(row.count, display)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totals.length === 0 ? null : (
        <div className="spa-admin__section">
          <h2 className="spa-admin__section-title">{t('methods.title')}</h2>
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">{t('methods.caption')}</caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  {t('methods.method')}
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  {t('methods.transactions')}
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  {t('methods.gross')}
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  {t('methods.refunded')}
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  {t('methods.net')}
                </th>
              </tr>
            </thead>
            <tbody>
              {revenue.totals.map((total) => (
                <tr className="spa-admin-table__row" key={`${total.method}-${total.currency}`}>
                  <td className="spa-admin-table__cell">{paymentMethodLabel(total.method, t)}</td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatCount(total.transactions, display)}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney(
                      { amountMinor: total.grossAmountMinor, currency: total.currency },
                      display,
                    )}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney(
                      { amountMinor: total.refundedAmountMinor, currency: total.currency },
                      display,
                    )}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney(
                      { amountMinor: total.netAmountMinor, currency: total.currency },
                      display,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportingShell>
  );
}

/**
 * Le moyen d'encaissement, dans la langue de l'écran.
 *
 * Lu ici et non dans `lib/admin/reporting-contract.ts`, qui porte encore la
 * table française : ce module de schémas est partagé avec le comptoir et le
 * fichier client, et le traduire sort de l'empreinte de ce ticket. Les deux
 * seules valeurs du contrat sont énumérées à la main plutôt que lues par clé
 * dynamique, pour que `tsc` refuse le jour où une troisième apparaît.
 */
function paymentMethodLabel(method: PaymentMethod, t: ReportingTranslator): string {
  return method === 'card' ? t('methods.card') : t('methods.cash');
}

/**
 * L'en-tête de la colonne d'étiquettes du graphique de volume, selon l'axe.
 *
 * C'est la seule colonne du tableau de lecture d'écran qui change de nature
 * d'un axe à l'autre : sous filtre, les lignes sont des praticiens ou des
 * prestations, et les annoncer « Période » nommait de travers la seule forme du
 * graphique qu'un lecteur non voyant reçoit. Le graphique de revenu, lui, est
 * toujours quotidien et garde l'en-tête par défaut.
 */
function volumeLabelHeader(
  groupBy: AppointmentVolumeReport['groupBy'],
  t: ReportingTranslator,
): string {
  if (groupBy === 'staff') {
    return t('chart.labelHeaderStaff');
  }

  return groupBy === 'service' ? t('chart.labelHeaderService') : t('chart.labelHeader');
}

/** Le titre du graphique de volume, selon l'axe. */
function volumeTitle(
  groupBy: AppointmentVolumeReport['groupBy'],
  t: ReportingTranslator,
): string {
  if (groupBy === 'staff') {
    return t('volumeChart.titleStaff');
  }

  return groupBy === 'service' ? t('volumeChart.titleService') : t('volumeChart.titleDay');
}

/**
 * Le `<desc>` du graphique de volume — ce qu'un lecteur d'écran entend.
 *
 * Un message par axe plutôt qu'une phrase assemblée d'un fragment : « par
 * praticien » ne s'insère pas au même endroit selon la langue, et composer une
 * phrase morceau par morceau est exactement ce qui produit des traductions
 * qu'aucune relecture ne peut corriger.
 */
function volumeSummary(
  groupBy: AppointmentVolumeReport['groupBy'],
  range: ReportRange,
  noShows: string,
  t: ReportingTranslator,
): string {
  const values = { noShows, from: range.from, to: range.to };

  if (groupBy === 'staff') {
    return t('volumeChart.summaryStaff', values);
  }

  return groupBy === 'service'
    ? t('volumeChart.summaryService', values)
    : t('volumeChart.summaryDay', values);
}

/** Les statuts de la période, dans l'ordre où ils intéressent la gérante. */
function statusRows(
  activity: ScopedActivity,
  locale: Parameters<typeof appointmentStatusPluralLabels>[0],
): readonly { readonly label: string; readonly count: number }[] {
  const counts = activity.byStatus;
  const labels = appointmentStatusPluralLabels(locale);

  if (counts === null) {
    // Sans filtre, les comptes viennent du rapport de no-shows, qui fond
    // `pending` et `confirmed` en un seul compte — « pas encore jugés ». On
    // n'invente pas la ventilation qu'il ne rend pas.
    return [
      { label: labels.completed, count: activity.noShows.honored },
      { label: labels.no_show, count: activity.noShows.noShows },
      { label: labels.cancelled, count: activity.noShows.cancelled },
      // Le même mot que la tuile du volume, pris à la même source (#772) : deux
      // littéraux dans deux fichiers sont exactement la façon dont les libellés
      // de statut avaient divergé sur trois écrans (#917).
      { label: upcomingPluralLabel(locale), count: activity.noShows.pending },
    ];
  }

  return [
    { label: labels.completed, count: counts.completed },
    { label: labels.no_show, count: counts.no_show },
    { label: labels.cancelled, count: counts.cancelled },
    { label: labels.confirmed, count: counts.confirmed },
    { label: labels.pending, count: counts.pending },
  ];
}

interface ReportingShellProps {
  readonly tenantSlug: string;
  readonly period: ReportPeriod;
  readonly range: ReportRange;
  readonly scope: ReportScope;
  readonly staff: readonly ReportFilterOption[];
  readonly services: readonly ReportFilterOption[];
  readonly timeZone: string;
  readonly t: ReportingTranslator;
  readonly children: ReactNode;
}

/**
 * Le titre et la barre de filtres, autour de ce que la page a pu charger.
 *
 * Extrait pour que le cas « période impossible » garde ses filtres : un écran
 * d'erreur sans le contrôle qui permet de corriger l'erreur oblige à réécrire
 * l'URL à la main.
 */
function ReportingShell({
  tenantSlug,
  period,
  range,
  scope,
  staff,
  services,
  timeZone,
  t,
  children,
}: ReportingShellProps) {
  return (
    <section aria-labelledby="reporting-titre">
      <h1 className="spa-admin__title" id="reporting-titre">
        {t('title')}
      </h1>

      <ReportFilters
        period={period}
        range={range}
        scope={scope}
        services={services}
        staff={staff}
        tenantSlug={tenantSlug}
        timeZone={timeZone}
      />

      {children}
    </section>
  );
}
