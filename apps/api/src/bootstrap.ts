import { type INestApplication, RequestMethod, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppConfigService } from './config/app-config.service';
import {
  STRIPE_WEBHOOK_PATH,
  stripeWebhookRawBody,
} from './modules/payments/stripe-webhook.raw-body';

/**
 * Câblage transverse de l'application, partagé par `main.ts` et par les tests
 * d'intégration. Tout ce qui n'est pas déclarable dans un module vit ici — et
 * nulle part ailleurs : une différence de configuration entre le processus servi
 * et le processus testé fait passer des tests sur une application qui n'existe
 * pas.
 */

export const API_PREFIX = 'api';
export const API_DEFAULT_VERSION = '1';
export const OPENAPI_PATH = 'api/docs';

/** Routes servies telles quelles, sans `/api` ni `/v1` devant. */
const PREFIX_EXCLUSIONS = [{ path: 'health', method: RequestMethod.GET }];

export function configureApp(app: INestApplication, config: AppConfigService): void {
  // **Avant tout le reste, et ce n'est pas cosmétique.** Nest enregistre
  // `express.json()` dans `init()` — c'est-à-dire après tout ce qui est monté
  // ici. Ce lecteur est donc en amont du parseur global et le prive du seul
  // chemin qui a besoin d'octets non retouchés : la signature d'un webhook
  // Stripe porte sur le corps **brut**, et un aller-retour par `JSON.parse`
  // suffit à la faire échouer systématiquement (payments-stripe §3).
  //
  // Il vit dans `configureApp` plutôt que dans `main.ts` pour la raison qui
  // vaut pour tout ce fichier : les tests d'intégration câblent l'application
  // par cette même fonction, et une exclusion qu'ils n'auraient pas verraient
  // passer au vert une vérification de signature qui n'existe pas en vrai.
  app.use(STRIPE_WEBHOOK_PATH, stripeWebhookRawBody());

  app.setGlobalPrefix(API_PREFIX, { exclude: PREFIX_EXCLUSIONS });

  // Versionnement par URI (api-module §4) : `/api/v1/...`. Un changement cassant
  // ouvre `v2`, il ne modifie jamais `v1`.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_DEFAULT_VERSION });

  app.enableCors({
    // Une seule origine : celle du front. `credentials` impose de nommer
    // l'origine — le joker est refusé par le navigateur dès qu'un cookie est
    // en jeu, et l'authentification en posera un.
    origin: config.appUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // SIGTERM d'ECS → `onModuleDestroy` → pool PostgreSQL et client Redis fermés
  // proprement, au lieu de connexions laissées ouvertes à chaque déploiement.
  app.enableShutdownHooks();
}

/**
 * OpenAPI généré depuis les décorateurs `@nestjs/swagger`, exposé sur
 * `/api/docs` — **jamais en production** (api-module §4). La cartographie
 * complète des routes et de leurs corps est une aide à l'attaque autant qu'à
 * l'intégration.
 *
 * La garde de production vit **ici** plutôt que chez l'appelant : un appelant
 * peut l'oublier, et l'oubli ne se voit pas en recette — seul le déploiement de
 * production exposerait la documentation. Renvoie `true` si le document a été
 * monté, ce qui rend la règle vérifiable par un test.
 */
export function setupOpenApi(app: INestApplication, config: AppConfigService): boolean {
  if (config.isProduction) {
    return false;
  }

  const document = new DocumentBuilder()
    .setTitle('Spa & Salon Booking API')
    .setDescription(
      'API du MVP — réserver, confirmer, honorer, encaisser, mesurer. ' +
        'Toutes les erreurs partagent le corps `{ code, message, details }` ; ' +
        'le client réagit sur `code`, jamais sur `message`.',
    )
    .setVersion(API_DEFAULT_VERSION)
    .addServer(config.apiUrl)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  SwaggerModule.setup(OPENAPI_PATH, app, SwaggerModule.createDocument(app, document), {
    swaggerOptions: { persistAuthorization: true },
  });

  return true;
}
