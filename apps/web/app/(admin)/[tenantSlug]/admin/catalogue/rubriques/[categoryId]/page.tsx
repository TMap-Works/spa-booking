import { hasAtLeastRole, uuidSchema, type ServiceCategory, type SessionUser } from '@spa/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { fetchOwnProfile, fetchServiceCategories } from '@/lib/api-client';

import { CatalogStatusBadge } from '../../../components/catalog-status-badge';
import { CategoryForm } from '../../../components/category-manager';
import { adminLoadFailure, requireAdminAccessToken } from '../../../guard';
import { adminServiceCategoriesPath } from '../../../paths';
import { adminServiceCategoryPath } from '../../paths';

/**
 * L'écran d'une rubrique — renommage, description, adresse publique (#769).
 *
 * ## Pourquoi un écran, et non un formulaire déplié dans la ligne
 *
 * Les deux listes du module catalogue ouvrent le même type d'objet à l'édition.
 * La prestation le fait depuis toujours sur une page, atteinte en cliquant son
 * nom dans la liste ; la rubrique le faisait dans la première cellule de sa
 * ligne de tableau, derrière un bouton « Modifier ». La ligne passait alors à
 * quelque 370 px de haut, le nom s'affichait deux fois — dans la cellule et dans
 * le champ —, les trois autres cellules restaient centrées à mi-hauteur loin du
 * formulaire, et deux boutons accentués pleine largeur cohabitaient à l'écran
 * sans rien qui les distingue. C'est l'écart `ds:coherence` relevé par l'audit
 * de conception `d20260916-1`.
 *
 * Mêmes objets, mêmes gestes : le nom mène à l'écran, l'écran porte le
 * formulaire, et le tableau retrouve son rôle de tableau.
 *
 * ## D'où vient la rubrique
 *
 * De la **liste** des rubriques de l'établissement, celle que tout écran du
 * catalogue lit déjà, et sans `activeOnly` : c'est ici qu'on vient rouvrir une
 * rubrique retirée du catalogue, et la masquer donnerait un 404 sur une rubrique
 * qui existe. L'API expose bien `GET /v1/service-categories/{id}` ; il rendrait
 * ici le même verdict pour un aller-retour de même coût, la liste d'un salon
 * tenant en une poignée de lignes.
 *
 * ## Les trois façons de ne pas trouver la rubrique n'en font qu'une
 *
 * Identifiant mal formé, identifiant inconnu, rubrique d'un autre établissement :
 * les trois se répondent `notFound()`, indistinctement (tenant-isolation §4), et
 * `not-found.tsx` en rend l'encart dans l'enveloppe du back-office. C'est la
 * répartition que #697 a posée sur la fiche d'une prestation, et #696 avant elle
 * sur la fiche praticien.
 *
 * ## Le rang qui ouvre l'écran n'est pas celui qui enregistre
 *
 * `GET /v1/service-categories` se lit dès le rang praticien ; `PATCH` est
 * `@AuthAtLeast('MANAGER')`. Le profil est donc lu ici et descendu au
 * formulaire, qui rend ses champs inertes plutôt que de faire découvrir le refus
 * à la soumission (#619) — le geste de `ServiceForm` sur la fiche voisine.
 */

export const dynamic = 'force-dynamic';

interface ServiceCategoryPageProps {
  readonly params: Promise<{ readonly tenantSlug: string; readonly categoryId: string }>;
}

export default async function ServiceCategoryPage({ params }: ServiceCategoryPageProps) {
  const { tenantSlug, categoryId } = await params;
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminServiceCategoryPath(tenantSlug, categoryId),
  );

  /*
   * Un identifiant mal formé ne désigne aucune rubrique : il se refuse ici,
   * avant le moindre aller-retour. Le refus vient **après** la garde, comme sur
   * la fiche d'une prestation (#697) : l'écran d'introuvable est celui du
   * back-office, et une visiteuse sans session doit voir la connexion, pas un
   * 404 qui lui apprendrait la forme des identifiants du salon.
   */
  if (!uuidSchema.safeParse(categoryId).success) {
    notFound();
  }

  let categories: ServiceCategory[];
  let profile: SessionUser;
  try {
    [categories, profile] = await Promise.all([
      fetchServiceCategories(accessToken),
      fetchOwnProfile(accessToken),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint: 'Les rubriques du catalogue sont réservées aux comptes du salon.',
      failedTitle: 'Rubrique indisponible',
    });
  }

  // La liste ne porte que les rubriques de l'établissement du jeton : une
  // rubrique inconnue et une rubrique d'un autre salon y sont absentes de la
  // même façon, et mènent au même écran sous le même statut.
  const category = categories.find((candidate) => candidate.id === categoryId);

  if (category === undefined) {
    notFound();
  }

  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="rubrique-titre">
      <h1 className="spa-admin__title" id="rubrique-titre">
        {category.name}
      </h1>

      <div className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <CatalogStatusBadge isActive={category.isActive} />
          <span className="spa-admin-toolbar__hint">
            Une rubrique désactivée disparaît de la page publique ; les prestations qu’elle regroupe
            restent au catalogue.
          </span>
        </div>
        <span className="spa-admin-toolbar__spacer" />
        <Link
          className="spa-button spa-button--quiet"
          href={adminServiceCategoriesPath(tenantSlug)}
        >
          Retour aux rubriques
        </Link>
      </div>

      {/* Aucun conteneur borné autour : le `<form>` de `CategoryForm` porte
       * lui-même `spa-admin-form` depuis #634, et une seconde borne de 44 rem
       * dans la première ne mesurerait rien de plus. */}
      {/* `key` : l'App Router ne remonte pas ce sous-arbre quand seul
       * `categoryId` change — même type, même position, React réconcilie. Les
       * `defaultValues` de `useForm`, eux, sont figés au montage : sans cette
       * clé, passer d'une rubrique à l'autre sans repasser par la liste
       * afficherait le nom, la description et l'adresse de la **précédente**,
       * et les enregistrerait sur celle-ci. */}
      <CategoryForm
        key={category.id}
        tenantSlug={tenantSlug}
        category={category}
        canManage={canManage}
      />
    </section>
  );
}
