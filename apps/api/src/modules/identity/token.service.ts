import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AppConfigService } from '../../config/app-config.service';
import { InvalidRefreshTokenError } from './identity.errors';
import { USER_ROLES, type UserRole } from './identity.types';

/**
 * Émission et vérification des deux jetons.
 *
 * ## Deux jetons, deux clés, deux durées
 *
 * Le jeton d'**accès** voyage à chaque requête : c'est le plus exposé, et il
 * n'est pas révocable — rien n'est consulté en base pour l'accepter. Sa durée
 * courte (`JWT_EXPIRES_IN`, 15 min) est donc la seule chose qui borne la fenêtre
 * d'un vol.
 *
 * Le jeton de **rafraîchissement** ne voyage que vers `/auth/refresh`, vit
 * longtemps, et il est **révocable** : une ligne `refresh_tokens` le gage.
 *
 * Les deux clés sont distinctes (`env.schema.ts` refuse qu'elles soient égales).
 * Avec une clé unique, un jeton d'accès dérobé se présenterait comme jeton de
 * rafraîchissement et passerait la vérification cryptographique ; seule la
 * revendication `typ` l'en distinguerait, et une convention applicative n'est pas
 * une barrière. `typ` est vérifié malgré tout — ceinture et bretelles.
 */

/** Revendication de type — un jeton d'un usage ne sert jamais dans l'autre. */
export const TOKEN_TYPES = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;

export interface AccessTokenClaims {
  /** Identifiant du compte — `sub`, comme le veut la RFC 7519. */
  sub: string;
  tenantId: string;
  role: UserRole;
  typ: typeof TOKEN_TYPES.ACCESS;
}

export interface RefreshTokenClaims {
  sub: string;
  tenantId: string;
  /** Identifiant de la **session** — la ligne `refresh_tokens` à consulter. */
  sid: string;
  /**
   * Aléa de 256 bits propre à cette émission. La base n'en garde que l'empreinte
   * SHA-256 ; présenter un `jti` qui ne correspond plus, c'est rejouer un jeton
   * déjà consommé.
   */
  jti: string;
  typ: typeof TOKEN_TYPES.REFRESH;
}

export interface IssuedRefreshToken {
  token: string;
  jti: string;
  tokenHash: string;
  expiresAt: Date;
}

/** `true` si la valeur est l'un des trois rôles du schéma. */
function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Convertit une durée `jsonwebtoken` (`15m`, `7d`) en secondes.
 *
 * Le format est déjà contraint par `env.schema.ts` — unité obligatoire. Cette
 * fonction refuse quand même ce qu'elle ne comprend pas : elle sert aussi à
 * calculer l'`expiresAt` écrit en base, et un défaut silencieux y produirait des
 * sessions mortes à l'émission.
 */
const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function durationToSeconds(duration: string): number {
  const parsed = /^(\d+)([smhd])$/.exec(duration);
  if (parsed === null) {
    throw new Error(`Durée « ${duration} » illisible : unité s, m, h ou d attendue.`);
  }
  const amount = Number(parsed[1]);
  const unit = parsed[2];
  const seconds = unit === undefined ? undefined : SECONDS_PER_UNIT[unit];
  if (seconds === undefined) {
    throw new Error(`Durée « ${duration} » illisible : unité s, m, h ou d attendue.`);
  }
  return amount * seconds;
}

/**
 * Empreinte SHA-256 hexadécimale — 64 caractères, la largeur de `token_hash`.
 *
 * SHA-256 nu suffit ici, là où un mot de passe exige bcrypt : le `jti` est un
 * aléa de 256 bits, il n'a aucun espace de recherche à ralentir. Une fuite de la
 * table ne donne donc aucune session.
 */
export function hashJti(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}

@Injectable()
export class TokenService {
  public constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  public get accessTokenTtlSeconds(): number {
    return durationToSeconds(this.config.jwtExpiresIn);
  }

  public get refreshTokenTtlSeconds(): number {
    return durationToSeconds(this.config.refreshTokenExpiresIn);
  }

