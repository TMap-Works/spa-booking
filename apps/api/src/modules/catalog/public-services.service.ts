import { Injectable } from '@nestjs/common';

import { CatalogRepository, toPublicServiceView } from './catalog.repository';
import type { PublicServiceView } from './catalog.types';

/**
 * Ce qu'une page de réservation publique a le droit de savoir du catalogue.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2) : le tenant
 * lui arrive par le contexte de requête, résolu par `TenantScopeMiddleware`
 * depuis le sous-domaine ou le slug d'URL. Ce service n'a donc **aucun
 * paramètre d'établissement** — et c'est la propriété qui compte : il n'existe
 * pas de signature par laquelle un appelant pourrait en désigner un autre.
 *
 * Même raisonnement que `PublicTenantService`, et même frontière : ce qui rend
 * cette lecture sûre n'est pas une garde — il n'y en a pas, ces routes sont
 * ouvertes — mais la projection du repository, qui ne lit ni les tampons, ni
 * `is_active`, ni `tenant_id`.
 */
@Injectable()
export class PublicServicesService {
  public constructor(private readonly repository: CatalogRepository) {}

  /**
   * Le catalogue actif de l'établissement de la requête, praticiens compris.
   *
   * Pas de 404 sur une liste vide : un salon qui n'a pas encore saisi son
   * catalogue existe bel et bien, et sa page de réservation doit pouvoir le dire
   * plutôt que de se comporter comme si le salon n'existait pas. Le seul 404 de
   * cet espace d'URL est celui du middleware, sur un slug qui ne désigne aucun
   * établissement.
   *
   * Pas de pagination non plus : le catalogue d'un salon est borné par nature —
   * quelques dizaines de prestations — là où la clientèle ne l'est pas.
   */
  public async list(): Promise<PublicServiceView[]> {
    const services = await this.repository.listPublicServices();
    return services.map((service) => toPublicServiceView(service));
  }
}
