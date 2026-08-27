import { Prisma, PrismaClient } from '@prisma/client';

import { MissingTenantContextError } from '../../../common/tenant/tenant-context.errors';
import { runInTenantScope, runWithTenant } from '../../../common/tenant/tenant-context';
import {
  TENANT_ROOT_MODEL,
  TENANT_SCOPED_MODELS,
  TenantReassignmentError,
  UnscopedClientRequiredError,
  UnscopedModelNotAllowedError,
  UnsupportedTenantScopedOperationError,
  applyTenantScope,
  scopeOperation,
} from '../tenant-scope.extension';

/**
 * L'extension est le seul endroit où le filtre par tenant est posé. Un défaut
 * ici ne se rattrape nulle part en aval : il devient une fuite sur *toutes* les
 * requêtes de *tous* les modules, sans qu'aucune ligne de code métier n'ait
 * l'air fautive.
 *
 * Ces tests exercent la logique **pure** — sans base, sans connexion : la
 * fonction `query` est un double, et ce qui est vérifié est l'argument qu'elle
 * reçoit. C'est la bonne granularité pour la logique de réécriture, et c'en est
 * aussi la **limite** : rien ici ne prouve que PostgreSQL honore ces arguments.
 *
 * Ce que le schéma généré garantit déjà, lui, c'est que la forme produite est
 * légale : `ServiceWhereUniqueInput` est un `Prisma.AtLeast<…>` qui accepte un
 * sélecteur unique **plus** des filtres additionnels, `tenantId` compris — le
 * `where: { id, tenantId }` posé sur un `findUnique` est donc la forme
 * supportée, pas un contournement.
 *
 * Reste à écrire le test de bout en bout qui exerce le client étendu contre une
 * vraie base : il vit hors de l'empreinte de ce ticket, et fait l'objet d'une
 * issue de suivi. Tant qu'il n'existe pas, aucun module métier ne devrait
 * considérer l'isolation comme prouvée de bout en bout.
 */
