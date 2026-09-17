import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ThrottlerException,
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';

import { REFRESH_COOKIE_NAME } from '../refresh-cookie';
import { SessionThrottlerGuard, ThrottleBySession } from '../session-throttler.guard';
import { TokenService } from '../token.service';
import { fakeConfig } from './identity.doubles';

/**
 * Le compteur du limiteur de débit, et ce qu'il compte (#860).
 *
 * Ce que la suite tient : sur une route marquée `@ThrottleBySession()`, deux
 * sessions distinctes **venues de la même adresse** ont chacune leur quota — le
 * cas de production, où tous les renouvellements partent de la tâche ECS du
 * front —, et une requête qui ne prouve aucune session retombe sur l'adresse.
 * Sur une route non marquée, un cookie de session ne donne **jamais** un
 * compteur neuf : ce serait rendre le forçage de `/auth/login` amplifiable.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Le quota des sondes — deux appels, pour que l'épuisement tienne en trois lignes. */
const LIMIT = 2;

const OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', limit: LIMIT, ttl: 60_000 }],
};

/** Sonde : une route au compteur par session, une autre au compteur d'origine. */
class ProbeController {
  @ThrottleBySession()
  public refresh(): void {
    /* sonde */
  }

  public login(): void {
    /* sonde */
  }
}

const tokens = new TokenService(new JwtService(), fakeConfig());

/**
 * Les stockages ouverts par la suite.
 *
 * `ThrottlerStorageService` arme un `setTimeout` par compteur pour le faire
 * expirer : sans l'arrêt explicite ci-dessous, la boucle d'événements reste
 * occupée une minute après le dernier test et Jest ne rend jamais la main.
 */
const storages: ThrottlerStorageService[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.onApplicationShutdown();
  }
});

/**
 * Une garde neuve — donc un stockage neuf, et des compteurs qui ne fuient pas
 * d'un test à l'autre.
 */
async function freshGuard(): Promise<SessionThrottlerGuard> {
  const storage = new ThrottlerStorageService();
  storages.push(storage);

  const guard = new SessionThrottlerGuard(OPTIONS, storage, new Reflector(), tokens);
  await guard.onModuleInit();
  return guard;
}

/** Un jeton de rafraîchissement signé pour cette session. */
async function refreshTokenFor(sessionId: string): Promise<string> {
  const { token } = await tokens.signRefreshToken({
    userId: USER,
    tenantId: TENANT,
    sessionId,
  });
  return token;
}

function contextFor(
  handler: unknown,
  request: { ip: string; headers: Record<string, string> },
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ProbeController,
    switchToHttp: () => ({
      getRequest: () => request,
      // La garde pose ses en-têtes `X-RateLimit-*` sur la réponse : sans cette
      // méthode, elle échouerait avant d'avoir rendu son verdict.
      getResponse: () => ({ header: (): void => undefined }),
    }),
  } as unknown as ExecutionContext;
}

/** Un appel de la sonde, avec ou sans cookie de session. */
function call(
  guard: SessionThrottlerGuard,
  options: { handler: unknown; ip?: string; cookie?: string },
): Promise<boolean> {
  return guard.canActivate(
    contextFor(options.handler, {
      ip: options.ip ?? '203.0.113.7',
      headers: options.cookie === undefined ? {} : { cookie: options.cookie },
    }),
  );
}

/** Le cookie tel que le serveur Next le relaie à l'API. */
function cookieOf(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

describe('SessionThrottlerGuard', () => {
  describe('route marquée `@ThrottleBySession()`', () => {
    const handler = ProbeController.prototype.refresh;

    it('donne son propre quota à chaque session, depuis une même adresse', async () => {
      const guard = await freshGuard();
      const premiere = cookieOf(await refreshTokenFor('session-du-salon-lotus'));
      const seconde = cookieOf(await refreshTokenFor('session-du-salon-voisin'));

      // Le premier salon épuise son quota…
      await call(guard, { handler, cookie: premiere });
      await call(guard, { handler, cookie: premiere });
      await expect(call(guard, { handler, cookie: premiere })).rejects.toBeInstanceOf(
        ThrottlerException,
      );

      // …et le second, qui sort de la même adresse, n'en sait rien.
      await expect(call(guard, { handler, cookie: seconde })).resolves.toBe(true);
      await expect(call(guard, { handler, cookie: seconde })).resolves.toBe(true);
      await expect(call(guard, { handler, cookie: seconde })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('suit la session et non l’émission — une rotation ne rend pas le quota', async () => {
      const guard = await freshGuard();
      // Deux jetons différents, `jti` compris, pour la **même** session : ce que
      // produit chaque rotation. Un compteur porté par le `jti` repartirait de
      // zéro à chaque renouvellement réussi, et ne limiterait donc rien.
      const avant = cookieOf(await refreshTokenFor('session-inchangee'));
      const apres = cookieOf(await refreshTokenFor('session-inchangee'));

      expect(avant).not.toBe(apres);

      await call(guard, { handler, cookie: avant });
      await call(guard, { handler, cookie: apres });
      await expect(call(guard, { handler, cookie: apres })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('retombe sur l’adresse quand la requête ne prouve aucune session', async () => {
      const guard = await freshGuard();

      // Sans cookie, avec un cookie illisible, avec un jeton contrefait : les
      // trois désignent le même compteur — celui de l'adresse.
      await call(guard, { handler });
      await call(guard, { handler, cookie: cookieOf('pas-un-jeton') });
      await expect(
        call(guard, { handler, cookie: `${REFRESH_COOKIE_NAME}=` }),
      ).rejects.toBeInstanceOf(ThrottlerException);
    });

    it('sépare les adresses quand aucune session n’est prouvée', async () => {
      const guard = await freshGuard();

      await call(guard, { handler, ip: '203.0.113.7' });
      await call(guard, { handler, ip: '203.0.113.7' });
      await expect(call(guard, { handler, ip: '203.0.113.7' })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      await expect(call(guard, { handler, ip: '198.51.100.4' })).resolves.toBe(true);
    });
  });

  describe('route non marquée', () => {
    const handler = ProbeController.prototype.login;

    it('compte par adresse, même quand un cookie de session accompagne l’appel', async () => {
      const guard = await freshGuard();
      const premiere = cookieOf(await refreshTokenFor('session-de-l-attaquant'));
      const seconde = cookieOf(await refreshTokenFor('session-ouverte-ensuite'));

      await call(guard, { handler, cookie: premiere });
      await call(guard, { handler, cookie: seconde });

      // Ouvrir une session de plus ne rend pas d'essais : sans quoi le forçage
      // de mots de passe s'amplifierait d'une session à l'autre.
      await expect(call(guard, { handler, cookie: seconde })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });
  });

  it('ne mélange pas les compteurs de deux routes pour une même session', async () => {
    const guard = await freshGuard();
    const cookie = cookieOf(await refreshTokenFor('session-partagee'));

    await call(guard, { handler: ProbeController.prototype.refresh, cookie });
    await call(guard, { handler: ProbeController.prototype.refresh, cookie });

    // `generateKey` préfixe la clé du contrôleur et du gestionnaire : le quota
    // d'une route n'emporte jamais celui d'une autre.
    await expect(
      call(guard, { handler: ProbeController.prototype.login, cookie }),
    ).resolves.toBe(true);
  });
});
