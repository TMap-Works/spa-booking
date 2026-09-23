'use client';

import { ERROR_CODES, type Locale, type PlatformTenant, type TenantAccessLinks } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import type { DisplayLocale } from '@/lib/format';
import { billingBadge, formatPlatformDate, originLabel } from '@/lib/platform-console';

import { reissueTenantInvitationAction } from '../actions';
import { platformTenantPath } from '../paths';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';
import { AccessLinks } from './access-links';

/**
 * La liste des salons. « Liens d'accès » réémet l'invitation du gérant et
 * déplie, sous la ligne, les trois liens à lui remettre : c'est le geste qu'on
 * fait quand un gérant a perdu son e-mail ou laissé expirer son lien.
 *
 * L'état d'une ligne porte une **clé d'erreur** et non un message (#1106) : le
 * message d'un refus est écrit côté serveur, donc en français, et l'afficher tel
 * quel rendrait un tableau anglais bilingue au premier échec.
 */

type ErrorKey = 'noAdmin' | 'tooManyRequests' | 'unavailable' | 'unexpected';

/** Ce que chaque refus de l'API devient à l'écran. */
const ERROR_KEYS: Readonly<Record<string, ErrorKey>> = {
  [ERROR_CODES.TENANT_ADMIN_MISSING]: 'noAdmin',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'tooManyRequests',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'unavailable',
};

type RowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'links'; readonly links: TenantAccessLinks; readonly email: string }
  | { readonly kind: 'error'; readonly error: ErrorKey };

export function TenantTable({ tenants }: { readonly tenants: readonly PlatformTenant[] }) {
  const t = useTranslations('platform');
  const router = useRouter();
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});
  // Aucun établissement de référence : la console lit les dates de tous les
  // salons, et la région vient du repli documenté de `lib/format.ts`.
  const display: DisplayLocale = { locale: useLocale() as Locale, countryCode: null };

  const setRow = (id: string, state: RowState): void => {
    setRows((current) => ({ ...current, [id]: state }));
  };

  const reveal = async (tenant: PlatformTenant): Promise<void> => {
    const state = rows[tenant.id];
    if (state?.kind === 'links') {
      setRow(tenant.id, { kind: 'idle' });
      return;
    }

    setRow(tenant.id, { kind: 'loading' });
    const result = await reissueTenantInvitationAction(tenant.id);

    if (result.ok) {
      setRow(tenant.id, { kind: 'links', links: result.data.links, email: result.data.admin.email });
      return;
    }
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      router.replace(PLATFORM_SESSION_END_PATH);
      return;
    }
    setRow(tenant.id, { kind: 'error', error: ERROR_KEYS[result.code] ?? 'unexpected' });
  };

  /** Le message d'un refus — `noAdmin` a le sien, les autres sont génériques. */
  const errorMessage = (error: ErrorKey): string =>
    error === 'noAdmin' ? t('actions.noAdmin') : t(`errors.${error}`);

  return (
    <table className="spa-admin-table">
      <thead>
        <tr>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.name')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.address')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.zoneCurrency')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.openedOn')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.billing')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('tenants.table.status')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            <span className="spa-visually-hidden">{t('tenants.table.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((tenant) => {
          const state = rows[tenant.id] ?? { kind: 'idle' };
          const badge = billingBadge(tenant, display);

          return (
            <Fragment key={tenant.id}>
              <tr className="spa-admin-table__row">
                <td className="spa-admin-table__cell">
                  <Link className="spa-console-table__name" href={platformTenantPath(tenant.id)}>
                    {tenant.name}
                  </Link>
                  <span className="spa-console-table__origin">
                    {originLabel(tenant, display.locale)}
                  </span>
                </td>
                <td className="spa-admin-table__cell">
                  <a href={`/${tenant.slug}`} target="_blank" rel="noreferrer">
                    /{tenant.slug}
                  </a>
                </td>
                <td className="spa-admin-table__cell">
                  {tenant.timezone} · {tenant.defaultCurrency}
                </td>
                <td className="spa-admin-table__cell">
                  {formatPlatformDate(tenant.createdAt, tenant.timezone, display)}
                </td>
                <td className="spa-admin-table__cell">
                  <span className={`spa-admin-badge spa-admin-badge--${badge.tone}`}>
                    {badge.label}
                  </span>
                </td>
                <td className="spa-admin-table__cell">
                  <span
                    className={
                      tenant.isActive
                        ? 'spa-admin-badge spa-admin-badge--confirmed'
                        : 'spa-admin-badge spa-admin-badge--cancelled'
                    }
                  >
                    {tenant.isActive ? t('state.active') : t('state.suspended')}
                  </span>
                </td>
                <td className="spa-admin-table__cell spa-platform-actions">
                  <Button
                    variant="neutral"
                    loading={state.kind === 'loading'}
                    loadingLabel={t('tenants.table.reissuing')}
                    aria-expanded={state.kind === 'links'}
                    onClick={() => void reveal(tenant)}
                  >
                    {state.kind === 'links'
                      ? t('tenants.table.hide')
                      : t('tenants.table.reveal')}
                  </Button>
                </td>
              </tr>
              {state.kind === 'links' || state.kind === 'error' ? (
                <tr>
                  <td className="spa-admin-table__cell spa-platform-reveal" colSpan={7}>
                    {state.kind === 'links' ? (
                      <>
                        <p className="spa-admin-toolbar__hint">
                          {t('tenants.table.reissued', { email: state.email })}
                        </p>
                        <AccessLinks idPrefix={`salon-${tenant.id}`} links={state.links} />
                      </>
                    ) : (
                      <Notification tone="danger" title={t('actions.linksUnavailable')}>
                        <p>{errorMessage(state.error)}</p>
                      </Notification>
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
