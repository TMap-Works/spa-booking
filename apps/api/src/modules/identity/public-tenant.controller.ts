import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { PublicTenantDto } from './dto/public-tenant.dto';
import { PublicTenantService } from './public-tenant.service';

/**
 * L'espace d'URL **public** : ce qu'un visiteur sans compte peut lire d'un salon
 * avant de réserver.
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
 * Aucun `@Auth()` : ces routes sont ouvertes. Ce qui les rend sûres n'est pas
 * une garde mais ce qu'elles rendent — `PublicTenantDto` et sa liste blanche de
 * champs. Toute route ajoutée ici hérite de la même règle : elle ne peut publier
 * que des données destinées au public, et le back-office reste derrière
 * `JwtAuthGuard` sur son propre espace d'URL.
 */
@ApiTags('public')
@Controller({ path: 'public/:tenantSlug', version: '1' })
@ApiParam({
  name: 'tenantSlug',
  description:
    'Slug public de l’établissement. Résolu contre la table `tenants` par le middleware, ' +
    'avant le contrôleur — un slug inconnu répond 404 sans qu’aucun code métier ne tourne.',
  example: 'salon-des-lilas',
})
export class PublicTenantController {
  public constructor(private readonly tenants: PublicTenantService) {}

  @Get()
  @ApiOperation({ summary: 'Lire la vitrine publique d’un établissement' })
  @ApiOkResponse({ type: PublicTenantDto })
  public async currentTenant(): Promise<PublicTenantDto> {
    return this.tenants.currentTenant();
  }
}
