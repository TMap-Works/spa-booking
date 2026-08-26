import { JwtService } from '@nestjs/jwt';

import { InvalidRefreshTokenError } from '../identity.errors';
import { durationToSeconds, hashJti, TokenService } from '../token.service';
import { fakeConfig } from './identity.doubles';

describe('durationToSeconds', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['12h', 43200],
    ['7d', 604800],
  ])('lit %s comme %i secondes', (duration, expected) => {
    expect(durationToSeconds(duration)).toBe(expected);
  });

  it.each(['900', '15 m', 'quinze minutes', '', '15w'])('refuse « %s »', (duration) => {
    // Une durée sans unité est le piège de `jsonwebtoken` : il lirait `"900"`
    // comme 900 **millisecondes**, soit un jeton d'accès valable 0,9 seconde.
    expect(() => durationToSeconds(duration)).toThrow();
  });
});

describe('hashJti', () => {
  it('produit 64 caractères hexadécimaux — la largeur de `token_hash`', () => {
    expect(hashJti('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('est déterministe, et ne recopie pas le `jti`', () => {
    expect(hashJti('meme-valeur')).toBe(hashJti('meme-valeur'));
    expect(hashJti('a')).not.toBe(hashJti('b'));
    // Une fuite de `refresh_tokens` ne doit donner aucune session : l'empreinte
    // ne contient pas la valeur dont elle dérive.
    expect(hashJti('jti-en-clair')).not.toContain('jti-en-clair');
  });
});

describe('TokenService', () => {
  const CLAIMS = { userId: 'user-1', tenantId: 'tenant-1', role: 'STAFF' as const };

  let service: TokenService;

  beforeEach(() => {
    service = new TokenService(new JwtService(), fakeConfig());
  });

  describe('jeton d’accès', () => {
    it('transporte `tenantId` et `role` en revendications vérifiables', async () => {
      const token = await service.signAccessToken(CLAIMS);
      const claims = await service.verifyAccessToken(token);

      expect(claims).toEqual({
        sub: 'user-1',
        tenantId: 'tenant-1',
        role: 'STAFF',
        typ: 'access',
      });
    });

    it('refuse un jeton signé avec une autre clé', async () => {
      const autre = new TokenService(
        new JwtService(),
        fakeConfig({ jwtSecret: 'une-tout-autre-cle-de-signature-000001' }),
      );
      const token = await autre.signAccessToken(CLAIMS);

      expect(await service.verifyAccessToken(token)).toBeNull();
    });

    it('refuse un jeton altéré', async () => {
      const token = await service.signAccessToken(CLAIMS);
      const [header, payload, signature] = token.split('.');
      // Charge utile réécrite pour se déclarer ADMIN d'un autre établissement.
      const forged = Buffer.from(
        JSON.stringify({ sub: 'user-1', tenantId: 'victime', role: 'ADMIN', typ: 'access' }),
      ).toString('base64url');

      expect(header).toBeDefined();
      expect(payload).toBeDefined();
      expect(await service.verifyAccessToken(`${header}.${forged}.${signature}`)).toBeNull();
    });

    it('refuse un jeton expiré', async () => {
      const court = new TokenService(new JwtService(), fakeConfig({ jwtExpiresIn: '1s' }));
      const token = await court.signAccessToken(CLAIMS);

      // `jsonwebtoken` compare à la seconde : on force l'horloge plutôt que
      // d'attendre, pour que la suite reste rapide et déterministe.
      const realNow = Date.now;
      Date.now = (): number => realNow() + 5000;
      try {
        expect(await court.verifyAccessToken(token)).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it.each(['', 'pas-un-jeton', 'a.b.c'])('refuse « %s »', async (token) => {
      expect(await service.verifyAccessToken(token)).toBeNull();
    });

    it('refuse un jeton de rafraîchissement présenté comme jeton d’accès', async () => {
      const refresh = await service.signRefreshToken({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
      });

      // Deux clés distinctes : la vérification échoue avant même que `typ` ne
      // soit consulté. C'est ce qui rend la séparation cryptographique et non
      // conventionnelle.
      expect(await service.verifyAccessToken(refresh.token)).toBeNull();
    });

    it('refuse un rôle hors des trois du schéma', async () => {
      // Un jeton correctement signé mais portant `role: "SUPERADMIN"` — le cas se
      // produit si l'énumération change sans que les jetons en circulation soient
      // invalidés. Il ne doit pas traverser la garde.
      const jwt = new JwtService();
      const config = fakeConfig();
      const token = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1', role: 'SUPERADMIN', typ: 'access' },
        { secret: config.jwtSecret, expiresIn: 900 },
      );

      expect(await service.verifyAccessToken(token)).toBeNull();
    });

    it('refuse un `tenantId` vide — il ouvrirait une portée sur la chaîne vide', async () => {
      const jwt = new JwtService();
      const config = fakeConfig();
      const token = await jwt.signAsync(
        { sub: 'user-1', tenantId: '   ', role: 'CLIENT', typ: 'access' },
        { secret: config.jwtSecret, expiresIn: 900 },
      );

      expect(await service.verifyAccessToken(token)).toBeNull();
    });
  });

  describe('jeton de rafraîchissement', () => {
    it('émet un `jti` neuf à chaque appel, et n’en garde que l’empreinte', async () => {
      const first = await service.signRefreshToken({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
      });
      const second = await service.signRefreshToken({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
      });

      expect(first.jti).not.toBe(second.jti);
      expect(first.tokenHash).toBe(hashJti(first.jti));
      // L'empreinte stockée ne contient pas le secret dont elle dérive.
      expect(first.tokenHash).not.toContain(first.jti);
    });

    it('aligne `expiresAt` sur la durée configurée', async () => {
      const issued = await service.signRefreshToken({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
      });

      const expected = Date.now() + 604800 * 1000;
      // Tolérance large : la suite ne mesure pas l'horloge, elle vérifie l'ordre
      // de grandeur — une erreur d'unité (ms/s) serait hors de cette fenêtre.
      expect(Math.abs(issued.expiresAt.getTime() - expected)).toBeLessThan(10_000);
    });

    it('relit ses propres revendications', async () => {
      const issued = await service.signRefreshToken({
        userId: 'user-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
      });
      const claims = await service.verifyRefreshToken(issued.token);

      expect(claims.sub).toBe('user-1');
      expect(claims.tenantId).toBe('tenant-1');
      expect(claims.sid).toBe('session-1');
      expect(claims.jti).toBe(issued.jti);
      expect(claims.typ).toBe('refresh');
    });

    it('lève sur un jeton illisible plutôt que de rendre `null`', async () => {
      await expect(service.verifyRefreshToken('pas.un.jeton')).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse un jeton d’accès, même bien signé', async () => {
      const access = await service.signAccessToken(CLAIMS);

      await expect(service.verifyRefreshToken(access)).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse un jeton signé de la clé de rafraîchissement mais sans `sid`', async () => {
      const jwt = new JwtService();
      const config = fakeConfig();
      const token = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1', jti: 'x', typ: 'refresh' },
        { secret: config.jwtRefreshSecret, expiresIn: 900 },
      );

      await expect(service.verifyRefreshToken(token)).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });
  });
});
