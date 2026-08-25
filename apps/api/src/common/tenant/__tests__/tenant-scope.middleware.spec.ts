import type { NextFunction, Request, Response } from 'express';

import { MissingTenantContextError } from '../tenant-context.errors';
import { getTenantId, hasTenantScope, requireTenantId, setRequestTenantId } from '../tenant-context';
import { TenantScopeMiddleware } from '../tenant-scope.middleware';

/**
 * Le middleware est le seul point d'entrée de la portée de tenant. S'il
 * n'ouvrait pas la portée, `setRequestTenantId` échouerait sur chaque requête —
 * panne bruyante, donc bénigne. S'il l'ouvrait **au mauvais moment**, ou s'il la
 * refermait avant le contrôleur, le symptôme serait tout autre : des requêtes
 * servies hors contexte, et la fuite que l'extension est censée empêcher.
 */
describe('TenantScopeMiddleware', () => {
  const middleware = new TenantScopeMiddleware();

  /** Requête et réponse ne sont jamais lues par le middleware — d'où les vides. */
  const request = {} as Request;
  const response = {} as Response;

  it('ouvre une portée vide, résoluble par le résolveur qui suit', () => {
    const next = jest.fn(() => {
      expect(hasTenantScope()).toBe(true);
      // Vide : le middleware n'a rien résolu, il a seulement ouvert.
      expect(getTenantId()).toBeUndefined();
      // Et c'est bien une portée *écrivable* — la garde d'authentification
      // (#21) écrira ici.
      setRequestTenantId('tenant-a');
      expect(requireTenantId()).toBe('tenant-a');
    }) as unknown as NextFunction;

    middleware.use(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ne lit ni en-tête, ni paramètre, ni corps de la requête', () => {
    // La garantie « le tenantId ne vient jamais d'une entrée utilisateur » tient
    // à ceci : le seul composant qui voit l'objet `Request` n'y touche pas. Un
    // proxy qui piège tout accès le prouve, plutôt qu'une relecture à l'œil.
    const touche: string[] = [];
    const piege = new Proxy({} as Request, {
      get(_cible, propriete): undefined {
        touche.push(String(propriete));
        return undefined;
      },
    });

    middleware.use(piege, response, (() => undefined) as unknown as NextFunction);

    expect(touche).toEqual([]);
  });

  it('propage la portée aux continuations asynchrones du reste de la chaîne', async () => {
    // `run` rend la main dès que `next()` retourne, mais le store suit les
    // continuations : le contrôleur, ses `await` et ses repositories doivent
    // tous voir le tenant.
    let observe: Promise<string> | undefined;

    middleware.use(request, response, (() => {
      setRequestTenantId('tenant-a');
      observe = (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return requireTenantId();
      })();
    }) as unknown as NextFunction);

    await expect(observe).resolves.toBe('tenant-a');
  });

  it('referme la portée entre deux requêtes — aucune ne hérite de la précédente', () => {
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
});
