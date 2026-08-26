import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createCatalogHarness, type CatalogHarness } from './catalog.harness';

/**
 * Le catalogue **public** (#25) exercé en HTTP, sur l'application réellement
 * câblée — middleware de portée, `ValidationPipe` global, filtre d'exceptions.
 *
 * C'est la seule route du module `catalog` qui ne se désigne pas par un jeton :
 * l'établissement vient d'un slug d'URL, résolu par `TenantScopeMiddleware`
 * contre la table `tenants`. Sa traversée ne peut donc pas se prouver dans
 * `catalog-tenant.isolation-spec.ts`, dont tous les cas partent d'un porteur —
 * d'où cette suite, et non quelques cas de plus là-bas.
 *
 * Trois propriétés se jouent ici, et ce sont les trois par lesquelles une fuite
 * passerait sur une surface **ouverte** :
 *
 * 1. le slug résout **un** établissement, et la réponse ne contient que le sien ;
 * 2. un slug inconnu, fermé ou mal formé est refusé **avant** le contrôleur —
 *    donc sans qu'une seule lecture de catalogue ait lieu ;
 * 3. la projection publique ne rend que ce qu'un visiteur a le droit de voir :
 *    ni les tampons, ni `occupiedMinutes`, ni `isActive`, ni `tenantId`, ni une
 *    prestation retirée, ni un praticien qui ne prend plus de rendez-vous.
 *
 * La première et la troisième sont de l'isolation au sens strict — ce que le
 * voisin ne doit pas voir. La deuxième l'est tout autant : sur une surface sans
 * jeton, la seule frontière est celle que le middleware pose, et un refus tardif
 * signifierait qu'un chemin y échappe.
 *
 * ## Morsure vérifiée par mutation
 *
 * Deux mutations ont été appliquées puis retirées (#234) :
 *
 * | Mutation | Cas qui tombent |
 * |---|---|
 * | `toPublicServiceView` remplacé par un étalement du record | « ni les tampons, ni la durée occupée, ni le drapeau d'activité, ni le tenant » |
 * | le refus de `TenantScopeMiddleware.resolveOrRefuse` remplacé par un identifiant arbitraire | les trois cas de slug qui ne résout pas, et l'égalité des corps d'erreur |
 */

const FERME = 'salon-ferme';

const CATALOGUE = (slug: string): string => `/api/v1/public/${slug}/services`;

/**
 * Sentinelle posée sur la lecture du catalogue : le critère « refusé **avant**
 * le contrôleur » ne se prouve pas par le code de statut — un service qui
 * lèverait `NotFoundError` rendrait le même 404 — mais par le fait que rien n'a
 * tourné.
 */
let lecturesDuCatalogue = 0;

