import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { MAX_TIME_OFF_RANGE_DAYS } from '../src/modules/availability/availability.errors';
import { createAvailabilityHarness, type AvailabilityHarness } from './availability.harness';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Plages bloquées et congés du personnel, en HTTP (#33, livré par #303).
 *
 * Les quatre routes de `/api/v1/staff-time-off` y sont exercées pour ce que
 * `npm run test:unit` ne peut pas prouver : qu'elles sont **servies**, que les
 * gardes montent, que le `ValidationPipe` global refuse ce qu'il doit refuser,
 * et que le corps d'erreur a la forme `{ code, message, details }` du contrat.
 *
 * | Route | Rang | Ce qui s'y joue |
 * |---|---|---|
 * | `GET /staff-time-off` | `STAFF` | le planning d'une fenêtre, bornée par le service |
 * | `GET /staff-time-off/:id` | `STAFF` | une absence, ou 404 |
 * | `POST /staff-time-off` | `MANAGER` | la pose, et le 404 du praticien inconnu |
 * | `PATCH /staff-time-off/:id` | `MANAGER` | le patch, jugé **fusionné** avec la base |
 * | `DELETE /staff-time-off/:id` | `MANAGER` | le retrait, et le cache chassé |
 *
 * L'isolation inter-tenant, elle, a sa propre suite —
 * `availability-time-off.isolation-spec.ts` — pour que sa panne nomme une
 * traversée d'établissement et non « un test d'intégration ».
 *
 * ## Ce que la première assertion prouve, et qui n'est pas dans ce module
 *
 * `AvailabilityModule` doit figurer dans les `imports` d'`AppModule`, faute de
 * quoi ces cinq routes compilent, passent leurs tests unitaires et ne sont
 * servies nulle part (#303, première case). Le harnais monte le **vrai**
 * `AppModule` : un module absent du graphe rendrait 404 là où le contrat annonce
 * 401. C'est la première assertion de cette suite, et elle est délibérément
 * écrite ici plutôt qu'en test de métadonnées — ce qu'il faut constater, c'est
 * qu'une requête HTTP atteint le contrôleur, pas qu'une classe figure dans un
 * tableau.
 */

const PATH = '/api/v1/staff-time-off';
const pathOf = (id: string): string => `${PATH}/${id}`;

/** Un congé de trois jours, posé en heure **locale** parisienne. */
const AUGUST_3_PARIS = '2026-08-03T00:00:00+02:00';
const AUGUST_6_PARIS = '2026-08-06T00:00:00+02:00';

/** Les mêmes bornes, telles que l'API les rend — normalisées en UTC. */
const AUGUST_3_UTC = '2026-08-02T22:00:00.000Z';
const AUGUST_6_UTC = '2026-08-05T22:00:00.000Z';

/** La fenêtre de planning qui contient ce congé. */
const WINDOW = { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' } as const;

describe('Plages bloquées et congés du personnel', () => {
  let harness: AvailabilityHarness;
  let staffId: string;

  beforeEach(async () => {
    harness = await createAvailabilityHarness();
    staffId = harness.timeOff.registerStaff(harness.a.id);
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Pose le congé de référence et rend la réponse de création. */
  const seedTimeOff = async (
    body: Record<string, unknown> = {},
  ): Promise<request.Response> =>
    request(server())
      .post(PATH)
      .set('Authorization', await harness.bearer('MANAGER'))
      .send({ staffId, startsAt: AUGUST_3_PARIS, endsAt: AUGUST_6_PARIS, ...body })
      .expect(201);

  /**
   * Une clé de cache de l'établissement, pour constater qu'une écriture la
   * chasse. La forme est celle de `availabilityDayKey` — le tenant en tête,
   * c'est ce qui rend l'invalidation par préfixe possible.
   */
  const seedCacheKey = (tenantId: string): string => {
    const key = `avail:${tenantId}:${UNKNOWN_ID}:any:2026-08-04`;
    harness.cache.entries.set(key, '{"timezone":"Europe/Paris","slots":[]}');

    return key;
  };

  describe('le module est servi par AppModule', () => {
    it('répond 401 — et non 404 — sur la liste sans jeton', async () => {
      // Un 404 ici voudrait dire que `AvailabilityModule` n'est pas dans les
      // `imports` d'`AppModule` : le contrôleur existerait sans être monté.
      const response = await request(server()).get(PATH).query(WINDOW).expect(401);

      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('sert les cinq chemins du contrôleur, pas seulement la racine', async () => {
      // La route paramétrée et les verbes d'écriture sont montés par le même
      // enregistrement ; un 404 sur l'un d'eux ne pourrait venir que d'un
      // contrôleur absent des `controllers` du module.
      await request(server()).get(pathOf(UNKNOWN_ID)).expect(401);
      await request(server()).post(PATH).send({}).expect(401);
      await request(server()).patch(pathOf(UNKNOWN_ID)).send({}).expect(401);
      await request(server()).delete(pathOf(UNKNOWN_ID)).expect(401);
    });
  });

  describe('POST /staff-time-off', () => {
    it('pose un congé et rend ses bornes normalisées en UTC', async () => {
      const response = await seedTimeOff({ reason: 'Formation' });

      // L'appelant a posé des heures **locales** ; l'API rend des instants.
      // C'est la frontière de conversion de `ToUtcInstant`, et la seule façon de
      // la voir depuis l'extérieur.
      expect(response.body).toEqual({
        id: expect.any(String),
        staffId,
        startsAt: AUGUST_3_UTC,
        endsAt: AUGUST_6_UTC,
        reason: 'Formation',
      });
    });

    it('accepte une absence sans motif, rendue à null', async () => {
      const response = await seedTimeOff();

      expect(response.body.reason).toBeNull();
    });

    it('élague le motif avant de l’écrire', async () => {
      const response = await seedTimeOff({ reason: '  Formation  ' });

      expect(response.body.reason).toBe('Formation');
    });

    it('ne laisse filtrer aucun identifiant d’établissement', async () => {
      const response = await seedTimeOff({ reason: 'Formation' });

      // `tenantId` est une information interne : il n'apporte rien au
      // consommateur et invite aux essais (tenant-isolation §4).
      expect(JSON.stringify(response.body)).not.toContain(harness.a.id);
    });

    it('chasse le cache de disponibilité de l’établissement', async () => {
      // Le point qui s'oublie et qui ne se rattrape pas : un cache qui montre un
      // créneau pendant un congé produit une réservation que personne n'honorera.
      seedCacheKey(harness.a.id);

      await seedTimeOff();

      expect(harness.cache.keysOf(harness.a.id)).toEqual([]);
    });

    it('refuse en 400 un staffId qui n’est pas un UUID', async () => {
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: 'pas-un-uuid', startsAt: AUGUST_3_PARIS, endsAt: AUGUST_6_PARIS })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(response.body).toHaveProperty('details');
      expect(JSON.stringify(response.body.details)).toContain('staffId');
    });

    it('refuse en 400 une date-heure sans offset explicite', async () => {
      // « Le 3 août à minuit » ne désigne pas le même instant à Paris et à
      // Papeete : accepter la forme nue obligerait le serveur à deviner un
      // fuseau (#41).
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId, startsAt: '2026-08-03T00:00:00', endsAt: AUGUST_6_PARIS })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body.details)).toContain('startsAt');
    });

    it('refuse en 400 un champ non déclaré — dont un tenantId glissé dans le corps', async () => {
      // `forbidNonWhitelisted` est ce qui empêche l'injection d'un tenant par le
      // corps de la requête (tenant-isolation §2).
      await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          staffId,
          startsAt: AUGUST_3_PARIS,
          endsAt: AUGUST_6_PARIS,
          tenantId: harness.b.id,
        })
        .expect(400);

      expect(harness.timeOff.snapshot()).toEqual([]);
    });

    it('refuse en 422 une fin qui précède le début', async () => {
      // 422 et non 400 : chaque borne est bien écrite, c'est leur mise en
      // présence qui ne tient pas.
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId, startsAt: AUGUST_6_PARIS, endsAt: AUGUST_3_PARIS })
        .expect(422);

      expect(response.body.code).toBe('TIME_OFF_RANGE_INVALID');
      expect(response.body.details).toMatchObject({ rule: 'ends_before_starts' });
    });

    it('refuse en 422 une absence vide — fin égale au début', async () => {
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId, startsAt: AUGUST_3_PARIS, endsAt: AUGUST_3_PARIS })
        .expect(422);

      expect(response.body.details).toMatchObject({ rule: 'ends_before_starts' });
    });

    it('refuse en 422 une absence de plus d’un an', async () => {
      // La borne de faute de frappe : « 20 26 » au lieu de 2026 blanchirait
      // l'agenda du praticien pour deux siècles, sans erreur ni trace.
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          staffId,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-04T00:00:00Z',
        })
        .expect(422);

      expect(response.body.details).toMatchObject({
        rule: 'range_too_wide',
        maxRangeDays: MAX_TIME_OFF_RANGE_DAYS,
      });
    });

    it('répond 404 sur un praticien qui n’existe pas', async () => {
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: UNKNOWN_ID, startsAt: AUGUST_3_PARIS, endsAt: AUGUST_6_PARIS })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('réserve la pose au rang MANAGER', async () => {
      await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ staffId, startsAt: AUGUST_3_PARIS, endsAt: AUGUST_6_PARIS })
        .expect(403);
    });
  });

  describe('GET /staff-time-off', () => {
    it('rend le planning de la fenêtre', async () => {
      const created = await seedTimeOff({ reason: 'Formation' });

      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual([
        {
          id: created.body.id,
          staffId,
          startsAt: AUGUST_3_UTC,
          endsAt: AUGUST_6_UTC,
          reason: 'Formation',
        },
      ]);
    });

    it('rend une liste vide quand rien ne recoupe la fenêtre', async () => {
      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('retient une absence qui recoupe la fenêtre sans y être incluse', async () => {
      // La règle est le **recoupement**, pas l'inclusion : un congé commencé le
      // mois dernier et courant toujours appartient au planning de ce mois-ci.
      await seedTimeOff({ startsAt: '2026-07-20T00:00:00Z', endsAt: '2026-08-05T00:00:00Z' });

      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('écarte une absence entièrement hors de la fenêtre', async () => {
      await seedTimeOff({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-05T00:00:00Z' });

      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('restreint le planning à un praticien', async () => {
      const other = harness.timeOff.registerStaff(harness.a.id);

      await seedTimeOff();
      await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: other, startsAt: AUGUST_3_PARIS, endsAt: AUGUST_6_PARIS })
        .expect(201);

      const response = await request(server())
        .get(PATH)
        .query({ ...WINDOW, staffId: other })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].staffId).toBe(other);
    });

    it('accepte une fenêtre à offset explicite', async () => {
      await seedTimeOff();

      const response = await request(server())
        .get(PATH)
        .query({ from: '2026-08-01T00:00:00+02:00', to: '2026-09-01T00:00:00+02:00' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('refuse en 400 une fenêtre absente', async () => {
      const response = await request(server())
        .get(PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(response.body).toHaveProperty('details');
    });

    it('refuse en 422 une fenêtre inversée', async () => {
      const response = await request(server())
        .get(PATH)
        .query({ from: WINDOW.to, to: WINDOW.from })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(422);

      expect(response.body.code).toBe('TIME_OFF_RANGE_INVALID');
    });

    it('refuse en 422 une fenêtre de plus d’un an', async () => {
      // Sans plafond, l'ouverture du planning rendrait tout l'historique de
      // l'établissement — ce qu'aucun écran n'affiche.
      await request(server())
        .get(PATH)
        .query({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(422);
    });

    it('refuse le rang CLIENT', async () => {
      // Ces motifs sont internes : le parcours client n'a rien à en savoir.
      await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('CLIENT'))
        .expect(403);
    });
  });

  describe('GET /staff-time-off/:id', () => {
    it('rend l’absence demandée', async () => {
      const created = await seedTimeOff({ reason: 'Formation' });

      const response = await request(server())
        .get(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual(created.body);
    });

    it('répond 404 sur un identifiant inconnu', async () => {
      const response = await request(server())
        .get(pathOf(UNKNOWN_ID))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('refuse en 400 un identifiant qui n’est pas un UUID', async () => {
      const response = await request(server())
        .get(pathOf('pas-un-uuid'))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('PATCH /staff-time-off/:id', () => {
    it('déplace une absence sans toucher au reste', async () => {
      const created = await seedTimeOff({ reason: 'Formation' });

      const response = await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ endsAt: '2026-08-08T00:00:00+02:00' })
        .expect(200);

      expect(response.body).toEqual({
        id: created.body.id,
        staffId,
        startsAt: AUGUST_3_UTC,
        endsAt: '2026-08-07T22:00:00.000Z',
        reason: 'Formation',
      });
    });

    it('efface le motif sur un null explicite', async () => {
      const created = await seedTimeOff({ reason: 'Formation' });

      const response = await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ reason: null })
        .expect(200);

      expect(response.body.reason).toBeNull();
    });

    it('chasse le cache de disponibilité de l’établissement', async () => {
      const created = await seedTimeOff();
      seedCacheKey(harness.a.id);

      await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ reason: 'Congé' })
        .expect(200);

      expect(harness.cache.keysOf(harness.a.id)).toEqual([]);
    });

    it('refuse en 422 une borne qui, fusionnée avec la base, inverse l’absence', async () => {
      // C'est précisément le cas qu'un décorateur de DTO ne peut pas voir : la
      // requête ne porte qu'une borne, l'autre se lit en base.
      const created = await seedTimeOff();

      const response = await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ endsAt: '2026-08-01T00:00:00+02:00' })
        .expect(422);

      expect(response.body.code).toBe('TIME_OFF_RANGE_INVALID');
      expect(response.body.details).toMatchObject({ rule: 'ends_before_starts' });
    });

    it('refuse en 400 un changement de praticien', async () => {
      // Déplacer une absence d'un praticien à un autre n'est pas une
      // modification : c'est une absence retirée et une autre posée.
      const created = await seedTimeOff();
      const other = harness.timeOff.registerStaff(harness.a.id);

      await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: other })
        .expect(400);
    });

    it('refuse en 400 une borne à null', async () => {
      // `reason` est effaçable, les bornes ne le sont pas : une absence sans
      // début n'existe pas.
      const created = await seedTimeOff();

      await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ startsAt: null })
        .expect(400);
    });

    it('répond 404 sur un identifiant inconnu', async () => {
      await request(server())
        .patch(pathOf(UNKNOWN_ID))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ reason: 'Congé' })
        .expect(404);
    });

    it('réserve la modification au rang MANAGER', async () => {
      const created = await seedTimeOff();

      await request(server())
        .patch(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ reason: 'Congé' })
        .expect(403);
    });
  });

  describe('DELETE /staff-time-off/:id', () => {
    it('retire l’absence et la rend introuvable', async () => {
      const created = await seedTimeOff();

      await request(server())
        .delete(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(204);

      await request(server())
        .get(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);
    });

    it('chasse le cache de disponibilité de l’établissement', async () => {
      // L'invalidation compte davantage ici qu'à la création : un cache périmé
      // qui masque un créneau redevenu libre fait perdre une vente sans que rien
      // ne le signale.
      const created = await seedTimeOff();
      seedCacheKey(harness.a.id);

      await request(server())
        .delete(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(204);

      expect(harness.cache.keysOf(harness.a.id)).toEqual([]);
    });

    it('répond 404 sur un identifiant inconnu', async () => {
      const response = await request(server())
        .delete(pathOf(UNKNOWN_ID))
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('réserve le retrait au rang MANAGER', async () => {
      const created = await seedTimeOff();

      await request(server())
        .delete(pathOf(created.body.id))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);

      expect(harness.timeOff.snapshot()).toHaveLength(1);
    });
  });
});
