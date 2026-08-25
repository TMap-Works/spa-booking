import type { INestApplication, LoggerService, ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp, setupOpenApi } from '../../src/bootstrap';
import { AppConfigService } from '../../src/config/app-config.service';
import { CacheConnection } from '../../src/infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../../src/infrastructure/database/database.connection';

/**
 * Amorçage d'une application réelle pour les tests d'intégration.
 *
 * L'application est câblée par `configureApp` — la **même** fonction que
 * `main.ts` : préfixe, versionnement, CORS, arrêt propre. Un test qui
 * reconstruirait ce câblage à la main validerait une application qui n'existe
 * nulle part.
 *
 * Seules les deux connexions d'infrastructure sont remplacées. Ce ne sont pas
 * les dépendances qu'on veut prouver ici — `pg` et `ioredis` sont testés par
 * leurs auteurs — mais le comportement de l'API *selon* leur état : c'est le
 * seul moyen d'exercer le chemin « dépendance tombée » de façon déterministe,
 * sans arrêter un conteneur au milieu d'une suite. Le retour d'un `SELECT 1`
 * réel relève du déploiement de recette (DoD de #18), pas d'un test unitaire de
 * pilote.
 */

/** Double contrôlable d'une connexion d'infrastructure. */
export class ProbeDouble {
  private outcome: 'up' | Error | 'hang' = 'up';

  public failWith(message: string): void {
    this.outcome = new Error(message);
  }

  /** La sonde ne répond jamais — exerce le délai de garde de `HealthService`. */
  public hang(): void {
    this.outcome = 'hang';
  }

  public async ping(): Promise<void> {
    if (this.outcome === 'hang') {
      return new Promise<void>(() => undefined);
    }
    if (this.outcome !== 'up') {
      throw this.outcome;
    }
  }

  public async onModuleDestroy(): Promise<void> {
    // Rien à fermer : aucune socket n'a été ouverte.
  }
}

/** Logger muet — l'échec de démarrage *attendu* par un test n'est pas un incident. */
export const SILENT_LOGGER: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

export interface TestApp {
  app: INestApplication;
  database: ProbeDouble;
  cache: ProbeDouble;
  /** `true` si le document OpenAPI a été monté — faux en production. */
  openApiMounted: boolean;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /**
   * Modules de test montés à côté d'`AppModule` — voir `fixtures/probe.module.ts`.
   *
   * Typé par `ModuleMetadata['imports']`, la déclaration même de Nest : elle
   * couvre aussi les modules dynamiques, et évite d'écrire ici le `any` que
   * `Type<any>` aurait imposé.
   */
  imports?: ModuleMetadata['imports'];
  /** Monte aussi OpenAPI, comme le fait `main.ts`. */
  withOpenApi?: boolean;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const database = new ProbeDouble();
  const cache = new ProbeDouble();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(DatabaseConnection)
    .useValue(database)
    .overrideProvider(CacheConnection)
    .useValue(cache)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  const config = app.get(AppConfigService);
  configureApp(app, config);

  // **Avant** `init`, comme dans `main.ts` — où `setupOpenApi` s'exécute entre
  // `NestFactory.create` et `listen()`, et où c'est `listen()` qui appelle
  // `init()`. L'ordre n'est pas cosmétique : `init()` referme la pile HTTP par
  // le gestionnaire « route inconnue » de Nest, et toute route montée après lui
  // est inatteignable — le document répondrait 404 en test alors qu'il est servi
  // en vrai. `createDocument` n'a pas besoin des routes Express : il parcourt
  // les contrôleurs du conteneur, déjà peuplé par `compile()`.
  const openApiMounted = options.withOpenApi === true ? setupOpenApi(app, config) : false;

  await app.init();

  return {
    app,
    database,
    cache,
    openApiMounted,
    close: () => app.close(),
  };
}
