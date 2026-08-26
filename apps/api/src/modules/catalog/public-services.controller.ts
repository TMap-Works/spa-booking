import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { PublicServiceDto } from './dto/public-service.dto';
import { PublicServicesService } from './public-services.service';

/**
 * Le catalogue tel qu'un visiteur sans compte le lit, avant de réserver — le
 * quatrième critère de #25 : « le catalogue public expose, par service, les
 * praticiens qui le pratiquent ».
 *
 * ## Le `:tenantSlug` du chemin n'est pas un paramètre de ce contrôleur
 *
 * Il est déclaré parce qu'il est dans l'URL, et il n'est lu nulle part ici.
 * `TenantScopeMiddleware` l'a déjà résolu contre la table `tenants` et a posé
 * l'identifiant obtenu dans le contexte de requête ; c'est de là que le service
 * et le repository tirent l'établissement. Un `@Param('tenantSlug')` dans une
 * méthode ci-dessous serait un retour à « le client choisit son tenant »
 * (tenant-isolation §2) — la chaîne d'URL n'a aucune valeur de preuve, seule sa
 * résolution en a.
 *
 * La conséquence utile : si le slug est inconnu, désactivé, mal formé, ou en
 * désaccord avec le sous-domaine, **aucune méthode de ce fichier ne s'exécute**.
 * Le refus a eu lieu dans le middleware, avant la garde et avant le pipe.
 *
 * ## Pas de garde, et c'est le propos
 *
 * Aucun `@Auth()` : ces routes sont ouvertes, comme celle de la vitrine de
 * l'établissement. Ce qui les rend sûres n'est pas une garde mais ce qu'elles
 * rendent — `PublicServiceDto` et sa liste blanche de champs, alimentée par une
 * projection qui ne lit ni les tampons, ni `is_active`, ni `tenant_id`.
 *
 * ## Pourquoi ce contrôleur vit dans `catalog` et non dans `identity`
 *
 * L'espace d'URL public est partagé, la responsabilité ne l'est pas : une
 * prestation est du catalogue, et c'est `CatalogRepository` qui sait la lire. La
 * ranger auprès de `PublicTenantController` pour la seule raison qu'elles
 * partagent un préfixe d'URL obligerait `identity` à connaître le schéma du
 * catalogue — exactement ce qu'api-module §3 interdit.
 */
@ApiTags('public')
@Controller({ path: 'public/:tenantSlug/services', version: '1' })
@ApiParam({
  name: 'tenantSlug',
  description:
    'Slug public de l’établissement. Résolu contre la table `tenants` par le middleware, ' +
    'avant le contrôleur — un slug inconnu répond 404 sans qu’aucun code métier ne tourne.',
  example: 'salon-des-lilas',
})
export class PublicServicesController {
  public constructor(private readonly services: PublicServicesService) {}

  /**
   * Le catalogue actif de l'établissement, praticiens compris.
   *
   * Une liste vide n'est pas un 404 : un salon qui n'a pas encore saisi son
   * catalogue existe, et sa page de réservation doit pouvoir le dire.
   */
  @Get()
  @ApiOperation({ summary: 'Lister le catalogue public d’un établissement' })
  @ApiOkResponse({ type: [PublicServiceDto] })
  public async list(): Promise<PublicServiceDto[]> {
    return this.services.list();
  }
}
