import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { CatalogRepository, toServiceView } from './catalog.repository';
import { requireSlug } from './catalog.slug';
import type { Money, ServiceView } from './catalog.types';

/**
 * Prestations du catalogue — CDC §2.3 « services, catégories, durée, prix ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est la garantie. Le repository injecte un client Prisma
 * **scopé** par le contexte de requête, renseigné par `JwtAuthGuard` depuis une
 * revendication signée : une lecture visant la prestation d'un autre
 * établissement rend `null`, que ce service traduit en 404. Aucun `tenantId` ne
 * traverse ces signatures, donc aucune comparaison ne peut être oubliée — et
 * aucun `if` n'a à choisir entre 403 et 404, ce dernier étant le seul admissible
 * (tenant-isolation §4).
 *
 * ## Aucune suppression
 *
 * Le module n'expose pas de `DELETE`, et ce service n'a pas de méthode pour le
 * faire. Une prestation sort du catalogue par `isActive: false` — les
 * rendez-vous passés la référencent, et le reporting doit continuer à savoir ce
 * qui a été vendu. C'est aussi ce que la clé étrangère `Restrict` d'
 * `appointments.service_id` impose en base : un `DELETE` échouerait de toute
 * façon dès la première réservation honorée.
 *
 * ## Le prix ne se démonte pas
 *
 * Il entre et sort en `Money` — entier dans la plus petite unité, plus son code
 * devise. La mise à plat vers `price_amount_minor` / `price_currency` a lieu
 * dans le repository et nulle part ailleurs : deux champs indépendants dans une
 * charge utile peuvent être mis à jour séparément, et il existerait alors un
 * instant où le montant est libellé dans l'ancienne devise.
 */
@Injectable()
export class ServicesService {
  public constructor(private readonly repository: CatalogRepository) {}

  /**
   * Les prestations de l'établissement courant.
   *
   * Un `categoryId` inconnu — ou d'un autre établissement — est **vérifié** et
   * non simplement passé au filtre : sans cela la réponse serait une liste vide,
   * indistinguable d'une rubrique réellement vide. Le 404 dit ce qu'il en est
   * sans rien révéler de plus, puisqu'il couvre aussi bien « n'existe nulle
   * part » que « existe ailleurs ».
   */
  public async list(filters: { activeOnly: boolean; categoryId?: string }): Promise<ServiceView[]> {
    if (filters.categoryId !== undefined) {
      await this.requireCategory(filters.categoryId);
    }

    const services = await this.repository.listServices({
      activeOnly: filters.activeOnly,
      ...(filters.categoryId !== undefined && { categoryId: filters.categoryId }),
    });
    return services.map((service) => toServiceView(service));
  }

  /** Une prestation, par identifiant. 404 hors de l'établissement courant. */
  public async byId(id: string): Promise<ServiceView> {
    const service = await this.repository.findServiceById(id);
    if (service === null) {
      throw new NotFoundError('Prestation introuvable.');
    }
    return toServiceView(service);
  }

  /**
   * Crée une prestation dans l'établissement courant.
   *
   * Les tampons sont facultatifs et valent `0` par défaut — un soin sans temps
   * de préparation est le cas courant, et exiger deux zéros explicites à chaque
   * création ferait du bruit pour rien.
   */
  public async create(input: {
    name: string;
    slug?: string;
    description?: string;
    categoryId?: string;
    durationMinutes: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    price: Money;
  }): Promise<ServiceView> {
    if (input.categoryId !== undefined) {
      await this.requireCategory(input.categoryId);
    }

    const created = await this.repository.createService({
      slug:
        input.slug === undefined ? requireSlug(input.name, 'name') : requireSlug(input.slug, 'slug'),
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      durationMinutes: input.durationMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
      priceAmountMinor: input.price.amountMinor,
      priceCurrency: input.price.currency,
    });
    return toServiceView(created);
  }

  /**
   * Modifie une prestation de l'établissement courant.
   *
   * Le corps est un **patch** : un champ **absent** n'est pas touché, un champ à
   * `null` est effacé. La distinction est celle que JSON permet et qu'un
   * formulaire de back-office réclame : vider un champ de description est un
   * geste ordinaire, et il n'aurait aucun moyen de se dire si l'absence et
   * l'effacement se confondaient. Deux champs sont effaçables — `description` et
   * `categoryId`, ce dernier déclassant la prestation.
   *
   * `isActive` passe par ici et **seulement** par ici : c'est le basculement qui
   * remplace la suppression, et lui donner en plus une route dédiée aurait
   * doublé la surface pour la même écriture.
   */
  public async update(
    id: string,
    patch: {
      name?: string;
      slug?: string;
      description?: string | null;
      categoryId?: string | null;
      durationMinutes?: number;
      bufferBeforeMinutes?: number;
      bufferAfterMinutes?: number;
      price?: Money;
      isActive?: boolean;
    },
  ): Promise<ServiceView> {
    if (patch.categoryId !== undefined && patch.categoryId !== null) {
      await this.requireCategory(patch.categoryId);
    }

    const updated = await this.repository.updateService(id, {
      ...(patch.slug !== undefined && { slug: requireSlug(patch.slug, 'slug') }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
      ...(patch.durationMinutes !== undefined && { durationMinutes: patch.durationMinutes }),
      ...(patch.bufferBeforeMinutes !== undefined && {
        bufferBeforeMinutes: patch.bufferBeforeMinutes,
      }),
      ...(patch.bufferAfterMinutes !== undefined && {
        bufferAfterMinutes: patch.bufferAfterMinutes,
      }),
      ...(patch.price !== undefined && {
        priceAmountMinor: patch.price.amountMinor,
        priceCurrency: patch.price.currency,
      }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    });

    if (updated === null) {
      throw new NotFoundError('Prestation introuvable.');
    }
    return toServiceView(updated);
  }

  /**
   * La catégorie visée appartient-elle à l'établissement courant ?
   *
   * La question se pose **avant** l'écriture pour que le refus soit un 404 qui
   * nomme la catégorie, et non la violation de clé étrangère composite que la
   * base opposerait sinon — remontée en 500, elle serait indistinguable d'un
   * incident. La contrainte reste en base : elle est le garde-fou, ce contrôle
   * n'est que la politesse qui donne un code d'erreur utile.
   */
  private async requireCategory(categoryId: string): Promise<void> {
    const category = await this.repository.findCategoryById(categoryId);
    if (category === null) {
      throw new NotFoundError('Catégorie introuvable.', { categoryId });
    }
  }
}
