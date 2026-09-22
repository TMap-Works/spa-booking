import { TENANT_BILLING_STATUSES, type Locale, type PlatformOverview } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { ApiClientError, fetchPlatformOverview } from '@/lib/api-client';
import { formatMoney, type DisplayLocale } from '@/lib/format';
import {
  billingBadge,
  billingStatusLabel,
  daysUntil,
  formatPlatformDate,
  formatPlatformStamp,
  originLabel,
  tenantFilterSearch,
} from '@/lib/platform-console';

import { ActivationFunnel, PlatformKpi, SignupWeeksChart } from '../components/overview-widgets';
import {
  PLATFORM_NEW_TENANT_PATH,
  PLATFORM_TENANTS_PATH,
  platformTenantPath,
  platformTenantsPath,
} from '../paths';
import { readPlatformAccessToken } from '../session';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';

/**
 * Le tableau de bord de l'éditeur — l'écran d'arrivée de la console.
 *
 * Ce qu'il répond, dans l'ordre où on se le demande : combien rapporte la
 * plateforme, quels essais se jouent cette semaine, combien de salons
 * s'ouvrent, et combien de ceux qu'on a ouverts s'en servent vraiment.
 *
 * Des agrégats seulement (ADR 0012) : aucun rendez-vous, aucune cliente, aucun
 * montant encaissé par un salon. Le revenu affiché est celui de l'éditeur.
 *
 * Un 401 passe par la route qui efface la session, comme la liste : sans elle,
 * la connexion renverrait ici et la boucle serait refermée.
 *
 * ## La mise en forme n'a pas d'établissement de référence (#1106)
 *
 * `countryCode: null` : les chiffres de cet écran sont ceux de la **plateforme**,
 * pas d'un salon. La région vient donc du repli documenté de `lib/format.ts`
 * (`en` → `en-US`, `fr` → `fr-FR`) et non d'un pays arbitrairement emprunté à
 * l'un des salons listés.
 */
