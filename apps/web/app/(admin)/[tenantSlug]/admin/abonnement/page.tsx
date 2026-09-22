import type { PublicTenant, TenantBilling } from '@spa/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

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
 *
 * ## La langue (#1105)
 *
 * Le titre, les refus d'accès et les métadonnées viennent du namespace
 * `admin-subscription`. La fiche publique du salon, déjà lue pour son fuseau,
 * fournit du même coup son **pays** : c'est la région dans laquelle les dates
 * d'échéance s'écrivent (`lib/format.ts`).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-subscription');

  return { title: t('metadata.title') };
}

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
  const t = await getTranslations('admin-subscription');

  let billing: TenantBilling;
  let tenant: PublicTenant | null;

  try {
    [billing, tenant] = await Promise.all([
      fetchBilling(accessToken),
      // La fiche publique porte le fuseau et le pays. Sa panne n'est pas celle
      // de cet écran : l'abonnement s'affiche quand même, dates en UTC et
      // région de repli.
      fetchPublicTenant(tenantSlug).then(
        (found) => found,
        () => null,
      ),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.hint'),
      failedTitle: t('denied.failedTitle'),
    });
  }

  return (
    <section aria-labelledby="abonnement-titre">
      <h1 className="spa-admin__title" id="abonnement-titre">
        {t('title')}
      </h1>
      <BillingPanel
        billing={billing}
        retour={retour}
        tenantSlug={tenantSlug}
        // À défaut de fiche publique, UTC plutôt que le fuseau du serveur : une
        // échéance décalée d'un jour se lit comme une erreur de facturation.
        timeZone={tenant?.timezone ?? 'UTC'}
        countryCode={tenant?.address?.country ?? null}
      />
    </section>
  );
}
