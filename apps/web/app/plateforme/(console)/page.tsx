import { TENANT_BILLING_STATUSES, type PlatformOverview } from '@spa/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { ApiClientError, fetchPlatformOverview } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import {
  BILLING_STATUS_LABELS,
  billingBadge,
  daysUntil,
  formatPlatformDate,
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
 */
export default async function PlatformDashboardPage() {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

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
          <span className="spa-admin-dashboard__eyebrow">Console plateforme</span>
          <h1 className="spa-admin__title" id="console-titre">
            Vue d’ensemble
          </h1>
          <p className="spa-admin-dashboard__lead">
            {open} salon{open > 1 ? 's' : ''} ouvert{open > 1 ? 's' : ''} · état au{' '}
            {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(now)}
          </p>
        </div>
        <div className="spa-admin-dashboard__hero-actions">
          <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
            <Icon name="store" />
            Tous les salons
          </Link>
          <Link className="spa-button spa-button--accent" href={PLATFORM_NEW_TENANT_PATH}>
            <Icon name="sparkle" />
            Ouvrir un salon
          </Link>
        </div>
      </header>

      <div className="spa-admin-dashboard__kpis">
        <PlatformKpi
          icon="chart"
          label="Revenu mensuel récurrent"
          tone="accent"
          value={formatMoney(overview.revenue.monthlyRecurring)}
          detail={`${String(status.active)} salon${status.active > 1 ? 's' : ''} abonné${status.active > 1 ? 's' : ''}`}
        />
        <PlatformKpi
          icon="sparkle"
          label="Essais en cours"
          tone="success"
          value={String(status.trialing)}
          detail={`${formatMoney(overview.revenue.inTrial)} / mois à convertir · ${String(overview.trialsEndingSoon.length)} sous 7 jours`}
        />
        <PlatformKpi
          icon="bell"
          label="Impayés"
          tone="warning"
          value={String(status.past_due)}
          detail={
            status.past_due === 0
              ? 'Aucun salon en impayé'
              : `${formatMoney(overview.revenue.atRisk)} / mois à risque`
          }
        />
        <PlatformKpi
          icon="lock"
          label="Salons suspendus"
          tone="danger"
          value={String(overview.tenants.suspended)}
          detail={`${String(status.canceled)} résilié${status.canceled > 1 ? 's' : ''} · ${String(status.pending)} paiement${status.pending > 1 ? 's' : ''} en attente`}
        />
      </div>

      <div className="spa-admin-dashboard__grid">
        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="console-ouvertures" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-ouvertures">
                Ouvertures — 12 dernières semaines
              </h2>
              <span className="spa-admin-toolbar__hint">
                {openings} salon{openings > 1 ? 's' : ''}
              </span>
            </div>
            <SignupWeeksChart weeks={overview.signupsByWeek} />
          </section>

          <section aria-labelledby="console-activation" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-activation">
                Activation des salons
              </h2>
            </div>
            <ActivationFunnel activation={overview.activation} />
          </section>
        </div>

        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="console-essais" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-essais">
                Essais qui se terminent
              </h2>
              <Link
                className="spa-admin-dashboard__more"
                href={platformTenantsPath(tenantFilterSearch({ billingStatus: 'trialing' }))}
              >
                Tous les essais
                <Icon name="arrow" />
              </Link>
            </div>
            {overview.trialsEndingSoon.length === 0 ? (
              <p className="spa-admin-toolbar__hint">Aucun essai ne se termine dans les 7 jours.</p>
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
                        {days === 0 ? 'Aujourd’hui' : `${String(days)} j`}
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
                Salons par facturation
              </h2>
            </div>
            <ul className="spa-console-list" role="list">
              {TENANT_BILLING_STATUSES.map((billing) => (
                <li className="spa-console-list__item" key={billing}>
                  <Link
                    className="spa-console-list__name"
                    href={platformTenantsPath(tenantFilterSearch({ billingStatus: billing }))}
                  >
                    {BILLING_STATUS_LABELS[billing]}
                  </Link>
                  <strong className="spa-console-list__count">{status[billing]}</strong>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="console-recents" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="console-recents">
                Derniers salons ouverts
              </h2>
              <Link className="spa-admin-dashboard__more" href={PLATFORM_TENANTS_PATH}>
                Tous
                <Icon name="arrow" />
              </Link>
            </div>
            {overview.recent.length === 0 ? (
              <p className="spa-admin-toolbar__hint">Aucun salon pour l’instant.</p>
            ) : (
              <ul className="spa-console-list" role="list">
                {overview.recent.map((tenant) => (
                  <li className="spa-console-list__item" key={tenant.id}>
                    <span className="spa-console-list__who">
                      <Link className="spa-console-list__name" href={platformTenantPath(tenant.id)}>
                        {tenant.name}
                      </Link>
                      <span>
                        {originLabel(tenant)} · {formatPlatformDate(tenant.createdAt, tenant.timezone)}
                      </span>
                    </span>
                    <span className={`spa-admin-badge spa-admin-badge--${billingBadge(tenant).tone}`}>
                      {billingBadge(tenant).label}
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
