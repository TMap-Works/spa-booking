import request from 'supertest';

import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import {
  expectCrossTenantNotFound,
  expectExcludesForeignIds,
  expectListScopedTo,
  expectNotFoundWithoutLeak,
} from './utils/tenant-assertions';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Le harnais d'isolation inter-tenant, exercé sur lui-même (#27).
 *
 * Les sept suites de fuite du dépôt s'appuient désormais sur ce harnais et sur
 * ses assertions. Une erreur ici ne ferait donc pas rougir une suite : elle les
 * rendrait **toutes vertes pour de mauvaises raisons**, ce qui est le pire des
 * résultats pour un outillage de sécurité. D'où cette suite, et d'où sa forme.
 *
 * ## Chaque assertion est prouvée dans les deux sens
 *
 * Une assertion n'a de valeur que si l'on a vu ce qui la fait rougir : les cas
 * « elle refuse … » construisent délibérément la situation qu'elle doit
 * attraper, et vérifient qu'elle lève. C'est le même raisonnement que les
 * mutations documentées dans `catalog-tenant.isolation-spec.ts`, mais mené sur
 * l'outil plutôt que sur le code testé — et il ne demande, lui, aucune mutation
 * temporaire du code de production.
 *
 * Les réponses employées pour ces cas négatifs sont de **vraies** réponses HTTP
 * de l'application : un 403 vraiment rendu par la garde de rôles, un 404
 * vraiment rendu par le filtre d'exceptions. Une réponse fabriquée à la main
 * prouverait que l'assertion lit bien un objet littéral, pas qu'elle refuserait
 * ce que l'API rend réellement.
 */

const EUR = { amountMinor: 7000, currency: 'EUR' };

