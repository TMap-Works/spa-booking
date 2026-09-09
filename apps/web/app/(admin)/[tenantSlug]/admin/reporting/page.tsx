import type { PublicTenant } from '@spa/shared';
import type { ReactNode } from 'react';

import {
  fetchAppointmentVolumeReport,
  fetchNoShowReport,
  fetchPublicTenant,
  fetchRevenueReport,
} from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import {
  APPOINTMENT_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  type AppointmentVolumeReport,
  type DailyRevenueReport,
  type NoShowReport,
} from '@/lib/admin/reporting-contract';
import type { ReportCsvInput } from '@/lib/admin/reporting-csv';
import {
  filterOptions,
  formatCount,
  formatRate,
  parseReportScope,
  revenueByCurrency,
  revenueSeries,
  scopedActivity,
  volumePoints,
  WHOLE_TENANT,
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
 * Ce ticket ne touche pas `apps/api`. Les trois routes existent, elles sont au
 * rang `MANAGER`, et elles ne prennent qu'une fenêtre : tout ce que cette page
 * ajoute est de la lecture, de la mise en forme et un fichier. Le module
 * `reporting` ne possède aucune table et n'écrit jamais — cet écran non plus.
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
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait le chiffre d'affaires du premier arrivé à tout le monde.
 */

export const dynamic = 'force-dynamic';

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
      deniedTitle: 'Accès réservé',
      deniedHint: 'La vitrine publique de ce salon n’a pas pu être lue avec ce compte.',
      failedTitle: 'Indicateurs indisponibles',
    });
  }

  const range = resolveReportRange(period, requestedFrom, requestedTo, tenant.timezone);
  const refusal = rangeRefusal(range);

  // Une plage refusée n'est pas demandée : l'API répondrait 422, et l'écran
  // n'aurait rien de plus à dire que ce qu'il sait déjà. La barre de filtres
  // reste peinte, pour qu'on puisse corriger sans repartir de l'URL.
  if (refusal !== null) {
    return (
      <ReportingShell
        period={period}
        range={range}
        scope={WHOLE_TENANT}
        services={[]}
        staff={[]}
        tenantSlug={tenantSlug}
        timeZone={tenant.timezone}
      >
        <Notification tone="warning" title="Période impossible">
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
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Les indicateurs d’activité sont réservés à la gestion du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Indicateurs indisponibles',
    });
  }

  const staffOptions = filterOptions(byStaff);
  const serviceOptions = filterOptions(byService);
  const scope = parseReportScope(filtre, staffOptions, serviceOptions);
  const axis = scope.kind === 'praticien' ? byStaff : scope.kind === 'prestation' ? byService : byDay;
  const activity = scopedActivity(scope, axis, noShows, byDay);

  const totals = revenueByCurrency(revenue.totals);
  const series = revenueSeries(revenue, range);
  const volume = volumePoints(scope, axis, range, shortDayLabel);
  const days = daysInRange(range);

  const csv: ReportCsvInput = {
    range,
    timeZone: revenue.timeZone,
    scope,
    revenueTotals: totals,
    revenueSeries: series,
    revenueByMethod: revenue.totals,
    volumeAxis:
      scope.kind === 'praticien' ? 'praticien' : scope.kind === 'prestation' ? 'prestation' : 'jour',
    volume,
    appointments: activity.appointments,
    noShows: activity.noShows,
  };

  return (
    <ReportingShell
      period={period}
      range={range}
      scope={scope}
      services={serviceOptions}
      staff={staffOptions}
      tenantSlug={tenantSlug}
      timeZone={revenue.timeZone}
    >
      <div className="spa-admin-toolbar">
        <p className="spa-admin-toolbar__caption">
          {rangeLabel(range)} · {formatCount(days)} {days > 1 ? 'jours' : 'jour'} ·{' '}
          {scope.label}
        </p>
        <span className="spa-admin-toolbar__spacer" />
        <ReportExportButton data={csv} tenantSlug={tenantSlug} />
      </div>

      <div className="spa-admin-report-metrics">
        {totals.length === 0 ? (
          <div className="spa-admin-metric">
            <span className="spa-admin-metric__value">—</span>
            <span className="spa-admin-metric__label">Revenu net — aucun encaissement</span>
          </div>
        ) : (
          totals.map((total) => (
            <div className="spa-admin-metric" key={total.currency}>
              <span className="spa-admin-metric__value">
                {formatMoney({ amountMinor: total.netAmountMinor, currency: total.currency })}
              </span>
              <span className="spa-admin-metric__label">
                Revenu net · {formatCount(total.transactions)} encaissements · remboursé{' '}
                {formatMoney({
                  amountMinor: total.refundedAmountMinor,
                  currency: total.currency,
                })}
              </span>
            </div>
          ))
        )}

        <div className="spa-admin-metric">
          <span className="spa-admin-metric__value">{formatCount(activity.appointments)}</span>
          <span className="spa-admin-metric__label">Rendez-vous · {scope.label}</span>
        </div>

        <div className="spa-admin-metric">
          <span className="spa-admin-metric__value">{formatRate(activity.noShows.rate)}</span>
          <span className="spa-admin-metric__label">
            No-shows · {formatCount(activity.noShows.noShows)} sur{' '}
            {formatCount(activity.noShows.honored + activity.noShows.noShows)} arrivés à échéance
          </span>
        </div>
      </div>

      {scope.key === null ? null : (
        <Notification tone="info" title="Ce qu’un filtre ne peut pas ventiler">
          <p>
            Le revenu reste celui de l’établissement entier&nbsp;: l’API agrège les encaissements
            sans les rattacher à un praticien ni à une prestation, et les répartir au prorata des
            rendez-vous inventerait un chiffre. Le volume et les no-shows, eux, portent bien sur
            «&nbsp;{scope.label}&nbsp;».
          </p>
        </Notification>
      )}

      <div className="spa-admin__section">
        {series.length === 0 ? (
          <ReportChart
            bars={[]}
            emptyLabel="Aucun encaissement sur la période."
            layout="colonnes"
            seriesLabel="Revenu net"
            summary={`Revenu net par journée de caisse, ${rangeLabel(range)}.`}
            title="Revenu net par jour"
            valueHeader="Revenu net"
          />
        ) : (
          series.map((currencySeries) => (
            <ReportChart
              bars={currencySeries.days.map((day) => ({
                key: day.date,
                label: shortDayLabel(day.date),
                value: Math.max(day.netAmountMinor, 0),
                valueLabel: formatMoney({
                  amountMinor: day.netAmountMinor,
                  currency: currencySeries.currency,
                }),
              }))}
              emptyLabel="Aucun encaissement sur la période."
              key={currencySeries.currency}
              layout="colonnes"
              seriesLabel={`Revenu net (${currencySeries.currency})`}
              summary={`Revenu net par journée de caisse en ${currencySeries.currency}, ${rangeLabel(range)}, fuseau ${revenue.timeZone}.`}
              title={`Revenu net par jour — ${currencySeries.currency}`}
              valueHeader="Revenu net"
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
            valueLabel: `${formatCount(point.total)} rendez-vous`,
            inner: point.noShows,
            innerLabel: formatCount(point.noShows),
            ...(point.selected ? { highlighted: true } : {}),
          }))}
          emptyLabel="Aucun rendez-vous sur la période."
          innerHeader="Dont no-shows"
          innerSeriesLabel="dont no-shows"
          layout={axis.groupBy === 'day' ? 'colonnes' : 'barres'}
          seriesLabel="Rendez-vous"
          summary={volumeSummary(axis.groupBy, range)}
          title={volumeTitle(axis.groupBy)}
          valueHeader="Rendez-vous"
        />
      </div>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">Détail des statuts — {scope.label}</h2>
        <table className="spa-admin-table">
          <caption className="spa-visually-hidden">
            Rendez-vous de la période par statut, pour {scope.label}.
          </caption>
          <thead>
            <tr>
              <th className="spa-admin-table__head" scope="col">
                Statut
              </th>
              <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                Rendez-vous
              </th>
            </tr>
          </thead>
          <tbody>
            {statusRows(activity).map((row) => (
              <tr className="spa-admin-table__row" key={row.label}>
                <td className="spa-admin-table__cell">{row.label}</td>
                <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                  {formatCount(row.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totals.length === 0 ? null : (
        <div className="spa-admin__section">
          <h2 className="spa-admin__section-title">Revenu par moyen d’encaissement</h2>
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">
              Cumul de la période par moyen d’encaissement et par devise.
            </caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  Moyen
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  Encaissements
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  Brut
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  Remboursé
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  Net
                </th>
              </tr>
            </thead>
            <tbody>
              {revenue.totals.map((total) => (
                <tr className="spa-admin-table__row" key={`${total.method}-${total.currency}`}>
                  <td className="spa-admin-table__cell">{PAYMENT_METHOD_LABELS[total.method]}</td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatCount(total.transactions)}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney({
                      amountMinor: total.grossAmountMinor,
                      currency: total.currency,
                    })}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney({
                      amountMinor: total.refundedAmountMinor,
                      currency: total.currency,
                    })}
                  </td>
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney({ amountMinor: total.netAmountMinor, currency: total.currency })}
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

/** Le titre du graphique de volume, selon l'axe. */
function volumeTitle(groupBy: AppointmentVolumeReport['groupBy']): string {
  if (groupBy === 'staff') {
    return 'Rendez-vous par praticien';
  }

  return groupBy === 'service' ? 'Rendez-vous par prestation' : 'Rendez-vous par jour';
}

/** Le `<desc>` du graphique de volume — ce qu'un lecteur d'écran entend. */
function volumeSummary(groupBy: AppointmentVolumeReport['groupBy'], range: ReportRange): string {
  const axis =
    groupBy === 'staff' ? 'par praticien' : groupBy === 'service' ? 'par prestation' : 'par jour';

  return `Nombre de rendez-vous ${axis}, dont no-shows, du ${range.from} au ${range.to} inclus.`;
}

/** Les statuts de la période, dans l'ordre où ils intéressent la gérante. */
function statusRows(
  activity: ScopedActivity,
): readonly { readonly label: string; readonly count: number }[] {
  const counts = activity.byStatus;

  if (counts === null) {
    // Sans filtre, les comptes viennent du rapport de no-shows, qui fond
    // `pending` et `confirmed` en un seul compte — « pas encore jugés ». On
    // n'invente pas la ventilation qu'il ne rend pas.
    return [
      { label: APPOINTMENT_STATUS_LABELS.completed, count: activity.noShows.honored },
      { label: APPOINTMENT_STATUS_LABELS.no_show, count: activity.noShows.noShows },
      { label: APPOINTMENT_STATUS_LABELS.cancelled, count: activity.noShows.cancelled },
      { label: 'À venir', count: activity.noShows.pending },
    ];
  }

  return [
    { label: APPOINTMENT_STATUS_LABELS.completed, count: counts.completed },
    { label: APPOINTMENT_STATUS_LABELS.no_show, count: counts.no_show },
    { label: APPOINTMENT_STATUS_LABELS.cancelled, count: counts.cancelled },
    { label: APPOINTMENT_STATUS_LABELS.confirmed, count: counts.confirmed },
    { label: APPOINTMENT_STATUS_LABELS.pending, count: counts.pending },
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
  children,
}: ReportingShellProps) {
  return (
    <section aria-labelledby="reporting-titre">
      <h1 className="spa-admin__title" id="reporting-titre">
        Indicateurs d’activité
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
