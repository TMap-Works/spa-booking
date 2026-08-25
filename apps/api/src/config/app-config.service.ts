import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env, LogLevelName, NodeEnv } from './env.schema';

/**
 * Seul point d'accès à la configuration dans le code applicatif.
 *
 * Le reste de l'API n'appelle jamais `process.env` ni `ConfigService.get` avec
 * une chaîne libre : une faute de frappe donnerait `undefined` au lieu d'une
 * erreur de compilation.
 */
@Injectable()
export class AppConfigService {
  public constructor(private readonly config: ConfigService<Env, true>) {}

  public get nodeEnv(): NodeEnv {
    return this.config.get('NODE_ENV', { infer: true });
  }

  public get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  public get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  /** Origine du front Next.js — sert de liste blanche CORS. */
  public get appUrl(): string {
    return this.config.get('APP_URL', { infer: true });
  }

  /** URL publique de l'API — déclarée comme serveur dans le document OpenAPI. */
  public get apiUrl(): string {
    return this.config.get('API_URL', { infer: true });
  }

  public get databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  public get redisUrl(): string {
    return this.config.get('REDIS_URL', { infer: true });
  }

  public get logLevel(): LogLevelName {
    return this.config.get('LOG_LEVEL', { infer: true });
  }
}
