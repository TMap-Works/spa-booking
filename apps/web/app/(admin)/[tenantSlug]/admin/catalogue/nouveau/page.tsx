import {
  hasAtLeastRole,
  type PublicTenant,
  type ServiceCategory,
  type SessionUser,
} from '@spa/shared';
import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('admin-catalog');
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
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.newService'),
      failedTitle: t('failure.newService'),
    });
  }

  if (!hasAtLeastRole(profile.role, 'manager')) {
    return (
      // `t.rich` et non une phrase coupée en deux clés : le lien est au milieu du
      // texte, et une découpe figerait l'ordre des morceaux d'une langue à
      // l'autre. Le point final reste dans le message, où la ponctuation d'une
      // langue se décide (#849).
      <Notification tone="warning" title={t('newService.restrictedTitle')}>
        <p>
          {t.rich('newService.restrictedBody', {
            link: (parts) => <Link href={adminCatalogPath(tenantSlug)}>{parts}</Link>,
          })}
        </p>
      </Notification>
    );
  }

  return (
    <section aria-labelledby="prestation-nouvelle">
      <h1 className="spa-admin__title" id="prestation-nouvelle">
        {t('newService.title')}
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
          {t('newService.backToCatalog')}
        </Link>
      </div>

      {/* La colonne de saisie est bornée (#630) : sans elle, la zone de contenu
       * vaut la fenêtre moins le rail, et « Durée du soin (minutes) » mesurait
       * 1 637 px à 1920 pour y taper « 60 ». La borne se pose sur un conteneur
       * d'écran et non dans `ServiceForm` : le même formulaire sert la fiche
       * d'une prestation, qui le borne par le même conteneur depuis qu'elle
       * empile ses sections (#768) — deux écrans, une seule mesure, et aucun des
       * deux ne la fait porter au composant. */}
      <div className="spa-admin-form">
        <ServiceForm
          tenantSlug={tenantSlug}
          currency={tenant.defaultCurrency}
          categories={categories}
        />
      </div>
    </section>
  );
}