describe('Harnais d’isolation inter-tenant — #27', () => {
  let harness: TenantHarness;
  let catalog: FakeCatalogRepository;

  beforeEach(async () => {
    catalog = new FakeCatalogRepository();
    // `overrides` est ce par quoi un module métier branche son propre dépôt : le
    // reste — deux établissements, l'application câblée, les jetons signés — ne
    // se redit pas.
    harness = await createTenantHarness({
      overrides: [{ provide: CatalogRepository, useValue: catalog }],
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<TenantHarness['server']> => harness.server();

  describe('deux établissements et leurs jeux de données', () => {
    it('les deux sont distincts et chacun se résout par son slug', async () => {
      expect(harness.a.id).not.toBe(harness.b.id);
      expect(harness.a.slug).not.toBe(harness.b.slug);

      // Les slugs sont déclarés **sur** les identifiants : la surface publique et
      // les routes à jeton désignent bien les deux mêmes établissements, sans
      // quoi un test pourrait semer chez l'un et croire lire chez l'autre.
      for (const tenant of [harness.a, harness.b]) {
        const vitrine = await request(server())
          .get(`/api/v1/public/${tenant.slug}`)
          .expect(200);

        expect(vitrine.body.id).toBe(tenant.id);
        expect(vitrine.body.name).toBe(tenant.name);
      }
    });

    it('un jeton signé porte la portée de son établissement, et d’aucun autre', async () => {
      const chezA = await harness.seedUser(harness.a, { role: 'STAFF' });
      const chezB = await harness.seedUser(harness.b, { role: 'STAFF' });

      const vuDeA = await request(server())
        .get('/api/v1/users')
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);

      // Le jeton par défaut est celui de A : le compte de B n'existe pas pour lui.
      expectListScopedTo(vuDeA.body, { ownIds: [chezA.id], foreignIds: [chezB.id, harness.b.id] });

      const vuDeB = await request(server())
        .get('/api/v1/users')
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .expect(200);

      expectListScopedTo(vuDeB.body, { ownIds: [chezB.id], foreignIds: [chezA.id, harness.a.id] });
    });

    it('refuse de signer un jeton sur une portée qui ne désigne aucun établissement', async () => {
      // Le slug et l'identifiant sont deux chaînes : rien, dans le système de
      // types, ne distingue `tokenFor('ADMIN', harness.b.slug)` de la forme
      // correcte. Un jeton signé sur une portée vide ferait répondre « rien » à
      // toute lecture — donc verdir tous les cas de traversée sans avoir visé le
      // voisin une seule fois.
      await expect(harness.tokenFor('ADMIN', harness.b.slug)).rejects.toThrow(/harness\.a/);
      await expect(harness.bearer('ADMIN', 'tenant-inconnu')).rejects.toThrow(/portée vide/);

      // La forme correcte, elle, passe — la garde ne doit pas fermer la porte
      // que `catalog.harness.ts` emprunte.
      await expect(harness.tokenFor('ADMIN', harness.b.id)).resolves.toEqual(expect.any(String));
    });

    it('les comptes semés avec un mot de passe ouvrent vraiment une session', async () => {
      // `seedUser` hache par le vrai `PasswordHasher` : un compte semé doit être
      // utilisable par `/auth/login`, sans quoi les suites qui exercent la
      // connexion devraient refaire leur propre semis.
      await harness.seedUser(harness.a, {
        email: 'alice@example.test',
        password: 'mot-de-passe-du-salon',
      });

      await request(server())
        .post('/api/v1/auth/login')
        .send({
          tenantSlug: harness.a.slug,
          email: 'alice@example.test',
          password: 'mot-de-passe-du-salon',
        })
        .expect(200);
    });
  });

  describe('lecture, modification et suppression croisées répondent 404', () => {
    it('joue le protocole complet et constate la ressource du voisin intacte', async () => {
      // Pas 1 : la ressource est créée chez B, avec un praticien affecté — c'est
      // ce qui donne les trois verbes du pas 3 sur un même module.
      const service = catalog.seedService({ tenantId: harness.b.id, name: 'Chez B' });
      const staff = catalog.seedStaff({ tenantId: harness.b.id });
      catalog.seedAssignment({
        tenantId: harness.b.id,
        serviceId: service.id,
        staffId: staff.id,
      });

      // Pas 2 : l'appelant est un ADMIN de A — le rang le plus capable, pour que
      // le refus ne puisse pas venir d'un manque de droit.
      const bearer = await harness.bearer('ADMIN');

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'lecture',
            send: () =>
              request(server())
                .get(`/api/v1/services/${service.id}`)
                .set('Authorization', bearer),
          },
          {
            label: 'modification',
            send: () =>
              request(server())
                .patch(`/api/v1/services/${service.id}`)
                .set('Authorization', bearer)
                .send({ name: 'Détourné', price: { amountMinor: 1, currency: 'EUR' } }),
          },
          {
            label: 'suppression',
            send: () =>
              request(server())
                .delete(`/api/v1/services/${service.id}/staff/${staff.id}`)
                .set('Authorization', bearer),
          },
        ],
        // Ce que le voisin possède et que l'appelant ne pourrait pas deviner :
        // son établissement, le nom de sa prestation, celui de son praticien.
        //
        // L'identifiant **soumis dans l'URL** n'en fait pas partie, et c'est
        // délibéré : l'appelant vient de l'écrire, le lui renvoyer ne lui
        // apprend rien, et `NotFoundError` le recopie dans `details` pour qu'un
        // écran sache quelle fiche rafraîchir. La propriété plus stricte — le
        // corps ne contient pas même l'identifiant visé — se tient route par
        // route, là où elle a un sens : `catalog-tenant.isolation-spec.ts` et
        // `identity-tenant.isolation-spec.ts` l'exigent sur leurs lectures.
        hidden: [harness.b.id, 'Chez B', staff.displayName],
        // Pas 4 : ni la prestation ni l'affectation n'ont bougé.
        intact: () => ({ services: catalog.services, assignments: catalog.assignments }),
      });
    });

    it('refuse un 403 aussi fermement qu’un 200', async () => {
      // Un vrai 403 de la garde de rôles : un MANAGER ne distribue pas les rôles.
      // C'est la réponse qu'un endpoint mal écrit rendrait sur une ressource
      // d'ailleurs — et c'est celle qui confirme son existence (tenant-isolation
      // §4). L'assertion doit la refuser, pas s'en contenter.
      const cible = await harness.seedUser(harness.a, { role: 'STAFF' });
      const refus = await request(server())
        .patch(`/api/v1/users/${cible.id}/role`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ role: 'ADMIN' });

      expect(refus.status).toBe(403);
      expect(() => expectNotFoundWithoutLeak(refus, { hidden: [cible.id] })).toThrow();
    });

    it('refuse un 404 dont le corps recopie ce qu’on lui demande de cacher', async () => {
      // Le corps d'erreur sert de miroir à qui sonde des identifiants. Ici c'est
      // le code d'erreur lui-même que l'on déclare secret : la réponse est un
      // vrai 404, mais elle contient le texte surveillé — l'assertion doit
      // rougir sur le contenu, pas seulement sur le statut.
      const service = catalog.seedService({ tenantId: harness.b.id });
      const absent = await request(server())
        .get(`/api/v1/services/${service.id}`)
        .set('Authorization', await harness.bearer('ADMIN'));

      expect(absent.status).toBe(404);
      expect(() => expectNotFoundWithoutLeak(absent, { hidden: ['NOT_FOUND'] })).toThrow();
    });

    it('refuse une écriture qui a eu lieu malgré le 404', async () => {
      // Le pas 4 du protocole existe pour ce scénario précis : un endpoint qui
      // écrirait chez le voisin *puis* répondrait 404 passerait les trois
      // premiers pas. L'instantané doit être un **clone** — comparé à l'objet
      // vivant, il serait égal à lui-même quoi qu'il arrive.
      const service = catalog.seedService({ tenantId: harness.b.id, name: 'Chez B' });
      const bearer = await harness.bearer('ADMIN');
      const ressource = { name: service.name };

      await expect(
        expectCrossTenantNotFound({
          attempts: [
            {
              label: 'modification qui écrit quand même',
              send: () => {
                ressource.name = 'Détourné';
                return request(server())
                  .get(`/api/v1/services/${service.id}`)
                  .set('Authorization', bearer);
              },
            },
          ],
          hidden: [service.id],
          intact: () => ressource,
        }),
      ).rejects.toThrow();
    });

    it('refuse un scénario qui n’exerce rien', async () => {
      // Un scénario sans tentative, ou sans identifiant à surveiller, serait vert
      // sans avoir rien vérifié — et se lirait comme une garantie.
      await expect(expectCrossTenantNotFound({ attempts: [], hidden: ['x'] })).rejects.toThrow(
        /aucune tentative/,
      );

      const bearer = await harness.bearer('ADMIN');
      await expect(
        expectCrossTenantNotFound({
          attempts: [
            {
              label: 'lecture',
              send: () => request(server()).get('/api/v1/users').set('Authorization', bearer),
            },
          ],
          hidden: [],
        }),
      ).rejects.toThrow(/aucun identifiant à surveiller/);
    });
  });

  describe('une liste ne contient jamais un identifiant d’un autre établissement', () => {
    it('la liste du back-office est bornée à l’établissement du jeton', async () => {
      const chezA = catalog.seedService({ tenantId: harness.a.id, name: 'Chez A' });
      const chezB = catalog.seedService({ tenantId: harness.b.id, name: 'Chez B' });

      const response = await request(server())
        .get('/api/v1/services')
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);

      expectListScopedTo(response.body, {
        ownIds: [chezA.id],
        foreignIds: [chezB.id, harness.b.id],
      });
    });

    it('la recherche porte sur tout le corps, pas sur les seuls champs `id`', async () => {
      // Un identifiant étranger fuit aussi bien par une clé étrangère, un lien de
      // pagination ou un message d'erreur que par un champ `id`.
      const etranger = harness.b.id;

      expect(() => expectExcludesForeignIds({ meta: { tenant: etranger } }, [etranger])).toThrow();
      expect(() => expectExcludesForeignIds([{ id: 'a', categoryId: etranger }], [etranger])).toThrow();
    });

    it('refuse une liste vide présentée comme complète', async () => {
      // « Aucun identifiant du voisin » est satisfait par une liste vide, qui ne
      // prouve rien du filtrage : `expectListScopedTo` exige aussi la présence de
      // ce qui doit s'y trouver.
      expect(() => expectListScopedTo([], { ownIds: ['a'], foreignIds: ['z'] })).toThrow();
      expect(() => expectListScopedTo({ items: [] }, { ownIds: [], foreignIds: ['z'] })).toThrow();
    });

    it('accepte un voisin sans ressource de ce type', () => {
      // L'égalité d'ensemble a déjà exercé le filtrage : un `foreignIds` vide est
      // un cas légitime, pas un scénario qui ne vérifie rien. Le refuser ferait
      // rougir la suite en annonçant l'inverse de ce qui vient d'être prouvé.
      expect(() =>
        expectListScopedTo([{ id: 'a' }], { ownIds: ['a'], foreignIds: [] }),
      ).not.toThrow();
    });
  });

  describe('le catalogue public passe par les mêmes établissements', () => {
    it('le slug d’URL ne sert que les prestations de son établissement', async () => {
      const chezA = catalog.seedService({ tenantId: harness.a.id, name: 'Chez A' });
      const chezB = catalog.seedService({ tenantId: harness.b.id, name: 'Chez B' });

      const vitrine = await request(server())
        .get(`/api/v1/public/${harness.a.slug}/services`)
        .expect(200);

      expectExcludesForeignIds(vitrine.body, [chezB.id, harness.b.id]);
      expect(JSON.stringify(vitrine.body)).toContain(chezA.id);
    });

    it('une prestation créée par l’API atterrit dans l’établissement du jeton', async () => {
      // La contrepartie du reste : le harnais doit aussi permettre d'**écrire**,
      // sans quoi les suites en resteraient à des jeux d'essai posés à la main.
      const cree = await request(server())
        .post('/api/v1/services')
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .send({ name: 'Massage 60 min', durationMinutes: 60, price: EUR })
        .expect(201);

      expect(catalog.services).toHaveLength(1);
      expect(catalog.services[0]).toMatchObject({ tenantId: harness.b.id, id: cree.body.id });
      // Le `tenantId` reste interne : il n'a rien à faire dans une réponse.
      expectExcludesForeignIds(cree.body, [harness.b.id]);
    });
  });
});
