import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ThrottlerException,
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';

import {
  IdentityThrottlerGuard,
  ThrottleBySession,
  ThrottleByTarget,
} from '../identity-throttler.guard';
import { REFRESH_COOKIE_NAME } from '../refresh-cookie';
import { TokenService } from '../token.service';
import { fakeConfig } from './identity.doubles';

/**
 * Le compteur du limiteur de débit, et ce qu'il compte (#860, puis #1127).
 *
 * Ce que la suite tient, mode par mode :
 *
 * - `@ThrottleBySession()` — deux sessions distinctes **venues de la même
 *   adresse** ont chacune leur quota, ce qui est le cas de production où tous
 *   les renouvellements partent de la tâche ECS du front ; une requête qui ne
 *   prouve aucune session retombe sur l'adresse ;
 * - `@ThrottleByTarget()` — deux **cibles** distinctes ont chacune leur quota
 *   depuis cette même adresse, une même cible reste bornée, et la cible ne se
 *   renouvelle pas en changeant la casse ou les espaces de ce qu'on envoie ;
 * - une route **non marquée** compte par adresse, cookie de session ou non : ce
 *   serait sinon rendre le forçage de mots de passe amplifiable.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Le quota des sondes — deux appels, pour que l'épuisement tienne en trois lignes. */
const LIMIT = 2;

const OPTIONS: ThrottlerModuleOptions = {
  throttlers: [{ name: 'default', limit: LIMIT, ttl: 60_000 }],
};

/** Sonde : une route par mode de comptage, plus une route non marquée. */
class ProbeController {
  @ThrottleBySession()
  public refresh(): void {
    /* sonde */
  }

  /** `POST /auth/login` — établissement **et** adresse. */
  @ThrottleByTarget({ tenant: 'tenantSlug', account: 'email' })
  public login(): void {
    /* sonde */
  }

  /** `POST /auth/register` — l'établissement seul. */
  @ThrottleByTarget({ tenant: 'tenantSlug' })
  public register(): void {
    /* sonde */
  }

  /** `POST /platform/auth/login` — l'adresse seule, un opérateur n'ayant pas de salon. */
  @ThrottleByTarget({ account: 'email' })
  public platformLogin(): void {
    /* sonde */
  }

  /** Un marquage qui ne désigne rien — le seul cas où la cible n'en est pas une. */
  @ThrottleByTarget({})
  public targetless(): void {
    /* sonde */
  }

