import { uuidSchema, type PlatformTenantAccount, type PlatformTenantDetail } from '@spa/shared';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { ApiClientError, fetchPlatformTenantDetail } from '@/lib/api-client';
import { formatReceiptPhone } from '@/lib/admin/receipt-ticket';
import {
  billingBadge,
  eventTitle,
  formatPlatformDate,
  formatPlatformDateTime,
  originLabel,
  setupSteps,
} from '@/lib/platform-console';

import {
  TenantAccessPanel,
  TenantNoteForm,
  TenantStatusPanel,
} from '../../../components/tenant-record-actions';
import { PLATFORM_TENANTS_PATH } from '../../../paths';
import { readPlatformAccessToken } from '../../../session';
import { PLATFORM_SESSION_END_PATH } from '../../../session/fin/path';

/**
 * La fiche d'un salon — ce que l'éditeur sait de lui, et ce qu'il peut y faire.
 *
 * ## Ce qu'elle montre, et ce qu'elle ne montre pas
 *
 * L'identité, l'abonnement, la mise en route, l'activité **en nombres**, les
 * comptes internes et l'historique de la console. Jamais un rendez-vous, une
 * cliente ou un montant encaissé par le salon (ADR 0012) : l'éditeur est
 * sous-traitant, et la fiche n'en a pas besoin pour accompagner un salon.
 *
 * ## Les dates sont dans le fuseau du salon
 *
 * « Dernière connexion le 18/09 à 22:10 » se lit comme le gérant l'a vécue.
 */

interface PlatformTenantPageProps {
  readonly params: Promise<{ readonly tenantId: string }>;
}

const ROLE_LABELS: Readonly<Record<PlatformTenantAccount['role'], string>> = {
  admin: 'Administrateur·rice',
  manager: 'Gérant·e',
  staff: 'Praticien·ne',
};

function accountState(account: PlatformTenantAccount): { label: string; tone: string } {
  if (!account.isActive) {
    return { label: 'Désactivé', tone: 'cancelled' };
  }
  if (!account.activated) {
    return { label: 'Invitation en attente', tone: 'pending' };
  }
  return { label: 'Actif', tone: 'confirmed' };
}

function stripeCustomerUrl(customerId: string): string {
  return `https://dashboard.stripe.com/customers/${encodeURIComponent(customerId)}`;
}

