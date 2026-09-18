import type { TenantBilling } from '@spa/shared';

import { fetchBilling, fetchPublicTenant } from '@/lib/api-client';

import { BillingPanel, type BillingReturn } from '../components/billing-panel';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { adminBillingPath } from '../paths';

/**
 * L'abonnement du salon à la plateforme — ADR 0016.
 *
 * Le seul écran du back-office qui reste ouvert quand l'abonnement ne l'est
 * pas : tous les autres y mènent (`adminLoadFailure`, sur un 402). L'API relit
 * l'abonnement chez Stripe à chaque affichage — c'est ce qui rend juste l'écran
 * du retour de paiement, même quand le webhook n'est pas encore arrivé.
 */

export const dynamic = 'force-dynamic';

const DENIAL = {
  deniedTitle: 'Abonnement réservé à l’administrateur',
  deniedHint:
    'Seul l’administrateur du salon peut consulter et régler son abonnement à la plateforme.',
  failedTitle: 'Abonnement indisponible',
} as const;

interface AdminBillingPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readReturn(raw: string | string[] | undefined): BillingReturn {
  return raw === 'paiement' || raw === 'annule' ? raw : null;
}

export default async function AdminBillingPage({ params, searchParams }: AdminBillingPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminBillingPath(tenantSlug));
  const retour = readReturn((await searchParams).retour);

  let billing: TenantBilling;
  let timeZone: string;

  try {
    [billing, timeZone] = await Promise.all([
      fetchBilling(accessToken),
      // Les dates s'écrivent dans le fuseau du salon ; à défaut, en UTC plutôt
      // que dans celui du serveur.
      fetchPublicTenant(tenantSlug).then(
        (tenant) => tenant.timezone,
        () => 'UTC',
      ),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, DENIAL);
  }

  return (
    <section aria-labelledby="abonnement-titre">
      <h1 className="spa-admin__title" id="abonnement-titre">
        Abonnement
      </h1>
      <BillingPanel billing={billing} retour={retour} tenantSlug={tenantSlug} timeZone={timeZone} />
    </section>
  );
}