  /**
   * Émet le jeton d'accès. `tenantId` et `role` y sont des revendications
   * **signées** : c'est ce qui permet à la garde de les traiter comme une donnée
   * serveur au lieu d'aller les relire en base à chaque requête.
   */
  public async signAccessToken(claims: {
    userId: string;
    tenantId: string;
    role: UserRole;
  }): Promise<string> {
    const payload: AccessTokenClaims = {
      sub: claims.userId,
      tenantId: claims.tenantId,
      role: claims.role,
      typ: TOKEN_TYPES.ACCESS,
    };

    // `expiresIn` est passé en **secondes**, pas sous sa forme textuelle.
    // `jsonwebtoken` lit un nombre comme des secondes sans ambiguïté, là où une
    // chaîne de chiffres sans unité passerait pour des millisecondes. La forme
    // textuelle a déjà été validée par `env.schema.ts` ; la convertir ici retire
    // le dernier endroit où elle pourrait être mal lue.
    return this.jwt.signAsync(payload, {
      secret: this.config.jwtSecret,
      expiresIn: this.accessTokenTtlSeconds,
    });
  }

  /**
   * Émet un jeton de rafraîchissement pour une session donnée, avec un `jti`
   * neuf. Appelé à la connexion **et** à chaque rotation.
   */
  public async signRefreshToken(claims: {
    userId: string;
    tenantId: string;
    sessionId: string;
  }): Promise<IssuedRefreshToken> {
    // 32 octets d'aléa cryptographique — pas un UUID : un UUID v4 ne porte que
    // 122 bits d'entropie et sa forme est devinable.
    const jti = randomBytes(32).toString('hex');

    const payload: RefreshTokenClaims = {
      sub: claims.userId,
      tenantId: claims.tenantId,
      sid: claims.sessionId,
      jti,
      typ: TOKEN_TYPES.REFRESH,
    };

    const ttlSeconds = this.refreshTokenTtlSeconds;
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.jwtRefreshSecret,
      expiresIn: ttlSeconds,
    });

    return {
      token,
      jti,
      tokenHash: hashJti(jti),
      // Calculé depuis la **même** durée que l'`exp` du jeton : les deux
      // expirations doivent coïncider, sans quoi la base et le porteur se
      // contrediraient sur la fin de la session.
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  /**
   * Vérifie un jeton d'accès. Renvoie `null` sur tout échec — signature, date
   * d'expiration, forme des revendications — sans jamais dire lequel.
   */
  public async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtSecret,
      });
    } catch {
      return null;
    }

    if (payload === null || typeof payload !== 'object') {
      return null;
    }

    const record = payload as Record<string, unknown>;
    // `typ` est revérifié bien que les clés soient distinctes : la séparation des
    // clés est ce qui *garantit*, cette vérification est ce qui le *dit*. Si un
    // déploiement venait à réutiliser la même clé, elle resterait la dernière
    // barrière.
    if (record['typ'] !== TOKEN_TYPES.ACCESS) {
      return null;
    }
    if (typeof record['sub'] !== 'string' || typeof record['tenantId'] !== 'string') {
      return null;
    }
    if (!isUserRole(record['role'])) {
      return null;
    }
    // Un `tenantId` vide passerait `typeof === 'string'` et ouvrirait une portée
    // de tenant sur la chaîne vide.
    if (record['sub'].trim() === '' || record['tenantId'].trim() === '') {
      return null;
    }

    return {
      sub: record['sub'],
      tenantId: record['tenantId'],
      role: record['role'],
      typ: TOKEN_TYPES.ACCESS,
    };
  }

  /**
   * Vérifie un jeton de rafraîchissement.
   *
   * Lève plutôt que de rendre `null` : contrairement au jeton d'accès, dont
   * l'absence est un cas courant sur une route publique, un jeton de
   * rafraîchissement illisible n'a qu'une seule issue — la session est refusée.
   */
  public async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.jwtRefreshSecret,
      });
    } catch {
      throw new InvalidRefreshTokenError();
    }

    if (payload === null || typeof payload !== 'object') {
      throw new InvalidRefreshTokenError();
    }

    const record = payload as Record<string, unknown>;
    if (record['typ'] !== TOKEN_TYPES.REFRESH) {
      throw new InvalidRefreshTokenError();
    }
    const sub = record['sub'];
    const tenantId = record['tenantId'];
    const sid = record['sid'];
    const jti = record['jti'];
    if (
      typeof sub !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof sid !== 'string' ||
      typeof jti !== 'string' ||
      sub.trim() === '' ||
      tenantId.trim() === '' ||
      sid.trim() === '' ||
      jti.trim() === ''
    ) {
      throw new InvalidRefreshTokenError();
    }

    return { sub, tenantId, sid, jti, typ: TOKEN_TYPES.REFRESH };
  }
}
