import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

/**
 * Charge et **valide** l'environnement au démarrage. `validate` est appelé par
 * @nestjs/config pendant l'initialisation du module : une variable manquante
 * fait échouer `NestFactory.create`, l'application ne sert aucune requête.
 *
 * En déployé, les valeurs viennent d'AWS Secrets Manager via la définition de
 * tâche ECS — aucun fichier `.env` n'est lu (`ignoreEnvFile`).
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: false,
      // Relatif au répertoire de lancement : `apps/api/.env.local` en premier,
      // sinon le `.env.local` de la racine du monorepo (copie de .env.example).
      envFilePath: ['.env.local', '../../.env.local'],
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