export default async function PlatformTenantPage({ params }: PlatformTenantPageProps) {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

  const id = uuidSchema.safeParse((await params).tenantId);

  if (!id.success) {
    notFound();
  }

  let detail: PlatformTenantDetail;

  try {
    detail = await fetchPlatformTenantDetail(accessToken, id.data);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(PLATFORM_SESSION_END_PATH);
    }
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  const { tenant, activity, billing } = detail;
  const zone = tenant.timezone;
  const steps = setupSteps(detail);
  const done = steps.filter((step) => step.done).length;
  const badge = billingBadge(tenant);

  return (
    <section aria-labelledby="fiche-titre" className="spa-console-record">
      <nav aria-label="Fil d’Ariane" className="spa-console-record__crumbs">
        <Link href={PLATFORM_TENANTS_PATH}>Salons</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{tenant.name}</span>
      </nav>

      <header className="spa-console-record__head">
        <div className="spa-console-record__title">
          <h1 className="spa-admin__title" id="fiche-titre">
            {tenant.name}
          </h1>
          <div className="spa-console-record__badges">
            <span className={`spa-admin-badge spa-admin-badge--${badge.tone}`}>{badge.label}</span>
            <span
              className={`spa-admin-badge spa-admin-badge--${tenant.isActive ? 'confirmed' : 'cancelled'}`}
            >
              {tenant.isActive ? 'Actif' : 'Suspendu'}
            </span>
          </div>
          <p className="spa-admin-toolbar__hint">
            /{tenant.slug} · {originLabel(tenant)} le {formatPlatformDate(tenant.createdAt, zone)} ·{' '}
            {zone} · {tenant.defaultCurrency}
          </p>
        </div>
        <div className="spa-console-record__links">
          <a className="spa-button spa-button--neutral" href={detail.links.bookingUrl} rel="noopener" target="_blank">
            <Icon name="store" />
            Vitrine
            <span className="spa-visually-hidden"> (nouvel onglet)</span>
          </a>
          <a className="spa-button spa-button--neutral" href={detail.links.adminLoginUrl} rel="noopener" target="_blank">
            <Icon name="external" />
            Back-office
            <span className="spa-visually-hidden"> (nouvel onglet)</span>
          </a>
        </div>
      </header>

      <div className="spa-admin-dashboard__grid">
        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="fiche-demarrage" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-demarrage">
                Mise en route
              </h2>
              <span className="spa-admin-toolbar__hint">
                {done} étape{done > 1 ? 's' : ''} sur {steps.length}
              </span>
            </div>
            <div
              aria-label={`Mise en route : ${String(done)} étapes sur ${String(steps.length)}`}
              aria-valuemax={steps.length}
              aria-valuemin={0}
              aria-valuenow={done}
              className="spa-console-progress"
              role="progressbar"
            >
              <span
                className="spa-console-progress__fill"
                style={{ inlineSize: `${String(Math.round((done / steps.length) * 100))}%` }}
              />
            </div>
            <ol className="spa-console-steps" role="list">
              {steps.map((step) => (
                <li
                  className={`spa-console-steps__item${step.done ? ' spa-console-steps__item--done' : ''}`}
                  key={step.key}
                >
                  <span aria-hidden="true" className="spa-console-steps__mark">
                    {step.done ? <Icon name="check" /> : null}
                  </span>
                  <span className="spa-console-steps__text">
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                  </span>
                  <span className="spa-visually-hidden">{step.done ? ' — fait' : ' — à faire'}</span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="fiche-activite" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-activite">
                Activité — 30 derniers jours
              </h2>
              <span className="spa-admin-toolbar__hint">
                {detail.clientCount} compte{detail.clientCount > 1 ? 's' : ''} client
                {detail.clientCount > 1 ? 's' : ''}
              </span>
            </div>
            <dl className="spa-console-stats">
              <div className="spa-console-stats__item">
                <dt>Réservations prises</dt>
                <dd>{activity.createdLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>À venir</dt>
                <dd>{activity.upcoming}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>Honorés</dt>
                <dd>{activity.completedLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>Non honorés</dt>
                <dd>{activity.noShowLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>Annulés</dt>
                <dd>{activity.cancelledLast30Days}</dd>
              </div>
            </dl>
            <p className="spa-admin-toolbar__hint">
              {activity.lastBookingAt === null
                ? 'Aucune réservation depuis l’ouverture.'
                : `Dernière réservation prise le ${formatPlatformDateTime(activity.lastBookingAt, zone)}.`}
            </p>
          </section>

          <section aria-labelledby="fiche-comptes" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-comptes">
                Comptes du salon
              </h2>
              <span className="spa-admin-toolbar__hint">
                {detail.accounts.length} compte{detail.accounts.length > 1 ? 's' : ''}
              </span>
            </div>
            {detail.accounts.length === 0 ? (
              <p className="spa-admin-toolbar__hint">Aucun compte interne.</p>
            ) : (
              <table className="spa-admin-table">
                <thead>
                  <tr>
                    <th className="spa-admin-table__head" scope="col">
                      Nom
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      Rôle
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      État
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      Dernière connexion
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.accounts.map((account) => {
                    const state = accountState(account);
                    return (
                      <tr className="spa-admin-table__row" key={account.id}>
                        <td className="spa-admin-table__cell">
                          <strong>
                            {account.firstName} {account.lastName}
                          </strong>
                          <span className="spa-console-table__origin">{account.email}</span>
                        </td>
                        <td className="spa-admin-table__cell">{ROLE_LABELS[account.role]}</td>
                        <td className="spa-admin-table__cell">
                          <span className={`spa-admin-badge spa-admin-badge--${state.tone}`}>
                            {state.label}
                          </span>
                        </td>
                        <td className="spa-admin-table__cell">
                          {account.lastLoginAt === null
                            ? 'Jamais'
                            : formatPlatformDateTime(account.lastLoginAt, zone)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="fiche-historique" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-historique">
                Historique et notes
              </h2>
            </div>
            <TenantNoteForm tenantId={tenant.id} />
            {detail.events.length === 0 ? (
              <p className="spa-admin-toolbar__hint">
                Aucune note ni action de la console sur ce salon pour l’instant.
              </p>
            ) : (
              <ol className="spa-console-timeline" role="list">
                {detail.events.map((event) => (
                  <li className={`spa-console-timeline__item spa-console-timeline__item--${event.kind}`} key={event.id}>
                    <span className="spa-console-timeline__head">
                      <strong>{eventTitle(event)}</strong>
                      <span>
                        {formatPlatformDateTime(event.createdAt, zone)}
                        {event.operatorName === null ? '' : ` · ${event.operatorName}`}
                      </span>
                    </span>
                    {event.body === null ? null : (
                      <p className="spa-console-timeline__body">{event.body}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="fiche-abonnement" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-abonnement">
              Abonnement
            </h2>
            <dl className="spa-console-facts">
              <div>
                <dt>Statut</dt>
                <dd>
                  <span className={`spa-admin-badge spa-admin-badge--${badge.tone}`}>{badge.label}</span>
                </dd>
              </div>
              {billing.trialEndsAt === null ? null : (
                <div>
                  <dt>Fin de l’essai</dt>
                  <dd>{formatPlatformDate(billing.trialEndsAt, zone)}</dd>
                </div>
              )}
              {billing.currentPeriodEndsAt === null ? null : (
                <div>
                  <dt>Fin de la période en cours</dt>
                  <dd>{formatPlatformDate(billing.currentPeriodEndsAt, zone)}</dd>
                </div>
              )}
              <div>
                <dt>Client Stripe</dt>
                <dd>
                  {billing.stripeCustomerId === null ? (
                    'Aucun — salon hors facturation'
                  ) : (
                    <a href={stripeCustomerUrl(billing.stripeCustomerId)} rel="noopener" target="_blank">
                      {billing.stripeCustomerId}
                      <span className="spa-visually-hidden"> (tableau de bord Stripe, nouvel onglet)</span>
                    </a>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="fiche-coordonnees" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-coordonnees">
              Coordonnées
            </h2>
            <dl className="spa-console-facts">
              <div>
                <dt>E-mail</dt>
                <dd>
                  {detail.contact.email === null ? (
                    'Non renseigné'
                  ) : (
                    <a href={`mailto:${detail.contact.email}`}>{detail.contact.email}</a>
                  )}
                </dd>
              </div>
              <div>
                <dt>Téléphone</dt>
                <dd>
                  {detail.contact.phone === null ? (
                    'Non renseigné'
                  ) : (
                    <a href={`tel:${detail.contact.phone}`}>{formatReceiptPhone(detail.contact.phone)}</a>
                  )}
                </dd>
              </div>
              <div>
                <dt>Adresse</dt>
                <dd>
                  {detail.address === null ? (
                    'Non renseignée'
                  ) : (
                    <>
                      {detail.address.line1}
                      {detail.address.line2 === null ? null : (
                        <>
                          <br />
                          {detail.address.line2}
                        </>
                      )}
                      <br />
                      {[detail.address.postalCode, detail.address.city].filter(Boolean).join(' ')} ·{' '}
                      {detail.address.country}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Raison sociale</dt>
                <dd>{detail.legalName ?? 'Non renseignée'}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="fiche-acces" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-acces">
              Accès du gérant
            </h2>
            <TenantAccessPanel tenantId={tenant.id} />
          </section>

          <section aria-labelledby="fiche-suspension" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-suspension">
              {tenant.isActive ? 'Suspendre le salon' : 'Salon suspendu'}
            </h2>
            <TenantStatusPanel isActive={tenant.isActive} tenantId={tenant.id} />
          </section>
        </div>
      </div>
    </section>
  );
}
