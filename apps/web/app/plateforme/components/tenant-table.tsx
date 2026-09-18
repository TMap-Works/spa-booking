'use client';

import { ERROR_CODES, type PlatformTenant, type TenantAccessLinks } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';

import { reissueTenantInvitationAction } from '../actions';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';
import { AccessLinks } from './access-links';

/**
 * La liste des salons. « Liens d'accès » réémet l'invitation du gérant et
 * déplie, sous la ligne, les trois liens à lui remettre : c'est le geste qu'on
 * fait quand un gérant a perdu son e-mail ou laissé expirer son lien.
 */

function openedOn(tenant: PlatformTenant): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tenant.timezone, dateStyle: 'medium' }).format(
    new Date(tenant.createdAt),
  );
}

/** La facturation d'un salon, telle que la console l'annonce (ADR 0016). */
function billingBadge(tenant: PlatformTenant): { label: string; tone: string } {
  switch (tenant.billingStatus) {
    case 'managed':
      return { label: 'Géré par la plateforme', tone: 'completed' };
    case 'pending':
      return { label: 'Paiement en attente', tone: 'pending' };
    case 'trialing':
      return {
        label:
          tenant.trialEndsAt === null
            ? 'Essai en cours'
            : `Essai · fin le ${new Intl.DateTimeFormat('fr-FR', { timeZone: tenant.timezone, dateStyle: 'short' }).format(new Date(tenant.trialEndsAt))}`,
        tone: 'confirmed',
      };
    case 'active':
      return { label: 'Abonné', tone: 'confirmed' };
    case 'past_due':
      return { label: 'Impayé — relance', tone: 'no-show' };
    case 'canceled':
      return { label: 'Résilié', tone: 'cancelled' };
  }
}

type RowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'links'; readonly links: TenantAccessLinks; readonly email: string }
  | { readonly kind: 'error'; readonly message: string };

export function TenantTable({ tenants }: { readonly tenants: readonly PlatformTenant[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});

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
    setRow(tenant.id, {
      kind: 'error',
      message:
        result.code === ERROR_CODES.TENANT_ADMIN_MISSING
          ? 'Ce salon n’a aucun compte administrateur à réinviter.'
          : result.message,
    });
  };

  return (
    <table className="spa-admin-table">
      <thead>
        <tr>
          <th className="spa-admin-table__head" scope="col">
            Salon
          </th>
          <th className="spa-admin-table__head" scope="col">
            Adresse
          </th>
          <th className="spa-admin-table__head" scope="col">
            Fuseau · devise
          </th>
          <th className="spa-admin-table__head" scope="col">
            Ouvert le
          </th>
          <th className="spa-admin-table__head" scope="col">
            Facturation
          </th>
          <th className="spa-admin-table__head" scope="col">
            Statut
          </th>
          <th className="spa-admin-table__head" scope="col">
            <span className="spa-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((tenant) => {
          const state = rows[tenant.id] ?? { kind: 'idle' };

          return (
            <Fragment key={tenant.id}>
              <tr className="spa-admin-table__row">
                <td className="spa-admin-table__cell">
                  <strong>{tenant.name}</strong>
                </td>
                <td className="spa-admin-table__cell">
                  <a href={`/${tenant.slug}`} target="_blank" rel="noreferrer">
                    /{tenant.slug}
                  </a>
                </td>
                <td className="spa-admin-table__cell">
                  {tenant.timezone} · {tenant.defaultCurrency}
                </td>
                <td className="spa-admin-table__cell">{openedOn(tenant)}</td>
                <td className="spa-admin-table__cell">
                  <span className={`spa-admin-badge spa-admin-badge--${billingBadge(tenant).tone}`}>
                    {billingBadge(tenant).label}
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
                    {tenant.isActive ? 'Actif' : 'Suspendu'}
                  </span>
                </td>
                <td className="spa-admin-table__cell spa-platform-actions">
                  <Button
                    variant="neutral"
                    loading={state.kind === 'loading'}
                    loadingLabel="Réémission de l’invitation…"
                    aria-expanded={state.kind === 'links'}
                    onClick={() => void reveal(tenant)}
                  >
                    {state.kind === 'links' ? 'Masquer les liens' : 'Liens d’accès'}
                  </Button>
                </td>
              </tr>
              {state.kind === 'links' || state.kind === 'error' ? (
                <tr>
                  <td className="spa-admin-table__cell spa-platform-reveal" colSpan={7}>
                    {state.kind === 'links' ? (
                      <>
                        <p className="spa-admin-toolbar__hint">
                          Nouvelle invitation émise pour {state.email}. Si le compte est déjà
                          activé, le lien d’activation reste sans effet : seul le back-office sert.
                        </p>
                        <AccessLinks idPrefix={`salon-${tenant.id}`} links={state.links} />
                      </>
                    ) : (
                      <Notification tone="danger" title="Liens indisponibles">
                        <p>{state.message}</p>
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
