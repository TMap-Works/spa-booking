import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AppConfigService } from '../../../config/app-config.service';

/**
 * Le jeton de la console plateforme — un troisième usage, une troisième clé.
 *
 * ## Pourquoi un service à part de `TokenService`
 *
 * Parce que les deux ne décrivent pas la même chose. `TokenService` émet des
 * jetons **d'établissement** : chacune de ses charges utiles porte un
 * `tenantId`, et c'est cette revendication que `JwtAuthGuard` pose dans le
 * contexte pour armer le scoping. Un opérateur plateforme n'a pas
 * d'établissement (ADR 0012) : sa charge utile n'en porte pas, et confondre les
 * deux services aurait mis côte à côte des jetons dont l'un ouvre une portée et
 * l'autre non — la distinction la plus importante de ce module, rangée dans le
 * même fichier.
 *
 * ## La clé est dérivée, comme celle des invitations
 *
 * `HMAC-SHA256(secret de rafraîchissement, étiquette)` donne une clé de 256 bits
 * indépendante des deux autres, sans déclarer de variable d'environnement de
 * plus. C'est exactement la conduite que `TokenService` retient pour les
 * invitations, et pour la même raison : deux étiquettes distinctes donnent deux
 * clés dont la connaissance de l'une ne livre pas l'autre.
 *
 * C'est aussi ce qui rend l'**étanchéité du critère 5 cryptographique** plutôt
 * qu'applicative. Un jeton d'accès d'établissement présenté ici échoue à la
 * vérification de signature : il a été signé avec `JWT_SECRET`, jamais avec
 * cette clé-ci. Et un jeton plateforme présenté à une route d'établissement
 * échoue symétriquement chez `TokenService.verifyAccessToken`. Aucune
 * comparaison de champ ne garde cette frontière — donc aucune ne peut être
 * oubliée.
 *
 * Le secret de **rafraîchissement** est choisi comme racine plutôt que celui
 * d'accès : il ne voyage que vers `/auth/refresh`, il est donc le moins exposé.
 */

/**
 * Étiquette de dérivation — **la valeur fait partie du contrat
 * cryptographique**. La changer invalide toutes les sessions de console en
 * cours ; le `-v1` est là pour qu'une rotation délibérée s'écrive.
 */
const PLATFORM_KEY_LABEL = 'spa-booking/platform-access-v1';

/** Revendication de type — un jeton d'un usage ne sert jamais dans un autre. */
export const PLATFORM_TOKEN_TYPE = 'platform';

/**
 * Durée de vie d'un jeton de console — trente minutes.
 *
 * Plus long que les quinze minutes d'un jeton d'établissement, et pourtant plus
 * strict : il n'y a **aucun** jeton de rafraîchissement de ce côté-ci
 * (ADR 0012, point 3). Passé ce délai, l'opérateur se reconnecte, second facteur
 * compris. Une chaîne de rafraîchissement aurait rendu la MFA franchissable une
 * fois pour toutes, ce qui est exactement ce qu'on refuse sur une console qui
 * ouvre tous les salons.
 *
 * Une constante de module plutôt qu'une variable d'environnement : la valeur n'a
 * aucune raison de varier d'un environnement à l'autre, et la déclarer toucherait
 * `config/env.schema.ts`, hors de l'empreinte de #806.
 */
export const PLATFORM_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * Les revendications d'un jeton de console. **Pas de `tenantId`**, et c'est la
 * moitié du propos : rien, dans ce jeton, ne peut armer la portée d'un
 * établissement.
 */
export interface PlatformTokenClaims {
  /** Identifiant de l'opérateur — `sub`, comme le veut la RFC 7519. */
  sub: string;
  typ: typeof PLATFORM_TOKEN_TYPE;
}

@Injectable()
export class PlatformTokenService {
  public constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  public get accessTokenTtlSeconds(): number {
    return PLATFORM_TOKEN_TTL_SECONDS;
  }

  /**
   * La clé de la console — dérivée à chaque appel.
   *
   * Un HMAC-SHA256 sur quelques dizaines d'octets se compte en microsecondes, et
   * les connexions de console sont rares. Mémoriser la valeur ferait vivre une
   * clé dans le champ d'une instance pour rien.
   */
  private get platformSecret(): string {
    return createHmac('sha256', this.config.jwtRefreshSecret)
      .update(PLATFORM_KEY_LABEL)
      .digest('hex');
  }

  public async signAccessToken(operatorId: string): Promise<string> {
    const payload: PlatformTokenClaims = { sub: operatorId, typ: PLATFORM_TOKEN_TYPE };
    return this.jwt.signAsync(payload, {
      secret: this.platformSecret,
      // En **secondes**, jamais sous forme textuelle : `jsonwebtoken` lit une
      // chaîne de chiffres sans unité comme des millisecondes.
      expiresIn: PLATFORM_TOKEN_TTL_SECONDS,
    });
  }

  /**
   * Vérifie un jeton de console. Rend `null` sur tout échec — signature,
   * expiration, forme des revendications — sans jamais dire lequel.
   *
   * C'est ici que tombe un jeton d'établissement présenté à la console : signé
   * par une autre clé, il n'atteint jamais la lecture des revendications.
   */
  public async verifyAccessToken(token: string): Promise<PlatformTokenClaims | null> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.platformSecret,
      });
    } catch {
      return null;
    }

    if (payload === null || typeof payload !== 'object') {
      return null;
    }

    const record = payload as Record<string, unknown>;
    // `typ` est revérifié bien que la clé soit propre : la séparation des clés
    // est ce qui *garantit*, cette vérification est ce qui le *dit*.
    if (record['typ'] !== PLATFORM_TOKEN_TYPE) {
      return null;
    }
    const sub = record['sub'];
    if (typeof sub !== 'string' || sub.trim() === '') {
      return null;
    }
    // Un jeton de console ne porte **jamais** de `tenantId`. En rencontrer un
    // signifie qu'une charge utile d'établissement a été signée avec cette clé —
    // impossible sans un défaut de câblage, et pas une situation qu'on tolère en
    // silence.
    if (record['tenantId'] !== undefined) {
      return null;
    }

    return { sub, typ: PLATFORM_TOKEN_TYPE };
  }
}
