import { setTimeout as delay } from 'node:timers/promises';

import {
  InvalidTenantIdError,
  MissingTenantContextError,
  TenantAlreadyResolvedError,
  TenantScopeNotOpenError,
} from '../tenant-context.errors';
import {
  getTenantId,
  hasTenantScope,
  requireTenantId,
  runInTenantScope,
  runWithTenant,
  setRequestTenantId,
} from '../tenant-context';

/**
 * Le contexte de tenant est la source unique du filtre appliqué à chaque requête
 * de données. Ce que ces tests protègent n'est donc pas une commodité
 * d'ergonomie, mais les deux propriétés dont dépend l'isolation entière :
 *
 * 1. **hermétisme** — deux requêtes concurrentes ne voient jamais le tenant
 *    l'une de l'autre, quelle que soit leur imbrication asynchrone ;
 * 2. **défaut fermé** — hors contexte, ou dans un contexte non résolu, la
 *    demande de tenant échoue au lieu de rendre `undefined`.
 */
describe('Contexte de tenant', () => {
  describe('défaut fermé', () => {
    it('refuse de rendre un tenant hors de toute portée', () => {
      expect(() => requireTenantId()).toThrow(MissingTenantContextError);
      expect(hasTenantScope()).toBe(false);
      expect(getTenantId()).toBeUndefined();
    });

    it('refuse de rendre un tenant dans une portée ouverte mais non résolue', () => {
      runInTenantScope(() => {
        // La distinction compte au diagnostic : la portée existe — le middleware
        // est branché — mais aucun résolveur n'a renseigné le tenant.
        expect(hasTenantScope()).toBe(true);
        expect(getTenantId()).toBeUndefined();
        expect(() => requireTenantId()).toThrow(MissingTenantContextError);
      });
    });

    it('nomme le modèle et l’opération dans l’erreur, pour que le journal les porte', () => {
      const error = (() => {
        try {
          requireTenantId('Appointment', 'findMany');
          return undefined;
        } catch (caught) {
          return caught as MissingTenantContextError;
        }
      })();

      expect(error).toBeInstanceOf(MissingTenantContextError);
      expect(error?.model).toBe('Appointment');
      expect(error?.operation).toBe('findMany');
    });
  });

  describe('résolution', () => {
    it('renseigne le tenant de la requête, une fois', () => {
      runInTenantScope(() => {
        setRequestTenantId('tenant-a');
        expect(requireTenantId()).toBe('tenant-a');
      });
    });

    it('refuse une seconde résolution — une requête ne change pas d’établissement', () => {
      runInTenantScope(() => {
        setRequestTenantId('tenant-a');
        expect(() => setRequestTenantId('tenant-b')).toThrow(TenantAlreadyResolvedError);
        // Et surtout : la valeur d'origine n'a pas bougé.
        expect(requireTenantId()).toBe('tenant-a');
      });
    });

    it('refuse d’écrire hors portée plutôt que d’écrire dans le vide', () => {
      expect(() => setRequestTenantId('tenant-a')).toThrow(TenantScopeNotOpenError);
    });

    it.each([['', 'chaîne vide'], ['   ', 'blancs']])(
      'rejette un identifiant invalide (%s)',
      (value) => {
        runInTenantScope(() => {
          expect(() => setRequestTenantId(value)).toThrow(InvalidTenantIdError);
        });
      },
    );

    it('ne recopie jamais la valeur fautive dans le message — elle finit en journal', () => {
      runInTenantScope(() => {
        try {
          setRequestTenantId('   ');
        } catch (caught) {
          expect((caught as Error).message).not.toContain('   ');
        }
      });
    });

    it('ouvre une portée déjà résolue pour un traitement hors requête', () => {
      runWithTenant('tenant-a', () => {
        expect(requireTenantId()).toBe('tenant-a');
      });
    });
  });

  describe('hermétisme', () => {
    it('suit la requête à travers ses continuations asynchrones', async () => {
      await runWithTenant('tenant-a', async () => {
        await delay(1);
        expect(requireTenantId()).toBe('tenant-a');

        await Promise.all([
          (async () => {
            await delay(2);
            expect(requireTenantId()).toBe('tenant-a');
          })(),
          new Promise<void>((resolve) => {
            setImmediate(() => {
              expect(requireTenantId()).toBe('tenant-a');
              resolve();
            });
          }),
        ]);
      });
    });

    it('ne laisse jamais deux requêtes concurrentes voir le tenant l’une de l’autre', async () => {
      // Le scénario qui condamnerait une variable de module : deux requêtes
      // entrelacées, dont la plus lente est *ouverte en premier* et *rendue en
      // dernier*. Avec un état partagé, la seconde écraserait la première.
      const observe = async (tenantId: string, pause: number): Promise<string> =>
        runWithTenant(tenantId, async () => {
          await delay(pause);
          const seen = requireTenantId();
          await delay(pause);
          return `${seen}|${requireTenantId()}`;
        });

      const [slow, fast] = await Promise.all([observe('tenant-a', 12), observe('tenant-b', 1)]);

      expect(slow).toBe('tenant-a|tenant-a');
      expect(fast).toBe('tenant-b|tenant-b');
    });

    it('referme la portée en sortie — rien ne fuit vers la requête suivante', () => {
      runWithTenant('tenant-a', () => requireTenantId());
      expect(hasTenantScope()).toBe(false);
      expect(() => requireTenantId()).toThrow(MissingTenantContextError);
    });

    it('n’expose pas le tenant d’une portée à celle qui l’englobe', () => {
      runInTenantScope(() => {
        runWithTenant('tenant-b', () => {
          expect(requireTenantId()).toBe('tenant-b');
        });
        // La portée imbriquée avait son propre store : celle-ci reste vierge, et
        // reste donc résolvable par son propre résolveur.
        expect(getTenantId()).toBeUndefined();
      });
    });
  });
});
