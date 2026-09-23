import {
  uuidSchema,
  type Locale,
  type PlatformTenantAccount,
  type PlatformTenantDetail,
} from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { ApiClientError, fetchPlatformTenantDetail, fetchPublicTenant } from '@/lib/api-client';
import { formatReceiptPhone } from '@/lib/admin/receipt-ticket';
import type { DisplayLocale } from '@/lib/format';
import {
  billingBadge,
  eventTitle,
  formatPlatformDate,
  formatPlatformDateTime,
  originLabel,
  setupSteps,
} from '@/lib/platform-console';
import { countryLabel } from '@/lib/salon-presets';

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
 * « Dernière connexion le 18/09 à 22:10 » se lit comme le gérant l'a vécue. La
 * **région** de mise en forme, elle, est celle du pays du salon quand il en a
 * saisi un — un salon montréalais écrit ses dates comme le Québec (#1106).
 *
 * ## La langue du salon vient de sa fiche publique
 *
 * `GET /platform/tenants/:id` ne rend pas `defaultLocale` : le contrat de la
 * console (`platformTenantDetailSchema`) est antérieur au champ de #844, et
 * l'étendre sort de l'empreinte de #1106. La langue est donc lue sur
 * `GET /public/{slug}`, qui la rend déjà — le même détour que le personnel du
 * back-office fait pour le pays de l'établissement. Un salon **suspendu** répond
 * 404 sur cette route, par conception : la fiche le dit alors plutôt que de
 * mentir sur une langue.
 */

interface PlatformTenantPageProps {
  readonly params: Promise<{ readonly tenantId: string }>;
}

/** L'état d'un compte : la clé de son libellé, et la teinte de sa pastille. */
function accountState(account: PlatformTenantAccount): {
  key: 'disabled' | 'pending' | 'active';
  tone: string;
} {
  if (!account.isActive) {
    return { key: 'disabled', tone: 'cancelled' };
  }
  if (!account.activated) {
    return { key: 'pending', tone: 'pending' };
  }
  return { key: 'active', tone: 'confirmed' };
}

function stripeCustomerUrl(customerId: string): string {
  return `https://dashboard.stripe.com/customers/${encodeURIComponent(customerId)}`;
}

export default async function PlatformTenantPage({ params }: PlatformTenantPageProps) {
  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    redirect(PLATFORM_SESSION_END_PATH);
  }

  const [t, languages, locale, resolved] = await Promise.all([
    getTranslations('platform'),
    getTranslations('locale'),
    getLocale(),
    params,
  ]);
  const id = uuidSchema.safeParse(resolved.tenantId);

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
  /**
   * La langue du salon, lue sur sa fiche publique — voir l'en-tête.
   *
   * Un échec ne coûte que cette ligne d'affichage : la fiche de la console n'a
   * aucune raison de tomber parce que la vitrine n'a pas répondu, et elle ne
   * répond pas, par conception, sur un salon suspendu.
   */
  const salonLocale = await fetchPublicTenant(tenant.slug)
    .then((published) => published.defaultLocale)
    .catch(() => null);
  // La région de mise en forme vient du pays que la fiche porte déjà : c'est le
  // `country_code` de l'établissement, et il ne demande aucun appel de plus.
  const display: DisplayLocale = {
    locale: locale as Locale,
    countryCode: detail.address?.country ?? null,
  };
  const steps = setupSteps(detail, display);
  const done = steps.filter((step) => step.done).length;
  const badge = billingBadge(tenant, display);

  return (
    <section aria-labelledby="fiche-titre" className="spa-console-record">
      <nav aria-label={t('record.crumbs')} className="spa-console-record__crumbs">
        <Link href={PLATFORM_TENANTS_PATH}>{t('record.tenants')}</Link>
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
              {tenant.isActive ? t('state.active') : t('state.suspended')}
            </span>
          </div>
          <p className="spa-admin-toolbar__hint">
            {t('record.identity', {
              slug: tenant.slug,
              origin: originLabel(tenant, display.locale),
              date: formatPlatformDate(tenant.createdAt, zone, display),
              zone,
              currency: tenant.defaultCurrency,
            })}
          </p>
        </div>
        <div className="spa-console-record__links">
          <a
            className="spa-button spa-button--neutral"
            href={detail.links.bookingUrl}
            rel="noopener"
            target="_blank"
          >
            <Icon name="store" />
            {t('record.storefront')}
            <span className="spa-visually-hidden">{t('record.newTab')}</span>
          </a>
          <a
            className="spa-button spa-button--neutral"
            href={detail.links.adminLoginUrl}
            rel="noopener"
            target="_blank"
          >
            <Icon name="external" />
            {t('record.backOffice')}
            <span className="spa-visually-hidden">{t('record.newTab')}</span>
          </a>
        </div>
      </header>

      <div className="spa-admin-dashboard__grid">
        <div className="spa-admin-dashboard__side">
          <section aria-labelledby="fiche-demarrage" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-demarrage">
                {t('record.setup.title')}
              </h2>
              <span className="spa-admin-toolbar__hint">
                {t('record.setup.progress', { done, total: steps.length })}
              </span>
            </div>
            <div
              aria-label={t('record.setup.label', { done, total: steps.length })}
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
                  <span className="spa-visually-hidden">
                    {step.done ? t('record.setup.done') : t('record.setup.todo')}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="fiche-activite" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-activite">
                {t('record.activity.title')}
              </h2>
              <span className="spa-admin-toolbar__hint">
                {t('record.activity.clients', { count: detail.clientCount })}
              </span>
            </div>
            <dl className="spa-console-stats">
              <div className="spa-console-stats__item">
                <dt>{t('record.activity.created')}</dt>
                <dd>{activity.createdLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>{t('record.activity.upcoming')}</dt>
                <dd>{activity.upcoming}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>{t('record.activity.completed')}</dt>
                <dd>{activity.completedLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>{t('record.activity.noShow')}</dt>
                <dd>{activity.noShowLast30Days}</dd>
              </div>
              <div className="spa-console-stats__item">
                <dt>{t('record.activity.cancelled')}</dt>
                <dd>{activity.cancelledLast30Days}</dd>
              </div>
            </dl>
            <p className="spa-admin-toolbar__hint">
              {activity.lastBookingAt === null
                ? t('record.activity.never')
                : t('record.activity.last', {
                    stamp: formatPlatformDateTime(activity.lastBookingAt, zone, display),
                  })}
            </p>
          </section>

          <section aria-labelledby="fiche-comptes" className="spa-admin__section">
            <div className="spa-admin-dashboard__section-head">
              <h2 className="spa-admin__section-title" id="fiche-comptes">
                {t('record.accounts.title')}
              </h2>
              <span className="spa-admin-toolbar__hint">
                {t('record.accounts.count', { count: detail.accounts.length })}
              </span>
            </div>
            {detail.accounts.length === 0 ? (
              <p className="spa-admin-toolbar__hint">{t('record.accounts.none')}</p>
            ) : (
              <table className="spa-admin-table">
                <thead>
                  <tr>
                    <th className="spa-admin-table__head" scope="col">
                      {t('record.accounts.name')}
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      {t('record.accounts.role')}
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      {t('record.accounts.state')}
                    </th>
                    <th className="spa-admin-table__head" scope="col">
                      {t('record.accounts.lastLogin')}
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
                        <td className="spa-admin-table__cell">
                          {t(`record.accounts.roles.${account.role}`)}
                        </td>
                        <td className="spa-admin-table__cell">
                          <span className={`spa-admin-badge spa-admin-badge--${state.tone}`}>
                            {t(`record.accounts.states.${state.key}`)}
                          </span>
                        </td>
                        <td className="spa-admin-table__cell">
                          {account.lastLoginAt === null
                            ? t('record.accounts.never')
                            : formatPlatformDateTime(account.lastLoginAt, zone, display)}
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
                {t('record.history.title')}
              </h2>
            </div>
            <TenantNoteForm tenantId={tenant.id} />
            {detail.events.length === 0 ? (
              <p className="spa-admin-toolbar__hint">{t('record.history.none')}</p>
            ) : (
              <ol className="spa-console-timeline" role="list">
                {detail.events.map((event) => (
                  <li
                    className={`spa-console-timeline__item spa-console-timeline__item--${event.kind}`}
                    key={event.id}
                  >
                    <span className="spa-console-timeline__head">
                      <strong>{eventTitle(event, display.locale)}</strong>
                      <span>
                        {formatPlatformDateTime(event.createdAt, zone, display)}
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
              {t('record.billing.title')}
            </h2>
            <dl className="spa-console-facts">
              <div>
                <dt>{t('record.billing.status')}</dt>
                <dd>
                  <span className={`spa-admin-badge spa-admin-badge--${badge.tone}`}>
                    {badge.label}
                  </span>
                </dd>
              </div>
              {billing.trialEndsAt === null ? null : (
                <div>
                  <dt>{t('record.billing.trialEnd')}</dt>
                  <dd>{formatPlatformDate(billing.trialEndsAt, zone, display)}</dd>
                </div>
              )}
              {billing.currentPeriodEndsAt === null ? null : (
                <div>
                  <dt>{t('record.billing.periodEnd')}</dt>
                  <dd>{formatPlatformDate(billing.currentPeriodEndsAt, zone, display)}</dd>
                </div>
              )}
              <div>
                <dt>{t('record.billing.stripe')}</dt>
                <dd>
                  {billing.stripeCustomerId === null ? (
                    t('record.billing.noStripe')
                  ) : (
                    <a
                      href={stripeCustomerUrl(billing.stripeCustomerId)}
                      rel="noopener"
                      target="_blank"
                    >
                      {billing.stripeCustomerId}
                      <span className="spa-visually-hidden">{t('record.billing.stripeHint')}</span>
                    </a>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="fiche-coordonnees" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-coordonnees">
              {t('record.contact.title')}
            </h2>
            <dl className="spa-console-facts">
              <div>
                <dt>{t('record.contact.email')}</dt>
                <dd>
                  {detail.contact.email === null ? (
                    t('record.contact.missing')
                  ) : (
                    <a href={`mailto:${detail.contact.email}`}>{detail.contact.email}</a>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('record.contact.phone')}</dt>
                <dd>
                  {detail.contact.phone === null ? (
                    t('record.contact.missing')
                  ) : (
                    <a href={`tel:${detail.contact.phone}`}>
                      {formatReceiptPhone(detail.contact.phone)}
                    </a>
                  )}
                </dd>
              </div>
              {/*
                `missingFeminine` et non `missing` : « Adresse » et « Raison
                sociale » sont féminins, et le français accorde le participe sur
                le nom qu'il qualifie. Les deux catalogues portent la clé, la
                langue qui n'accorde pas y répète simplement la même phrase.
              */}
              <div>
                <dt>{t('record.contact.address')}</dt>
                <dd>
                  {detail.address === null ? (
                    t('record.contact.missingFeminine')
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
                      {/*
                        `address.country` est le **code** ISO que la base stocke
                        (`tenants.country_code`) : il se nomme par `Intl.DisplayNames`,
                        comme le sélecteur du formulaire d'ouverture (#1105).
                      */}
                      {countryLabel(detail.address.country, display.locale)}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('record.contact.legalName')}</dt>
                <dd>{detail.legalName ?? t('record.contact.missingFeminine')}</dd>
              </div>
              {/*
                La langue par défaut du salon (#844) — celle qu'on lui a donnée en
                l'ouvrant, et dans laquelle sa vitrine et ses e-mails s'écrivent.
                Nommée dans sa propre langue, comme dans le sélecteur de #845.
              */}
              <div>
                <dt>{t('record.contact.language')}</dt>
                <dd>
                  {salonLocale === null ? (
                    // La suspension n'est annoncée que si le salon l'est
                    // vraiment : `salonLocale` est aussi `null` quand la vitrine
                    // n'a pas répondu, et affirmer alors une suspension
                    // contredirait la pastille « Actif » de l'en-tête.
                    t(tenant.isActive ? 'record.contact.missing' : 'record.contact.languageUnknown')
                  ) : (
                    <span lang={salonLocale}>
                      {languages(`names.${salonLocale}` as 'names.en')}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="fiche-acces" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-acces">
              {t('record.access.title')}
            </h2>
            <TenantAccessPanel tenantId={tenant.id} />
          </section>

          <section aria-labelledby="fiche-suspension" className="spa-admin__section">
            <h2 className="spa-admin__section-title" id="fiche-suspension">
              {tenant.isActive ? t('record.suspendTitle') : t('record.suspendedTitle')}
            </h2>
            <TenantStatusPanel isActive={tenant.isActive} tenantId={tenant.id} />
          </section>
        </div>
      </div>
    </section>
  );
}
