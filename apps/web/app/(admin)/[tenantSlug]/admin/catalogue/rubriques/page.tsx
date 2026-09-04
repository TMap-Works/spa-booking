import type { ServiceCategory } from '@spa/shared';
import Link from 'next/link';

import { fetchServiceCategories } from '@/lib/api-client';

import { CategoryManager } from '../../components/category-manager';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath } from '../../paths';

/**
 * Rubriques du catalogue (#52, deuxième critère).
 *
 * `activeOnly` n'est pas posé : c'est l'écran où l'on vient remettre en ligne une
 * rubrique retirée, et la masquer inviterait à en recréer une du même nom — pour
 * se heurter au conflit d'unicité de son slug.
 */

export const dynamic = 'force-dynamic';

interface CategoriesPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function ServiceCategoriesPage({ params }: CategoriesPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug);

  let categories: ServiceCategory[];
  try {
    categories = await fetchServiceCategories(accessToken);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint: 'Les rubriques du catalogue sont réservées aux comptes du salon.',
      failedTitle: 'Rubriques indisponibles',
    });
  }

  return (
    <section aria-labelledby="rubriques-titre">
      <h1 className="spa-admin__title" id="rubriques-titre">
        Rubriques du catalogue
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
          Retour au catalogue
        </Link>
        <span className="spa-admin-toolbar__spacer" />
        <p className="spa-admin-toolbar__hint">
          Une rubrique regroupe les prestations sur la page publique. Elle se désactive, elle ne se
          supprime pas — le reporting doit continuer à savoir sous quelle rubrique une vente a été
          faite.
        </p>
      </div>

      <CategoryManager tenantSlug={tenantSlug} categories={categories} />
    </section>
  );
}
