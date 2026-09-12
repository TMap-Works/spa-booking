import {
  hasAtLeastRole,
  type PublicTenant,
  type ServiceCategory,
  type SessionUser,
} from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import { fetchOwnProfile, fetchPublicTenant, fetchServiceCategories } from '@/lib/api-client';

import { ServiceForm } from '../../components/service-form';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath, adminNewServicePath } from '../../paths';

/**
 * Création d'une prestation (#52, premier et troisième critères).
 *
 * ## D'où vient la devise
 *
 * De la **vitrine publique** de l'établissement (`GET /public/{slug}`), et non de
 * ses réglages : `GET /tenant` exige le rang `ADMIN`, quand créer une prestation
 * n'exige que `MANAGER`. Lire la devise là-bas ferait échouer la page en 403
 * pour exactement les personnes à qui elle est destinée. Les deux points
 * d'entrée portent le même `defaultCurrency` — `tenantSchema` étend
 * `publicTenantSchema` —, et celui-ci ne demande aucun privilège.
 *
 * ## Seules les rubriques actives sont proposées
 *
 * Classer une prestation neuve sous une rubrique retirée du catalogue la rendrait
 * invisible sur la page publique sans que rien ne le dise. Les rubriques
 * désactivées restent modifiables depuis leur propre écran, où l'état est écrit.
 *
 * ## Pourquoi le rang est lu ici aussi
 *
 * Le catalogue ne propose plus « Nouvelle prestation » au rang praticien (#619),
 * mais une adresse se saisit et un signet se garde. Sans cette borne, l'écran
 * servait ses neuf champs à un compte qui n'obtiendra jamais que le 403 de
 * `POST /v1/services` — le refus après coup, précisément, qu'il s'agit de ne plus
 * infliger. Ce n'est pas une garde : c'est l'écran qui dit ce qu'il en est avant
 * la première frappe.
 */

export const dynamic = 'force-dynamic';

interface NewServicePageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function NewServicePage({ params }: NewServicePageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminNewServicePath(tenantSlug));

  let categories: ServiceCategory[];
  let tenant: PublicTenant;
  let profile: SessionUser;
  try {
    [categories, tenant, profile] = await Promise.all([
      fetchServiceCategories(accessToken, { activeOnly: true }),
      fetchPublicTenant(tenantSlug),
      fetchOwnProfile(accessToken),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'La création d’une prestation est réservée aux gérantes et aux administrateurs du salon.',
      failedTitle: 'Formulaire indisponible',
    });
  }

  if (!hasAtLeastRole(profile.role, 'manager')) {
    return (
      <Notification tone="warning" title="Accès réservé">
        <p>
          La création d’une prestation est réservée au rang gérant. Le catalogue reste consultable,
          et une gérante ou une administratrice du salon peut ajouter la prestation pour vous.{' '}
          <Link href={adminCatalogPath(tenantSlug)}>Revenir au catalogue</Link>.
        </p>
      </Notification>
    );
  }

  return (
    <section aria-labelledby="prestation-nouvelle">
      <h1 className="spa-admin__title" id="prestation-nouvelle">
        Nouvelle prestation
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
          Retour au catalogue
        </Link>
      </div>

      <ServiceForm
        tenantSlug={tenantSlug}
        currency={tenant.defaultCurrency}
        categories={categories}
      />
    </section>
  );
}