export default async function PlatformDashboardPage() {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

  const [t, locale] = await Promise.all([getTranslations('platform'), getLocale()]);
  const display: DisplayLocale = { locale: locale as Locale, countryCode: null };

  let overview: PlatformOverview;

  try {
    overview = await fetchPlatformOverview(accessToken);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(PLATFORM_SESSION_END_PATH);
    }
    throw error;
  }

  const now = new Date(overview.generatedAt);
  const status = overview.tenants.byBillingStatus;
  const open = overview.tenants.total - status.pending;
  const openings = overview.signupsByWeek.reduce(
    (sum, week) => sum + week.console + week.signup,
    0,
  );

  return (
    <section aria-labelledby="console-titre" className="spa-admin-dashboard">
      <header className="spa-admin-dashboard__hero">
        <div className="spa-admin-dashboard__greeting">
          <span className="spa-admin-dashboard__eyebrow">{t('dashboard.eyebrow')}</span>
          <h1 className="spa-admin__title" id="console-titre">
            {t('dashboard.title')}
          </h1>
          <p className="spa-admin-dashboard__lead">
            {t('dashboard.lead', { count: open, stamp: formatPlatformStamp(now, display) })}
          </p>
        </div>
        <div className="spa-admin-dashboard__hero-actions">
          <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
            <Icon name="store" />
            {t('dashboard.allTenants')}
          </Link>
          <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
            <Icon name="sparkle" />
            {t('dashboard.newTenant')}
          </Link>
        </div>
      </header>

      <div className="spa-admin-dashboard__kpis">
        <PlatformKpi
          icon="chart"
          label={t('dashboard.kpi.revenue')}
          tone="accent"
          value={formatMoney(overview.revenue.monthlyRecurring, display)}
          detail={t('dashboard.kpi.revenueDetail', { count: status.active })}
        />
        <PlatformKpi
          icon="sparkle"
          label={t('dashboard.kpi.trials')}
          tone="success"
          value={String(status.trialing)}
          detail={t('dashboard.kpi.trialsDetail', {
            amount: formatMoney(overview.revenue.inTrial, display),
            soon: overview.trialsEndingSoon.length,
          })}
        />
        <PlatformKpi
          icon="bell"
          label={t('dashboard.kpi.pastDue')}
          tone="warning"
          value={String(status.past_due)}
          detail={
            status.past_due === 0
              ? t('dashboard.kpi.pastDueNone')
              : t('dashboard.kpi.pastDueDetail', {
                  amount: formatMoney(overview.revenue.atRisk, display),
                })
          }
        />
        <PlatformKpi
          icon="lock"
          label={t('dashboard.kpi.suspended')}
          tone="danger"
          value={String(overview.tenants.suspended)}
          detail={t('dashboard.kpi.suspendedDetail', {
            canceled: status.canceled,
            pending: status.pending,
          })}
        />
      </div>

      <div className="spa-admin-dashboard__grid">
        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="console-ouvertures" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-ouvertures">
                {t('dashboard.openings.title')}
              </h2>
              <span className="spa-admin-toolbar__hint">
                {t('dashboard.openings.count', { count: openings })}
              </span>
            </div>
            <SignupWeeksChart weeks={overview.signupsByWeek} />
          </section>

          <section aria-labelledby="console-activation" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-activation">
                {t('dashboard.activation.title')}
              </h2>
            </div>
            <ActivationFunnel activation={overview.activation} />
          </section>
        </div>

        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="console-essais" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-essais">
                {t('dashboard.trials.title')}
              </h2>
              <Link
                className="spa-admin-dashboard__more"
                href={platformTenantsPath(tenantFilterSearch({ billingStatus: 'trialing' }))}
              >
                {t('dashboard.trials.all')}
                <Icon name="arrow" />
              </Link>
            </div>
            {overview.trialsEndingSoon.length === 0 ? (
              <p className="spa-admin-toolbar__hint">{t('dashboard.trials.none')}</p>
            ) : (
              <ul className="spa-console-list" role="list">
                {overview.trialsEndingSoon.map((tenant) => {
                  const days = tenant.trialEndsAt === null ? 0 : daysUntil(tenant.trialEndsAt, now);
                  return (
                    <li className="spa-console-list__item" key={tenant.id}>
                      <Link className="spa-console-list__name" href={platformTenantPath(tenant.id)}>
                        {tenant.name}
                      </Link>
                      <span
                        className={`spa-admin-badge spa-admin-badge--${days <= 2 ? 'no-show' : 'pending'}`}
                      >
                        {days === 0
                          ? t('dashboard.trials.today')
                          : t('dashboard.trials.days', { count: days })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="console-statuts" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-statuts">
                {t('dashboard.byBilling.title')}
              </h2>
            </div>
            <ul className="spa-console-list" role="list">
              {TENANT_BILLING_STATUSES.map((billing) => (
                <li className="spa-console-list__item" key={billing}>
                  <Link
                    className="spa-console-list__name"
                    href={platformTenantsPath(tenantFilterSearch({ billingStatus: billing }))}
                  >
                    {billingStatusLabel(billing, display.locale)}
                  </Link>
                  <strong className="spa-console-list__count">{status[billing]}</strong>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="console-recents" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-recents">
                {t('dashboard.recent.title')}
              </h2>
              <Link className="spa-admin-dashboard__more" href={PLATFORM_TENANTS_PATH}>
                {t('dashboard.recent.all')}
                <Icon name="arrow" />
              </Link>
            </div>
            {overview.recent.length === 0 ? (
              <p className="spa-admin-toolbar__hint">{t('dashboard.recent.none')}</p>
            ) : (
              <ul className="spa-console-list" role="list">
                {overview.recent.map((tenant) => (
                  <li className="spa-console-list__item" key={tenant.id}>
                    <span className="spa-console-list__who">
                      <Link className="spa-console-list__name" href={platformTenantPath(tenant.id)}>
                        {tenant.name}
                      </Link>
                      <span>
                        {originLabel(tenant, display.locale)} ·{' '}
                        {formatPlatformDate(tenant.createdAt, tenant.timezone, display)}
                      </span>
                    </span>
                    <span
                      className={`spa-admin-badge spa-admin-badge--${billingBadge(tenant, display).tone}`}
                    >
                      {billingBadge(tenant, display).label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
