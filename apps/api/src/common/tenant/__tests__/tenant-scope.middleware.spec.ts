import type { NextFunction, Request, Response } from 'express';

import { NotFoundError } from '../../errors';
import type { AppConfigService } from '../../../config/app-config.service';
import type { PublicTenantResolver } from '../public-tenant.resolver';
import { MissingTenantContextError } from '../tenant-context.errors';
import { getTenantId, hasTenantScope, requireTenantId, setRequestTenantId } from '../tenant-context';
import { TenantScopeMiddleware } from '../tenant-scope.middleware';

/**
 * Le middleware est le seul point d'entrée de la portée de tenant. S'il
 * n'ouvrait pas la portée, `setRequestTenantId` échouerait sur chaque requête —
 * panne bruyante, donc bénigne. S'il l'ouvrait **au mauvais moment**, ou s'il la
 * refermait avant le contrôleur, le symptôme serait tout autre : des requêtes
 * servies hors contexte, et la fuite que l'extension est censée empêcher.
 *
 * Depuis #23 il fait une seconde chose, et elle porte le critère le plus dur de
 * l'issue : sur l'espace public, il **résout** l'établissement et refuse la
 * requête avant tout le reste de la chaîne.
 */

const BASE_URL = 'https://exemple.test';
const TENANT_A = '11111111-1111-4111-8111-111111111111';

const SALON = 'salon-des-lilas';
const BARBIER = 'barbier-du-port';

interface Harness {
  middleware: TenantScopeMiddleware;
  findTenantIdBySlug: jest.MockedFunction<PublicTenantResolver['findTenantIdBySlug']>;
}

function createMiddleware(known: Readonly<Record<string, string>> = { [SALON]: TENANT_A }): Harness {
  const findTenantIdBySlug = jest.fn(
    async (slug: string): Promise<string | null> => known[slug] ?? null,
  );
  const config = { appUrl: BASE_URL } as AppConfigService;
  return {
    middleware: new TenantScopeMiddleware(config, { findTenantIdBySlug }),
    findTenantIdBySlug,
  };
}

/** Requête minimale — le middleware ne lit que ces deux champs. */
function requestFor(originalUrl: string, host?: string): Request {
  return { originalUrl, headers: host === undefined ? {} : { host } } as unknown as Request;
}

const response = {} as Response;

describe('TenantScopeMiddleware — portée de toute requête', () => {
  it('ouvre une portée vide, résoluble par le résolveur qui suit', () => {
    const { middleware } = createMiddleware();
    const next = jest.fn(() => {
      expect(hasTenantScope()).toBe(true);
      // Vide : hors espace public, le middleware n'a rien résolu.
      expect(getTenantId()).toBeUndefined();
      // Et c'est bien une portée *écrivable* — la garde d'authentification
      // (#21) écrira ici.
      setRequestTenantId('tenant-a');
      expect(requireTenantId()).toBe('tenant-a');
    }) as unknown as NextFunction;

    middleware.use(requestFor('/api/v1/users'), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ne lit de la requête que l’URL d’origine et l’en-tête `Host`', () => {
    // La garantie « le tenantId ne vient jamais d'une entrée utilisateur » ne
    // tient plus au fait que le middleware ne lise rien — depuis #23 il lit
    // l'URL. Elle tient à ce qu'il ne lise **que** de quoi désigner un
    // établissement, et jamais le corps, la query ou un en-tête applicatif : ce
    // qu'il en tire est ensuite résolu en base, et c'est le résultat de cette
    // résolution qui entre dans le contexte. Un proxy qui piège tout accès le
    // prouve, plutôt qu'une relecture à l'œil.
    const touche: string[] = [];
    const piege = new Proxy({ originalUrl: '/api/v1/users', headers: {} } as unknown as Request, {
      get(cible, propriete, recepteur): unknown {
        touche.push(String(propriete));
        return Reflect.get(cible, propriete, recepteur) as unknown;
      },
    });

    const { middleware } = createMiddleware();
    middleware.use(piege, response, (() => undefined) as unknown as NextFunction);

    expect(touche.sort()).toEqual(['headers', 'originalUrl']);
    // Ni `body`, ni `query`, ni `params`, ni `cookies`.
    expect(touche).not.toContain('body');
    expect(touche).not.toContain('query');
  });

  it('propage la portée aux continuations asynchrones du reste de la chaîne', async () => {
    // `run` rend la main dès que `next()` retourne, mais le store suit les
    // continuations : le contrôleur, ses `await` et ses repositories doivent
    // tous voir le tenant.
    const { middleware } = createMiddleware();
    let observe: Promise<string> | undefined;

    middleware.use(requestFor('/api/v1/users'), response, (() => {
      setRequestTenantId('tenant-a');
      observe = (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return requireTenantId();
      })();
    }) as unknown as NextFunction);

    await expect(observe).resolves.toBe('tenant-a');
  });

  it('referme la portée entre deux requêtes — aucune ne hérite de la précédente', () => {
    const { middleware } = createMiddleware();
    const request = requestFor('/api/v1/users');

    middleware.use(request, response, (() => {
      setRequestTenantId('tenant-a');
    }) as unknown as NextFunction);

    expect(hasTenantScope()).toBe(false);

    middleware.use(request, response, (() => {
      // La requête suivante repart vierge : si le tenant précédent avait
      // survécu, `setRequestTenantId` lèverait `TenantAlreadyResolvedError`.
      expect(getTenantId()).toBeUndefined();
      expect(() => requireTenantId()).toThrow(MissingTenantContextError);
      setRequestTenantId('tenant-b');
      expect(requireTenantId()).toBe('tenant-b');
    }) as unknown as NextFunction);
  });

  it('n’interroge pas la base pour une route non publique', () => {
    // Le chemin le plus chaud de l'API — `/health`, sondé par l'ALB — ne doit
    // pas payer une lecture de la table `tenants`.
    const { middleware, findTenantIdBySlug } = createMiddleware();
    middleware.use(requestFor('/health'), response, (() => undefined) as unknown as NextFunction);
    expect(findTenantIdBySlug).not.toHaveBeenCalled();
  });
});

