import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { LoggingModule } from './common/logging/logging.module';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantScopeMiddleware } from './common/tenant/tenant-scope.middleware';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { IdentityModule } from './modules/identity/identity.module';

/**
 * Racine du monolithe modulaire. Les huit modules métier du CDC §2.3
 * (`identity`, `catalog`, `availability`, `appointments`, `crm`, `payments`,
 * `notifications`, `reporting`) viennent s'ajouter ici, chacun dans son issue —
 * `identity` est le premier (#21).
 *
 * Pipe et filtre sont déclarés **par injection** (`APP_PIPE`, `APP_FILTER`)
 * plutôt que par `app.useGlobalPipes()` dans `main.ts` : c'est la seule forme
 * qui les rende actifs dans les tests d'intégration sans dupliquer le câblage,
 * et la seule qui permette au filtre d'injecter le logger.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    // Avant `DatabaseModule` : le client Prisma scopé lit le contexte de tenant.
    TenantContextModule,
    DatabaseModule,
    CacheModule,
    HealthModule,
    // Après `TenantContextModule` et `DatabaseModule` : sa garde renseigne le
    // contexte de tenant, ses repositories consomment le client scopé.
    IdentityModule,
    // Après `IdentityModule`, dont il monte les gardes sur ses routes (#24).
    CatalogModule,
    // Après `IdentityModule` pour la même raison (#32). #41 l'avait laissé hors
    // du graphe faute de route à servir ; les horaires récurrents du personnel
    // en apportent quatre.
    AvailabilityModule,
    // Après `CatalogModule` et `AvailabilityModule`, dont il consomme les
    // services — la durée et les tampons d'une prestation pour l'un, le contrôle
    // « ce créneau était-il proposable ? » pour l'autre (#37). #31 l'avait laissé
    // hors du graphe faute de contrôleur ; la réservation publique en apporte un.
    AppointmentsModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // `whitelist` retire tout champ non déclaré dans le DTO.
        // `forbidNonWhitelisted` va plus loin et **rejette** la requête : sans
        // lui, l'injection d'un `tenantId` dans un corps JSON passerait
        // silencieusement, ce qui est exactement le scénario de fuite qu'on
        // refuse (tenant-isolation).
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        // La conversion implicite ferait passer `"12abc"` pour `12` sur un
        // champ `number`. Les DTO déclarent leur conversion explicitement.
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * La portée de tenant s'ouvre sur **toutes** les routes, sans exception —
   * `/health` et les pages publiques comprises. Une liste d'exclusions serait
   * une liste de routes servies hors contexte, donc la première fuite à écrire.
   *
   * Le motif est `{*path}` et non `*` : Express 5 s'appuie sur path-to-regexp
   * v8, qui rejette le joker nu. Un motif invalide fait échouer l'amorçage —
   * toute la suite d'intégration, qui monte cette application et la sollicite en
   * HTTP, rougirait donc d'un bloc.
   */
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantScopeMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
