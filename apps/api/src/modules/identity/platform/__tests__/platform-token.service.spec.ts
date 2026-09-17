import { JwtService } from '@nestjs/jwt';

import { TokenService } from '../../token.service';
import { fakeConfig } from '../../__tests__/identity.doubles';
import { PLATFORM_TOKEN_TTL_SECONDS, PlatformTokenService } from '../platform-token.service';

/**
 * L'étanchéité des deux espaces — critère 5 de #806, vu depuis la
 * cryptographie.
 *
 * Le critère est énoncé en HTTP : « un jeton d'établissement reçoit 401 sur
 * toute route `/v1/platform/*`, un jeton plateforme reçoit 401 sur toute route
 * d'établissement ». `platform-console.isolation-spec.ts` le prouve à ce
 * niveau-là. Cette suite prouve **pourquoi** c'est vrai, et pourquoi cela le
 * restera : les deux vérificateurs ne partagent aucune clé, si bien que le refus
 * ne dépend d'aucune comparaison de champ — donc d'aucune ligne qu'on pourrait
 * oublier d'écrire en ajoutant une route.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

interface Fixture {
  platform: PlatformTokenService;
  tenant: TokenService;
}

function fixture(): Fixture {
  // La **même** configuration pour les deux : c'est ce qui rend la
  // démonstration probante. Si l'étanchéité tenait à des secrets différents en
  // configuration, elle tomberait le jour où quelqu'un les aligne par erreur.
  const config = fakeConfig();
  return {
    platform: new PlatformTokenService(new JwtService(), config),
    tenant: new TokenService(new JwtService(), config),
  };
}

describe('Jeton de console plateforme', () => {
  it('se vérifie lui-même et rend l’opérateur qu’il désigne', async () => {
    const { platform } = fixture();
    const token = await platform.signAccessToken(OPERATOR);

    expect(await platform.verifyAccessToken(token)).toEqual({ sub: OPERATOR, typ: 'platform' });
  });

  it('ne porte **aucun** `tenantId`', async () => {
    const { platform } = fixture();
    const token = await platform.signAccessToken(OPERATOR);

    // La charge utile décodée sans vérifier : on regarde ce qui voyage, pas ce
    // que le vérificateur veut bien en rendre.
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(payload['tenantId']).toBeUndefined();
    expect(payload['sub']).toBe(OPERATOR);
  });

  it('annonce sa durée de vie, et elle est courte', () => {
    const { platform } = fixture();
    expect(platform.accessTokenTtlSeconds).toBe(PLATFORM_TOKEN_TTL_SECONDS);
    // Une console qui ouvre tous les salons ne garde pas une session ouverte la
    // journée : il n'y a aucun jeton de rafraîchissement de ce côté-ci.
    expect(PLATFORM_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
  });
});

describe('Étanchéité des deux espaces — critère 5', () => {
  it('refuse un jeton d’accès d’établissement, même ADMIN', async () => {
    const { platform, tenant } = fixture();
    const access = await tenant.signAccessToken({
      userId: '44444444-4444-4444-8444-444444444444',
      tenantId: TENANT,
      role: 'ADMIN',
    });

    expect(await platform.verifyAccessToken(access)).toBeNull();
  });

  it('refuse un jeton d’invitation d’établissement', async () => {
    const { platform, tenant } = fixture();
    const invitation = await tenant.signInvitationToken({
      userId: '44444444-4444-4444-8444-444444444444',
      tenantId: TENANT,
    });

    expect(await platform.verifyAccessToken(invitation.token)).toBeNull();
  });

  it('son propre jeton est refusé par le vérificateur d’établissement', async () => {
    const { platform, tenant } = fixture();
    const token = await platform.signAccessToken(OPERATOR);

    expect(await tenant.verifyAccessToken(token)).toBeNull();
  });

  it('son propre jeton n’est pas non plus une invitation d’établissement', async () => {
    const { platform, tenant } = fixture();
    const token = await platform.signAccessToken(OPERATOR);

    await expect(tenant.verifyInvitationToken(token)).rejects.toThrow();
  });

  it('refuse un jeton contrefait, et un jeton vide', async () => {
    const { platform } = fixture();
    const token = await platform.signAccessToken(OPERATOR);
    const [header, payload] = token.split('.');

    expect(await platform.verifyAccessToken(`${header}.${payload}.signature-inventee`)).toBeNull();
    expect(await platform.verifyAccessToken('')).toBeNull();
    expect(await platform.verifyAccessToken('pas.un.jeton')).toBeNull();
  });
});