describe('Extension de scoping tenant', () => {
  const TENANT = 'tenant-a';
  const AUTRE = 'tenant-victime';

  describe('modèles couverts', () => {
    it('déduit du schéma les modèles métier, sans liste écrite à la main', () => {
      // Le point de la déduction : `RefreshToken`, ajouté par #21 bien après ce
      // fichier, puis `ServiceCategory` par #24, puis `StaffSchedule` et
      // `TenantClosingDay` par #32, puis `StaffTimeOff` par #33, sont couverts
      // sans que personne ait eu à les inscrire dans l'extension — seule cette
      // attente-ci a bougé.
      expect([...TENANT_SCOPED_MODELS].sort()).toEqual([
        'Appointment',
        'Notification',
        'Payment',
        'RefreshToken',
        'Service',
        'ServiceCategory',
        'ServiceStaff',
        'Staff',
        'StaffSchedule',
        'StaffTimeOff',
        'TenantClosingDay',
        'User',
      ]);
    });

    it('n’inclut pas la racine — elle est scopée sur son `id`, pas sur un `tenantId`', () => {
      expect(TENANT_SCOPED_MODELS.has(TENANT_ROOT_MODEL)).toBe(false);
    });

    it('couvre tout modèle du schéma, sans exception silencieuse', () => {
      // Si un modèle du datamodel n'est ni scopé ni la racine, c'est qu'il a été
      // ajouté sans `tenant_id` : le principe 2 le refusera à l'exécution, et ce
      // test le dit avant.
      const inconnus = Prisma.dmmf.datamodel.models
        .map((model) => model.name)
        .filter((name) => !TENANT_SCOPED_MODELS.has(name) && name !== TENANT_ROOT_MODEL);

      expect(inconnus).toEqual([]);
    });

    it('refuse un modèle qui n’est ni scopé ni déclaré globalement légitime', () => {
      expect(() => applyTenantScope('TableFantome', 'findMany', {}, TENANT)).toThrow(
        UnscopedModelNotAllowedError,
      );
    });
  });

  describe('opérations couvertes', () => {
    it('classe toutes les opérations que Prisma expose sur un modèle', () => {
      // Le principe 3 promet qu'une opération non classée est refusée à
      // l'exécution. Ce test rend la promesse vérifiable *avant* : il énumère
      // les opérations réellement présentes sur un délégué du client généré, et
      // exige que chacune soit classée. Une version de Prisma qui en ajoute une
      // fait rougir cette suite au lieu d'attendre la première requête servie.
      //
      // `findRaw` et `aggregateRaw` sont exclues : elles n'existent que sur le
      // connecteur MongoDB. Sur PostgreSQL, les appeler échoue dans Prisma
      // lui-même — les classer laisserait croire qu'elles sont filtrées.
      const MONGO_ONLY = new Set(['findRaw', 'aggregateRaw']);

      const client = new PrismaClient({ datasourceUrl: 'postgresql://x:x@127.0.0.1:1/absent' });
      const delegate = client.user as unknown as Record<string, unknown>;
      const exposees = Object.keys(delegate).filter(
        (key) => typeof delegate[key] === 'function' && !MONGO_ONLY.has(key),
      );

      expect(exposees.length).toBeGreaterThan(0);

      const nonClassees = exposees.filter((operation) => {
        try {
          applyTenantScope('User', operation, {}, TENANT);
          return false;
        } catch (error) {
          return error instanceof UnsupportedTenantScopedOperationError;
        }
      });

      expect(nonClassees).toEqual([]);
    });

    it('refuse une opération qu’elle ne sait pas classer plutôt que de la laisser passer', () => {
      expect(() => applyTenantScope('User', 'operationInventee', {}, TENANT)).toThrow(
        UnsupportedTenantScopedOperationError,
      );
    });
  });

  describe('lectures et suppressions — le `where` est borné', () => {
    it.each([
      'findUnique',
      'findFirst',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
      'delete',
      'deleteMany',
    ])('%s reçoit le tenant courant dans son `where`', (operation) => {
      const args = applyTenantScope('Appointment', operation, { where: { id: 'rdv-1' } }, TENANT);
      expect(args.where).toEqual({ id: 'rdv-1', tenantId: TENANT });
    });

    it('écrase un `tenantId` fourni par l’appelant au lieu de s’y ajouter', () => {
      // Le scénario d'attaque : un `tenantId` qui aurait traversé la validation
      // et atteint le repository. Il n'est pas rejeté, il est *sans effet* — il
      // ne peut donc pas servir de sonde d'existence.
      const args = applyTenantScope(
        'Appointment',
        'findMany',
        { where: { tenantId: AUTRE, status: 'CONFIRMED' } },
        TENANT,
      );
      expect(args.where).toEqual({ tenantId: TENANT, status: 'CONFIRMED' });
    });

    it('borne la racine sur son `id` — `tenant.findMany` n’énumère pas la plateforme', () => {
      const args = applyTenantScope(TENANT_ROOT_MODEL, 'findMany', {}, TENANT);
      expect(args.where).toEqual({ id: TENANT });
    });

    it('empêche la racine de servir de sonde sur un autre établissement', () => {
      const args = applyTenantScope(
        TENANT_ROOT_MODEL,
        'findUnique',
        { where: { id: AUTRE } },
        TENANT,
      );
      expect(args.where).toEqual({ id: TENANT });
    });

    it('préserve les arguments qui ne concernent pas le filtre', () => {
      const args = applyTenantScope(
        'Appointment',
        'findMany',
        { where: { status: 'PENDING' }, take: 10, orderBy: { startsAt: 'asc' } },
        TENANT,
      );
      expect(args.take).toBe(10);
      expect(args.orderBy).toEqual({ startsAt: 'asc' });
    });
  });

  describe('créations — le tenant est posé, jamais choisi', () => {
    it('pose le tenant courant sur la ligne créée', () => {
      const args = applyTenantScope('Service', 'create', { data: { name: 'Massage 60' } }, TENANT);
      expect(args.data).toEqual({ name: 'Massage 60', tenantId: TENANT });
    });

    it('écrase un `tenantId` soumis dans le corps', () => {
      const args = applyTenantScope(
        'Service',
        'create',
        { data: { name: 'Massage 60', tenantId: AUTRE } },
        TENANT,
      );
      expect(args.data).toEqual({ name: 'Massage 60', tenantId: TENANT });
    });

    it('pose le tenant sur chaque ligne d’un `createMany`', () => {
      const args = applyTenantScope(
        'Service',
        'createMany',
        { data: [{ name: 'A' }, { name: 'B', tenantId: AUTRE }] },
        TENANT,
      );
      expect(args.data).toEqual([
        { name: 'A', tenantId: TENANT },
        { name: 'B', tenantId: TENANT },
      ]);
    });

    it('refuse un rattachement par la relation, que l’écrasement scalaire manquerait', () => {
      // `data: { tenant: { connect: … } }` désigne le tenant sans passer par le
      // champ scalaire : l'écraser ne suffirait pas, il faut le refuser.
      expect(() =>
        applyTenantScope(
          'Service',
          'create',
          { data: { name: 'A', tenant: { connect: { id: AUTRE } } } },
          TENANT,
        ),
      ).toThrow(TenantReassignmentError);
    });

    it('renvoie la création d’un établissement vers le client non scopé', () => {
      expect(() => applyTenantScope(TENANT_ROOT_MODEL, 'create', { data: {} }, TENANT)).toThrow(
        UnscopedClientRequiredError,
      );
    });
  });

  describe('mises à jour — une ligne ne change pas d’établissement', () => {
    it('borne le `where` sans toucher au `data`', () => {
      const args = applyTenantScope(
        'Appointment',
        'update',
        { where: { id: 'rdv-1' }, data: { status: 'CONFIRMED' } },
        TENANT,
      );
      expect(args.where).toEqual({ id: 'rdv-1', tenantId: TENANT });
      expect(args.data).toEqual({ status: 'CONFIRMED' });
    });

    it.each(['update', 'updateMany'])('refuse un %s qui réécrit le tenant', (operation) => {
      expect(() =>
        applyTenantScope(
          'Appointment',
          operation,
          { where: {}, data: { tenantId: AUTRE } },
          TENANT,
        ),
      ).toThrow(TenantReassignmentError);
    });

    it('refuse une réaffectation passant par la relation', () => {
      expect(() =>
        applyTenantScope(
          'Appointment',
          'update',
          { where: {}, data: { tenant: { connect: { id: AUTRE } } } },
          TENANT,
        ),
      ).toThrow(TenantReassignmentError);
    });

    it('borne le `where` d’un upsert et pose le tenant sur sa branche créante', () => {
      const args = applyTenantScope(
        'Service',
        'upsert',
        { where: { id: 'svc-1' }, create: { name: 'A' }, update: { name: 'B' } },
        TENANT,
      );
      expect(args.where).toEqual({ id: 'svc-1', tenantId: TENANT });
      expect(args.create).toEqual({ name: 'A', tenantId: TENANT });
      expect(args.update).toEqual({ name: 'B' });
    });

    it('refuse un upsert dont la branche mettante réécrit le tenant', () => {
      expect(() =>
        applyTenantScope(
          'Service',
          'upsert',
          { where: {}, create: {}, update: { tenantId: AUTRE } },
          TENANT,
        ),
      ).toThrow(TenantReassignmentError);
    });
  });

  describe('sans contexte, rien ne part vers la base', () => {
    it('refuse l’opération et n’appelle jamais la requête sous-jacente', async () => {
      const query = jest.fn().mockResolvedValue('jamais');

      await expect(
        runInTenantScope(async () =>
          scopeOperation({ model: 'Appointment', operation: 'findMany', args: {}, query }),
        ),
      ).rejects.toThrow(MissingTenantContextError);

      // Le point décisif : sans contexte, l'extension ne retombe pas sur « pas
      // de filtre ». Aucune requête n'atteint PostgreSQL.
      expect(query).not.toHaveBeenCalled();
    });

    it('refuse aussi hors de toute portée ouverte', async () => {
      const query = jest.fn();
      await expect(
        scopeOperation({ model: 'Service', operation: 'findMany', args: {}, query }),
      ).rejects.toThrow(MissingTenantContextError);
      expect(query).not.toHaveBeenCalled();
    });

    it('transmet les arguments réécrits — et eux seuls — quand le contexte existe', async () => {
      const query = jest.fn().mockResolvedValue([]);

      await runWithTenant(TENANT, async () =>
        scopeOperation({
          model: 'Appointment',
          operation: 'findMany',
          args: { where: { status: 'PENDING' } },
          query,
        }),
      );

      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith({ where: { status: 'PENDING', tenantId: TENANT } });
    });
  });
});
