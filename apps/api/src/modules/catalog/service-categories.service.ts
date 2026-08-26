import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { CatalogRepository, toCategoryView } from './catalog.repository';
import { requireSlug } from './catalog.slug';
import type { ServiceCategoryView } from './catalog.types';

/**
 * Catégories du catalogue — CDC §2.3 « services, catégories ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture visant la catégorie d'un autre établissement ne la trouve donc pas —
 * elle rend `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4). Ne pas avoir l'information est la
 * meilleure garantie de ne pas la divulguer.
 *
 * ## Pas de suppression, et pas de règle croisée non plus
 *
 * Une catégorie **se désactive**, elle ne s'efface pas : des prestations la
 * référencent, et le reporting doit continuer à savoir sous quelle rubrique une
 * vente a été faite. La contrainte `Restrict` en base le garantit même si un
 * jour un `DELETE` était écrit par mégarde.
 *
 * Ce qui n'est délibérément **pas** interdit : désactiver une catégorie qui
 * classe encore des prestations actives. Une rubrique retirée du catalogue ne
 * retire pas les soins qu'elle regroupait — ils restent vendables et gardent
 * leur rattachement, ce qui permet précisément de reclasser à froid. Interdire
 * le geste aurait obligé l'administrateur à défaire son catalogue avant de
 * pouvoir le réorganiser, et aurait introduit une règle croisée entre deux
 * entités pour un problème d'affichage que le front tranche seul.
 */
@Injectable()
export class ServiceCategoriesService {
  public constructor(private readonly repository: CatalogRepository) {}

  /** Les catégories de l'établissement courant. */
  public async list(activeOnly: boolean): Promise<ServiceCategoryView[]> {
    const categories = await this.repository.listCategories(activeOnly);
    return categories.map((category) => toCategoryView(category));
  }

  /**
   * Une catégorie, par identifiant.
   *
   * Le 404 couvre indistinctement « n'existe nulle part » et « existe dans un
   * autre établissement » — et c'est exactement ce qu'il faut : la différence
   * entre les deux est précisément l'information à ne pas donner.
   */
  public async byId(id: string): Promise<ServiceCategoryView> {
    const category = await this.repository.findCategoryById(id);
    if (category === null) {
      throw new NotFoundError('Catégorie introuvable.');
    }
    return toCategoryView(category);
  }

  public async create(input: {
    name: string;
    slug?: string;
    description?: string;
  }): Promise<ServiceCategoryView> {
    const created = await this.repository.createCategory({
      slug:
        input.slug === undefined ? requireSlug(input.name, 'name') : requireSlug(input.slug, 'slug'),
      name: input.name,
      description: input.description ?? null,
    });
    return toCategoryView(created);
  }

  /**
   * Modifie une catégorie de l'établissement courant.
   *
   * Le corps est un **patch** : un champ **absent** n'est pas touché, un champ à
   * `null` est effacé. `description` est le seul effaçable ici — vider un texte
   * de présentation est un geste ordinaire de back-office, et il n'aurait aucun
   * moyen de se dire si l'absence et l'effacement se confondaient.
   */
  public async update(
    id: string,
    patch: { name?: string; slug?: string; description?: string | null; isActive?: boolean },
  ): Promise<ServiceCategoryView> {
    const updated = await this.repository.updateCategory(id, {
      ...(patch.slug !== undefined && { slug: requireSlug(patch.slug, 'slug') }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    });

    if (updated === null) {
      throw new NotFoundError('Catégorie introuvable.');
    }
    return toCategoryView(updated);
  }
}
