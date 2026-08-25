import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { OPENAPI_PATH, configureApp, setupOpenApi } from './bootstrap';
import { AppModule } from './app.module';
import { StructuredLogger } from './common/logging/structured-logger';
import { AppConfigService } from './config/app-config.service';
import { EnvValidationError } from './config/env.schema';

/**
 * Point d'entrée du conteneur.
 *
 * `bufferLogs` retient les traces d'amorçage de Nest le temps que le logger
 * structuré soit disponible : sans lui, les premières lignes sortiraient au
 * format texte par défaut, illisibles pour CloudWatch Logs.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(StructuredLogger);
  app.useLogger(logger);
  app.flushLogs();

  const config = app.get(AppConfigService);
  configureApp(app, config);

  // `setupOpenApi` porte lui-même la garde de production : rien à décider ici.
  const openApiMounted = setupOpenApi(app, config);

  // `0.0.0.0` et non `localhost` : dans un conteneur, une écoute sur la boucle
  // locale n'est pas joignable depuis le réseau de la tâche ECS.
  await app.listen(config.port, '0.0.0.0');

  logger.log(
    `API démarrée sur le port ${config.port}`,
    {
      environment: config.nodeEnv,
      openapi: openApiMounted ? `/${OPENAPI_PATH}` : 'désactivé',
    },
    'Bootstrap',
  );
}

/**
 * Rien n'est journalisé par le logger structuré ici : si l'amorçage échoue, il
 * n'existe pas encore. La sortie d'erreur reste néanmoins du JSON, pour que
 * l'échec de démarrage d'une tâche ECS soit indexable comme le reste.
 */
function reportFatal(error: unknown): void {
  const entry =
    error instanceof EnvValidationError
      ? {
          message: "Démarrage refusé : configuration d'environnement invalide.",
          // `issues` ne cite que des noms de variables — jamais leur valeur,
          // qui peut être un mot de passe de base ou une clé Stripe.
          issues: error.issues,
        }
      : {
          message: "Démarrage refusé : erreur d'amorçage.",
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      context: 'Bootstrap',
      ...entry,
    })}\n`,
  );
}

bootstrap().catch((error: unknown) => {
  reportFatal(error);
  // Sortie non nulle : ECS doit voir la tâche échouer et ne pas la router.
  process.exit(1);
});
