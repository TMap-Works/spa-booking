import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { LoggingModule } from './common/logging/logging.module';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';

/**
 * Racine du monolithe modulaire. Les huit modules métier du CDC §2.3
 * (`identity`, `catalog`, `availability`, `appointments`, `crm`, `payments`,
 * `notifications`, `reporting`) viendront s'ajouter ici, chacun dans son issue.
 *
 * Pipe et filtre sont déclarés **par injection** (`APP_PIPE`, `APP_FILTER`)
 * plutôt que par `app.useGlobalPipes()` dans `main.ts` : c'est la seule forme
 * qui les rende actifs dans les tests d'intégration sans dupliquer le câblage,
 * et la seule qui permette au filtre d'injecter le logger.
 */
@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, CacheModule, HealthModule],
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
export class AppModule {}
