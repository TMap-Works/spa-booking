import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { CatalogRepository } from './catalog.repository';
import { PublicServicesController } from './public-services.controller';
import { PublicServicesService } from './public-services.service';
import { ServiceCategoriesController } from './service-categories.controller';
import { ServiceCategoriesService } from './service-categories.service';
import { ServiceStaffController } from './service-staff.controller';
import { ServiceStaffService } from './service-staff.service';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Module `catalog` — prestations, rubriques, durées, tampons et prix (CDC §2.3).
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, pour deux choses. Ses **gardes** d'abord :
 * `@AuthAtLeast(...)` monte `JwtAuthGuard` et `RolesGuard`, qui ont des
 * dépendances à injecter. Puis, depuis #694, son `UsersService` : créer une
 * fiche praticien exige de vérifier que le compte visé est un compte **interne
 * de l'établissement**, et cette question appartient à `identity`. C'est la voie
 * prévue par api-module §3 — un appel de service, jamais un import du repository
 * d'un autre module. Rien ici n'atteint `IdentityRepository`, et rien ne le
 * doit.
 *
 * ## Ce qu'il exporte, et pourquoi
 *
 * `ServicesService` seulement. Le moteur de disponibilité (#31) et le cycle de
 * vie des rendez-vous (#32) auront besoin d'une lecture synchrone de la durée,
 * des tampons et du prix d'une prestation : c'est un **appel de service**, la
 * première des deux voies autorisées entre modules. Le repository, lui, reste
 * privé — un module n'importe jamais celui d'un autre.
 *
 * `ServiceCategoriesService` n'est pas exporté : une rubrique est une affaire
 * d'affichage du catalogue, et aucun autre module n'a de décision à prendre
 * dessus. `ServiceStaffService` et `PublicServicesService` non plus : le premier
 * n'est qu'un écran de back-office, et le second une projection publique de ce
 * que `ServicesService` sait déjà rendre. Le moteur de disponibilité (#31), qui
 * aura besoin de « quels praticiens pratiquent cette prestation », passera par
 * `ServicesService` — un module n'a pas à choisir entre plusieurs portes.
 *
 * `StaffService` (#421, #694) reste privé, mais plus pour la même raison. Le CDC
 * §2.3 n'attribuait la fiche praticien à aucun module, et tant que personne ne
 * la possédait, personne ne pouvait en créer : un salon neuf restait sans
 * praticien, donc sans créneau. #694 a tranché — c'est `catalog` qui la
 * possède, parce que c'est là que le contrat partagé décrit sa forme et que
 * l'affectation qui la consomme y vit déjà. Il reste privé parce qu'aucun autre
 * module n'a de décision à prendre sur elle : `availability` lit les fiches par
 * son propre dépôt pour calculer des créneaux, ce qui est une lecture de table
 * et non une règle à partager.
 *
 * ## Un contrôleur public dans un module de back-office
 *
 * `PublicServicesController` sert `/api/v1/public/:tenantSlug/services`, sans
 * garde, à côté de `PublicTenantController` qui vit dans `identity`. L'espace
 * d'URL est partagé, la responsabilité ne l'est pas : une prestation est du
 * catalogue, et le ranger dans `identity` pour la seule raison d'un préfixe
 * commun obligerait ce module à connaître le schéma du catalogue (api-module §3).
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    ServicesController,
    ServiceStaffController,
    StaffController,
    ServiceCategoriesController,
    PublicServicesController,
  ],
  providers: [
    ServicesService,
    ServiceStaffService,
    StaffService,
    ServiceCategoriesService,
    PublicServicesService,
    CatalogRepository,
  ],
  exports: [ServicesService],
})
export class CatalogModule {}
