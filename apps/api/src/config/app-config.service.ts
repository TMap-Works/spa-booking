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

  /**
   * Environnement **déployé** — `staging` autant que `production`.
   *
   * À ne pas confondre avec `isProduction`, qui gouverne ce qui ne doit exister
   * qu'en production (la documentation OpenAPI, par exemple). Ce drapeau-ci
   * gouverne ce qui dépend du **transport** : `staging` sert en HTTPS derrière
   * l'ALB exactement comme la production, et un attribut `Secure` relâché y
   * exposerait un cookie de session en clair.
   */
  public get isDeployed(): boolean {
    return this.nodeEnv === 'staging' || this.nodeEnv === 'production';
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

  /** Secret de signature des jetons d'**accès** — module `identity` uniquement. */
  public get jwtSecret(): string {
    return this.config.get('JWT_SECRET', { infer: true });
  }

  /** Secret de signature des jetons de **rafraîchissement**, distinct du précédent. */
  public get jwtRefreshSecret(): string {
    return this.config.get('JWT_REFRESH_SECRET', { infer: true });
  }

  /** Durée de vie du jeton d'accès, au format `jsonwebtoken` (« 15m »). */
  public get jwtExpiresIn(): string {
    return this.config.get('JWT_EXPIRES_IN', { infer: true });
  }

  /** Durée de vie de la session de rafraîchissement (« 7d »). */
  public get refreshTokenExpiresIn(): string {
    return this.config.get('REFRESH_TOKEN_EXPIRES_IN', { infer: true });
  }

  /** Coût bcrypt — `2^coût` itérations par vérification de mot de passe. */
  public get bcryptCost(): number {
    return this.config.get('BCRYPT_COST', { infer: true });
  }
}