  public unmarked(): void {
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
async function freshGuard(): Promise<IdentityThrottlerGuard> {
  const storage = new ThrottlerStorageService();
  storages.push(storage);

  const guard = new IdentityThrottlerGuard(OPTIONS, storage, new Reflector(), tokens);
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
  request: { ip: string; headers: Record<string, string>; body: unknown },
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

/** Un appel de la sonde, avec ou sans cookie de session, avec ou sans corps. */
function call(
  guard: IdentityThrottlerGuard,
  options: { handler: unknown; ip?: string; cookie?: string; body?: unknown },
): Promise<boolean> {
  return guard.canActivate(
    contextFor(options.handler, {
      ip: options.ip ?? '203.0.113.7',
      headers: options.cookie === undefined ? {} : { cookie: options.cookie },
      body: options.body,
    }),
  );
}

/** Le cookie tel que le serveur Next le relaie à l'API. */
function cookieOf(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

describe('IdentityThrottlerGuard', () => {
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

  describe('connexion — `@ThrottleByTarget({ tenant, account })`', () => {
    const handler = ProbeController.prototype.login;

    /** Le corps que le serveur Next relaie pour une connexion. */
    const corps = (tenantSlug: string, email: string): unknown => ({
      tenantSlug,
      email,
      password: 'peu-importe',
    });

    it('donne son propre quota à chaque compte, depuis une même adresse', async () => {
      const guard = await freshGuard();
      const lotus = corps('maison-lotus', 'gerante@lotus.test');
      const voisin = corps('salon-voisin', 'gerant@voisin.test');

      // C'est le cas de production : toutes ces connexions sortent de la tâche
      // ECS du front, donc de la même adresse.
      await call(guard, { handler, body: lotus });
      await call(guard, { handler, body: lotus });
      await expect(call(guard, { handler, body: lotus })).rejects.toBeInstanceOf(
        ThrottlerException,
      );

      await expect(call(guard, { handler, body: voisin })).resolves.toBe(true);
      await expect(call(guard, { handler, body: voisin })).resolves.toBe(true);
      await expect(call(guard, { handler, body: voisin })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('borne bien une même cible — le forçage d’un compte reste refusé', async () => {
      const guard = await freshGuard();
      const cible = corps('maison-lotus', 'gerante@lotus.test');

      await call(guard, { handler, body: cible });
      await call(guard, { handler, body: cible });

      // Changer d'adresse ne rend rien : c'est la cible qui est comptée.
      await expect(
        call(guard, { handler, body: cible, ip: '198.51.100.4' }),
      ).rejects.toBeInstanceOf(ThrottlerException);
    });

    it('sépare deux salons qui partagent une adresse e-mail', async () => {
      const guard = await freshGuard();
      const ici = corps('maison-lotus', 'contact@exemple.test');
      const ailleurs = corps('salon-voisin', 'contact@exemple.test');

      // `@@unique([tenantId, email])` autorise délibérément la même adresse dans
      // deux salons : ce sont deux comptes, donc deux quotas.
      await call(guard, { handler, body: ici });
      await call(guard, { handler, body: ici });
      await expect(call(guard, { handler, body: ici })).rejects.toBeInstanceOf(ThrottlerException);
      await expect(call(guard, { handler, body: ailleurs })).resolves.toBe(true);
    });

    it('ne rend pas un compteur neuf à qui change la casse ou les espaces', async () => {
      const guard = await freshGuard();

      // Trois écritures d'une seule et même cible. Sans normalisation, elles
      // donneraient trois compteurs, et le quota ne bornerait plus rien.
      await call(guard, { handler, body: corps('maison-lotus', 'gerante@lotus.test') });
      await call(guard, { handler, body: corps('Maison-Lotus', 'Gerante@Lotus.test') });
      await expect(
        call(guard, { handler, body: corps(' maison-lotus ', '  gerante@lotus.test  ') }),
      ).rejects.toBeInstanceOf(ThrottlerException);
    });

    it('retombe sur l’adresse quand le corps ne nomme aucune cible', async () => {
      const guard = await freshGuard();

      // Corps absent, champ manquant, champ d'un autre type : trois corps que la
      // validation refusera, et qui partagent le compteur de repli.
      await call(guard, { handler });
      await call(guard, { handler, body: { tenantSlug: 'maison-lotus' } });
      await expect(
        call(guard, { handler, body: { tenantSlug: 'maison-lotus', email: 42 } }),
      ).rejects.toBeInstanceOf(ThrottlerException);

      // Et une cible nommée, elle, garde son propre quota.
      await expect(
        call(guard, { handler, body: corps('maison-lotus', 'gerante@lotus.test') }),
      ).resolves.toBe(true);
    });
  });

  describe('inscription — `@ThrottleByTarget({ tenant })`', () => {
    const handler = ProbeController.prototype.register;

    it('compte par établissement, et non par adresse', async () => {
      const guard = await freshGuard();

      // Deux adresses différentes dans le même salon : c'est exactement la
      // création en masse que ce quota borne, et elle ne se renouvelle pas en
      // changeant d'adresse.
      await call(guard, { handler, body: { tenantSlug: 'maison-lotus', email: 'a@lotus.test' } });
      await call(guard, { handler, body: { tenantSlug: 'maison-lotus', email: 'b@lotus.test' } });
      await expect(
        call(guard, { handler, body: { tenantSlug: 'maison-lotus', email: 'c@lotus.test' } }),
      ).rejects.toBeInstanceOf(ThrottlerException);

      // Le salon voisin n'en sait rien.
      await expect(
        call(guard, { handler, body: { tenantSlug: 'salon-voisin', email: 'a@voisin.test' } }),
      ).resolves.toBe(true);
    });
  });

  describe('console plateforme — `@ThrottleByTarget({ account })`', () => {
    const handler = ProbeController.prototype.platformLogin;

    it('compte par opérateur visé, sans établissement à joindre', async () => {
      const guard = await freshGuard();

      await call(guard, { handler, body: { email: 'operateur@editeur.test' } });
      await call(guard, { handler, body: { email: 'OPERATEUR@editeur.test' } });
      await expect(
        call(guard, { handler, body: { email: 'operateur@editeur.test' } }),
      ).rejects.toBeInstanceOf(ThrottlerException);

      await expect(
        call(guard, { handler, body: { email: 'seconde@editeur.test' } }),
      ).resolves.toBe(true);
    });
  });

  describe('marquage qui ne désigne aucun champ', () => {
    const handler = ProbeController.prototype.targetless;

    it('retombe sur l’adresse plutôt que de rendre un compteur unique', async () => {
      const guard = await freshGuard();
      const body = { tenantSlug: 'maison-lotus', email: 'gerante@lotus.test' };

      // Une clé constante pour tous les appelants serait le plafond de
      // plateforme que ce ticket corrige, remis en place par distraction.
      await call(guard, { handler, body, ip: '203.0.113.7' });
      await call(guard, { handler, body, ip: '203.0.113.7' });
      await expect(call(guard, { handler, body, ip: '203.0.113.7' })).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      await expect(call(guard, { handler, body, ip: '198.51.100.4' })).resolves.toBe(true);
    });
  });

  describe('route non marquée', () => {
    const handler = ProbeController.prototype.unmarked;

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

    it('ignore la cible que le corps nomme — seul le marquage décide', async () => {
      const guard = await freshGuard();

      await call(guard, { handler, body: { tenantSlug: 'maison-lotus', email: 'a@lotus.test' } });
      await call(guard, { handler, body: { tenantSlug: 'salon-voisin', email: 'b@voisin.test' } });
      await expect(
        call(guard, { handler, body: { tenantSlug: 'troisieme', email: 'c@troisieme.test' } }),
      ).rejects.toBeInstanceOf(ThrottlerException);
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
      call(guard, { handler: ProbeController.prototype.unmarked, cookie }),
    ).resolves.toBe(true);
  });

  it('ne mélange pas les compteurs de deux routes pour une même cible', async () => {
    const guard = await freshGuard();
    const body = { tenantSlug: 'maison-lotus', email: 'gerante@lotus.test' };

    await call(guard, { handler: ProbeController.prototype.login, body });
    await call(guard, { handler: ProbeController.prototype.login, body });

    // Épuiser la connexion d'un compte ne ferme pas l'inscription du salon —
    // ni, sur la console, la connexion de l'opérateur homonyme.
    await expect(
      call(guard, { handler: ProbeController.prototype.register, body }),
    ).resolves.toBe(true);
    await expect(
      call(guard, { handler: ProbeController.prototype.platformLogin, body }),
    ).resolves.toBe(true);
  });
});
