import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { CatalogRepository } from './catalog.repository';
import { ServiceCategoriesController } from './service-categories.controller';
import { ServiceCategoriesService } from './service-categories.service';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

/**
 * Module `catalog` — prestations, rubriques, durées, tampons et prix (CDC §2.3).
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, et seulement pour ses **gardes** : `@AuthAtLeast(...)` monte
 * `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter. C'est la
 * voie prévue par api-module §3 — un appel de service, jamais un import du
 * repository d'un autre module. Rien ici n'atteint `IdentityRepository`, et rien
 * ne le doit.
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
 * dessus.
 */
@Module({
  imports: [IdentityModule],
  controllers: [ServicesController, ServiceCategoriesController],
  providers: [ServicesService, ServiceCategoriesService, CatalogRepository],
  exports: [ServicesService],
})
export class CatalogModule {}