describe('Isolation inter-tenant — catalogue public', () => {
  let harness: CatalogHarness;
  /** Le slug de l'établissement servi. */
  let salon: string;
  /** Le slug de l'établissement voisin, celui qu'aucune réponse ne doit montrer. */
  let barbier: string;

  beforeEach(async () => {
    harness = await createCatalogHarness();
    salon = harness.tenantSlug;
    barbier = harness.otherTenantSlug;
    harness.identity.addTenant(FERME, undefined, { isActive: false });

    lecturesDuCatalogue = 0;
    const surveille = harness.repository.listPublicServices.bind(harness.repository);
    harness.repository.listPublicServices = async (): ReturnType<
      CatalogHarness['repository']['listPublicServices']
    > => {
      lecturesDuCatalogue += 1;
      return surveille();
    };
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  describe('le slug d’URL résout l’établissement', () => {
    it('sert le catalogue du salon demandé, praticiens compris, sans jeton', async () => {
      const massage = harness.repository.seedService({
        tenantId: harness.tenantId,
        name: 'Massage 60 min',
        slug: 'massage-60-min',
      });
      const alix = harness.repository.seedStaff({
        tenantId: harness.tenantId,
        displayName: 'Alix',
      });
      const zoe = harness.repository.seedStaff({ tenantId: harness.tenantId, displayName: 'Zoé' });
      harness.repository.seedAssignment({
        tenantId: harness.tenantId,
        serviceId: massage.id,
        staffId: zoe.id,
      });
      harness.repository.seedAssignment({
        tenantId: harness.tenantId,
        serviceId: massage.id,
        staffId: alix.id,
      });

      // Aucun en-tête `Authorization` : c'est le propos de cette surface.
      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      // La sentinelle compte bien les lectures — sans quoi les cas « refusé
      // avant le contrôleur » plus bas seraient vrais pour la mauvaise raison.
      expect(lecturesDuCatalogue).toBe(1);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        id: massage.id,
        slug: 'massage-60-min',
        durationMinutes: 60,
        price: { amountMinor: 7000, currency: 'EUR' },
      });
      // Triés par nom d'affichage, et réduits à ce qu'un choix de praticien
      // demande — un identifiant et un nom.
      expect(response.body[0].staff).toEqual([
        { id: alix.id, displayName: 'Alix' },
        { id: zoe.id, displayName: 'Zoé' },
      ]);
    });

    it('un salon sans catalogue rend une liste vide, jamais un 404', async () => {
      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      // Un 404 se lirait « ce salon n'existe pas », ce qui est faux : sa page de
      // réservation doit pouvoir dire qu'il n'a rien saisi.
      expect(response.body).toEqual([]);
      expect(lecturesDuCatalogue).toBe(1);
    });
  });

  describe('un slug qui ne résout pas est refusé avant le contrôleur', () => {
    it.each([
      ['slug inconnu', 'salon-fantome'],
      ['slug mal formé', 'salon_des_lilas'],
      ['établissement désactivé', FERME],
      // Traversée dont le séparateur est encodé : `new URL` ne la réduit pas —
      // contrairement à `..` — donc le segment arrive **entier** au middleware,
      // qui est bien celui qui doit le refuser.
      ['traversée au séparateur encodé', '..%2f..'],
    ])('%s → 404, catalogue jamais lu', async (_cas, slug) => {
      const response = await request(server()).get(CATALOGUE(slug)).expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // Le cœur du critère : aucun code métier n'a tourné.
      expect(lecturesDuCatalogue).toBe(0);
    });

    it('une tentative de traversée retombe sur le back-office, qui reste gardé', async () => {
      // `/api/v1/public/../services` est normalisé **par le client HTTP** en
      // `/api/v1/services` : la requête n'atteint jamais l'espace public, elle
      // atteint la route de back-office du catalogue. Le refus qu'on attend
      // n'est donc pas celui du middleware mais celui de la garde — 401, faute
      // de jeton — et c'est la bonne réponse : la traversée ne contourne rien,
      // elle change simplement de porte, et l'autre est verrouillée. Le refus du
      // middleware sur une traversée, lui, se prouve au cas
      // « traversée au séparateur encodé » ci-dessus, que `new URL` laisse passer.
      await request(server()).get(CATALOGUE('..')).expect(401);

      expect(lecturesDuCatalogue).toBe(0);
    });

    it('rend le même corps pour un slug inconnu et pour un établissement fermé', async () => {
      // Les distinguer dirait à un visiteur qu'un salon a existé, et lequel.
      const inconnu = await request(server()).get(CATALOGUE('jamais-vu')).expect(404);
      const ferme = await request(server()).get(CATALOGUE(FERME)).expect(404);

      expect(inconnu.body).toEqual(ferme.body);
      // Le corps du salon **fermé** est celui qui pourrait le nommer — c'est lui
      // qu'il faut inspecter ; chercher `FERME` dans la réponse au slug inconnu
      // ne pourrait jamais échouer.
      expect(JSON.stringify(ferme.body)).not.toContain(FERME);
      expect(JSON.stringify(inconnu.body)).not.toContain('jamais-vu');
    });
  });

  describe('ce que la page publique ne doit pas porter', () => {
    it('ni les tampons, ni la durée occupée, ni le drapeau d’activité, ni le tenant', async () => {
      harness.repository.seedService({
        tenantId: harness.tenantId,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
      });

      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      // Égalité de clés, et non une liste d'absences : un champ interne ajouté
      // par mégarde à la projection doit faire échouer ce test.
      expect(Object.keys(response.body[0]).sort()).toEqual([
        'category',
        'description',
        'durationMinutes',
        'id',
        'name',
        'price',
        'slug',
        'staff',
      ]);
      // Les tampons sont des temps de cabine — la cadence interne du salon — et
      // `occupiedMinutes` les redonnerait par soustraction.
      expect(JSON.stringify(response.body)).not.toContain(harness.tenantId);
    });

    it('tait la prestation retirée du catalogue', async () => {
      harness.repository.seedService({
        tenantId: harness.tenantId,
        slug: 'active',
        name: 'Active',
      });
      const retiree = harness.repository.seedService({
        tenantId: harness.tenantId,
        slug: 'retiree',
        name: 'Retirée',
        isActive: false,
      });

      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      expect(response.body.map((service: { slug: string }) => service.slug)).toEqual(['active']);
      expect(JSON.stringify(response.body)).not.toContain(retiree.id);
    });

    it('ne propose pas au choix un praticien désactivé', async () => {
      const service = harness.repository.seedService({ tenantId: harness.tenantId });
      const partant = harness.repository.seedStaff({
        tenantId: harness.tenantId,
        displayName: 'Partant',
        isActive: false,
      });
      harness.repository.seedAssignment({
        tenantId: harness.tenantId,
        serviceId: service.id,
        staffId: partant.id,
      });

      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      // L'affectation lui survit — le back-office la montre encore — mais le
      // proposer ici mènerait à un créneau qu'aucun agenda ne peut honorer.
      expect(response.body[0].staff).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(partant.id);
    });
  });

  describe('isolation inter-tenant', () => {
    it('le catalogue d’un slug ne laisse rien voir de l’autre', async () => {
      const chezSalon = harness.repository.seedService({
        tenantId: harness.tenantId,
        slug: 'chez-salon',
        name: 'Chez Salon',
      });
      const chezBarbier = harness.repository.seedService({
        tenantId: harness.otherTenantId,
        slug: 'chez-barbier',
        name: 'Chez Barbier',
      });

      const vuDuSalon = await request(server()).get(CATALOGUE(salon)).expect(200);
      const vuDuBarbier = await request(server()).get(CATALOGUE(barbier)).expect(200);

      expect(vuDuSalon.body).toHaveLength(1);
      expect(vuDuSalon.body[0].id).toBe(chezSalon.id);
      expect(JSON.stringify(vuDuSalon.body)).not.toContain(chezBarbier.id);

      expect(vuDuBarbier.body).toHaveLength(1);
      expect(vuDuBarbier.body[0].id).toBe(chezBarbier.id);
      expect(JSON.stringify(vuDuBarbier.body)).not.toContain(chezSalon.id);
    });

    it('ne publie pas le praticien du voisin, même sur une affectation croisée', async () => {
      const service = harness.repository.seedService({ tenantId: harness.tenantId });
      const voisin = harness.repository.seedStaff({
        tenantId: harness.otherTenantId,
        displayName: 'Voisin',
      });
      // Ligne que les clés étrangères composites rendent impossible en base,
      // posée de force : si une couche la rendait visible, ce cas le dirait.
      harness.repository.seedAssignment({
        tenantId: harness.otherTenantId,
        serviceId: service.id,
        staffId: voisin.id,
      });

      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      expect(response.body[0].staff).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(voisin.id);
    });

    it('ne publie pas le praticien du voisin quand la ligne croisée porte notre tenant', async () => {
      // L'autre moitié du cas précédent. Là-bas, la ligne d'affectation portait
      // le tenant du voisin : le filtre sur l'affectation suffisait à l'écarter,
      // et la portée du **praticien** n'était donc jamais mise à l'épreuve. Ici
      // la ligne porte notre tenant et désigne une fiche d'ailleurs — seule la
      // portée du praticien peut encore l'écarter.
      const service = harness.repository.seedService({ tenantId: harness.tenantId });
      const voisin = harness.repository.seedStaff({
        tenantId: harness.otherTenantId,
        displayName: 'Voisin',
      });
      harness.repository.seedAssignment({
        tenantId: harness.tenantId,
        serviceId: service.id,
        staffId: voisin.id,
      });

      const response = await request(server()).get(CATALOGUE(salon)).expect(200);

      expect(response.body[0].staff).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(voisin.id);
    });

    it('un paramètre de requête ne déplace pas la portée', async () => {
      harness.repository.seedService({
        tenantId: harness.otherTenantId,
        slug: 'chez-barbier',
        name: 'Chez Barbier',
      });

      const response = await request(server())
        .get(`${CATALOGUE(salon)}?tenantId=${harness.otherTenantId}`)
        .expect(200);

      // Rien ne lit ce paramètre : la portée reste celle du slug d'URL résolu.
      expect(response.body).toEqual([]);
    });

    it('un jeton du voisin ne déplace pas la portée d’une route publique', async () => {
      // La route est ouverte : elle n'a pas de garde, donc rien ne lit
      // l'en-tête. Le porteur d'un jeton valide émis ailleurs n'obtient pas pour
      // autant le catalogue de son propre établissement sur ce chemin.
      const chezSalon = harness.repository.seedService({
        tenantId: harness.tenantId,
        slug: 'chez-salon',
        name: 'Chez Salon',
      });
      const chezBarbier = harness.repository.seedService({
        tenantId: harness.otherTenantId,
        slug: 'chez-barbier',
        name: 'Chez Barbier',
      });

      const response = await request(server())
        .get(CATALOGUE(salon))
        .set('Authorization', `Bearer ${await harness.tokenFor('ADMIN', harness.otherTenantId)}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(chezSalon.id);
      expect(JSON.stringify(response.body)).not.toContain(chezBarbier.id);
    });
  });
});