describe('TenantScopeMiddleware — résolution des pages publiques', () => {
  it('résout le slug d’URL et le pose dans le contexte avant la suite de la chaîne', async () => {
    const { middleware, findTenantIdBySlug } = createMiddleware();
    const next = jest.fn(() => {
      // Le critère « le tenant résolu est injecté dans le contexte de requête »,
      // observé d'où le contrôleur l'observera.
      expect(requireTenantId()).toBe(TENANT_A);
    }) as unknown as NextFunction;

    await middleware.use(requestFor(`/api/v1/public/${SALON}/services`), response, next);

    expect(findTenantIdBySlug).toHaveBeenCalledWith(SALON);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('c’est l’identifiant lu en base qui entre dans le contexte, pas le slug', async () => {
    // La distinction est tout le sujet : le slug est une chaîne fournie par le
    // client, l'identifiant est une donnée serveur.
    const { middleware } = createMiddleware();
    let vu: string | undefined;

    await middleware.use(requestFor(`/api/v1/public/${SALON}`), response, (() => {
      vu = getTenantId();
    }) as unknown as NextFunction);

    expect(vu).toBe(TENANT_A);
    expect(vu).not.toBe(SALON);
  });

  it('refuse un slug inconnu en 404, sans jamais appeler la suite de la chaîne', async () => {
    // Le critère central de l'issue. `next` non appelé = ni garde, ni pipe, ni
    // contrôleur : aucun code métier ne tourne pour un établissement qui
    // n'existe pas.
    const { middleware } = createMiddleware();
    const next = jest.fn() as unknown as NextFunction;

    await expect(
      middleware.use(requestFor(`/api/v1/public/${BARBIER}`), response, next),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(next).not.toHaveBeenCalled();
  });

  it('refuse une désignation illisible sans même interroger la base', async () => {
    const { middleware, findTenantIdBySlug } = createMiddleware();
    const next = jest.fn() as unknown as NextFunction;

    await expect(
      middleware.use(requestFor('/api/v1/public/salon_des_lilas'), response, next),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(findTenantIdBySlug).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rend le même refus pour un slug inconnu et pour un slug mal formé', async () => {
    // Deux messages distincts diraient à qui sonde lequel de ses essais a la
    // bonne *forme* — un oracle gratuit sur les noms d'établissements.
    const { middleware } = createMiddleware();
    const next = jest.fn() as unknown as NextFunction;

    const inconnu = await middleware
      .use(requestFor(`/api/v1/public/${BARBIER}`), response, next)
      ?.catch((error: unknown) => error);
    const malForme = await middleware
      .use(requestFor('/api/v1/public/salon_des_lilas'), response, next)
      ?.catch((error: unknown) => error);

    expect((inconnu as NotFoundError).message).toBe((malForme as NotFoundError).message);
    expect((inconnu as NotFoundError).code).toBe('NOT_FOUND');
    // Le slug soumis ne revient pas dans le corps d'erreur.
    expect((inconnu as NotFoundError).message).not.toContain(BARBIER);
  });

  it('résout depuis le sous-domaine quand l’URL publique ne porte pas de slug', async () => {
    const { middleware } = createMiddleware();
    let vu: string | undefined;

    await middleware.use(requestFor('/api/v1/public', `${SALON}.exemple.test`), response, (() => {
      vu = getTenantId();
    }) as unknown as NextFunction);

    expect(vu).toBe(TENANT_A);
  });

  it('refuse un sous-domaine qui contredit le slug d’URL', async () => {
    const { middleware, findTenantIdBySlug } = createMiddleware({
      [SALON]: TENANT_A,
      [BARBIER]: '22222222-2222-4222-8222-222222222222',
    });
    const next = jest.fn() as unknown as NextFunction;

    await expect(
      middleware.use(
        requestFor(`/api/v1/public/${BARBIER}`, `${SALON}.exemple.test`),
        response,
        next,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Refusé sur la seule lecture de la requête : les deux établissements
    // existent, et c'est justement pour cela qu'il ne faut pas choisir.
    expect(findTenantIdBySlug).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('ignore l’en-tête `Host` hors de l’espace public', async () => {
    // Un `Host` est fourni par le client. Le lire sur une route authentifiée
    // laisserait un tiers pré-remplir la portée de la requête d'autrui.
    const { middleware, findTenantIdBySlug } = createMiddleware();
    let vu: string | undefined;

    middleware.use(requestFor('/api/v1/users', `${SALON}.exemple.test`), response, (() => {
      vu = getTenantId();
    }) as unknown as NextFunction);

    expect(vu).toBeUndefined();
    expect(findTenantIdBySlug).not.toHaveBeenCalled();
  });

  it('referme la portée d’une requête publique refusée', async () => {
    const { middleware } = createMiddleware();
    await middleware
      .use(requestFor(`/api/v1/public/${BARBIER}`), response, jest.fn() as unknown as NextFunction)
      ?.catch(() => undefined);

    expect(hasTenantScope()).toBe(false);
  });
});
