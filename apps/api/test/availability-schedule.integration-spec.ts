import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import {
  createAvailabilityHarness,
  OTHER_TENANT_TIMEZONE,
  TENANT_TIMEZONE,
  type AvailabilityHarness,
} from './availability.harness';

/**
 * Horaires récurrents du personnel et jours de fermeture, en HTTP (#32).
 *
 * Les quatre routes du module y sont exercées pour ce que `npm run test:unit`
 * ne peut pas prouver : qu'elles sont **servies**, que les gardes montent, que
 * le `ValidationPipe` global refuse ce qu'il doit refuser, et que le corps
 * d'erreur a la forme `{ code, message, details }` du contrat.
 *
 * | Route | Lecture | Écriture |
 * |---|---|---|
 * | `GET /staff/:staffId/schedule` | `STAFF` | — |
 * | `PUT /staff/:staffId/schedule` | — | `MANAGER` |
 * | `GET /closing-days` | `STAFF` | — |
 * | `PUT /closing-days` | — | `MANAGER` |
 *
 * L'isolation inter-tenant, elle, a sa propre suite —
 * `availability-tenant.isolation-spec.ts` — pour que sa panne nomme une
 * traversée d'établissement et non « un test d'intégration ».
 */

const SCHEDULE_PATH = (staffId: string): string => `/api/v1/staff/${staffId}/schedule`;
const CLOSING_DAYS_PATH = '/api/v1/closing-days';

describe('Horaires récurrents du personnel', () => {
  let harness: AvailabilityHarness;
  let staffId: string;

  beforeEach(async () => {
    harness = await createAvailabilityHarness();
    staffId = harness.repository.seedStaff({ tenantId: harness.a.id }).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  describe('GET /staff/:staffId/schedule', () => {
    it('rend une semaine vide et le fuseau de l’établissement', async () => {
      const response = await request(server())
        .get(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual({ staffId, timezone: TENANT_TIMEZONE, entries: [] });
    });

    it('ne laisse filtrer aucun identifiant d’établissement', async () => {
      const response = await request(server())
        .get(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      // `tenantId` est une information interne : il n'apporte rien au
      // consommateur et invite aux essais (tenant-isolation §4).
      expect(JSON.stringify(response.body)).not.toContain(harness.a.id);
    });

    it('exige un jeton', async () => {
      await request(server()).get(SCHEDULE_PATH(staffId)).expect(401);
    });

    it('refuse un identifiant qui n’est pas un UUID', async () => {
      const response = await request(server())
        .get(SCHEDULE_PATH('pas-un-uuid'))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('répond 404 sur un praticien inconnu', async () => {
      const response = await request(server())
        .get(SCHEDULE_PATH('99999999-9999-4999-8999-999999999999'))
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /staff/:staffId/schedule', () => {
    it('écrit une journée à coupure méridienne et la relit triée', async () => {
      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          entries: [
            { weekday: 2, startsAt: '14:00', endsAt: '18:00' },
            { weekday: 2, startsAt: '09:00', endsAt: '12:00' },
          ],
        })
        .expect(200);

      expect(response.body.entries).toEqual([
        { weekday: 2, startsAt: '09:00', endsAt: '12:00' },
        { weekday: 2, startsAt: '14:00', endsAt: '18:00' },
      ]);
    });

    it('accepte minuit comme borne de fin', async () => {
      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 5, startsAt: '18:00', endsAt: '24:00' }] })
        .expect(200);

      expect(response.body.entries[0].endsAt).toBe('24:00');
    });

    it('vide la semaine sur un tableau vide', async () => {
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 2, startsAt: '09:00', endsAt: '12:00' }] })
        .expect(200);

      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [] })
        .expect(200);

      expect(response.body.entries).toEqual([]);
    });

    it('refuse en 400 une heure hors de l’horloge', async () => {
      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 2, startsAt: '25:00', endsAt: '26:00' }] })
        .expect(400);

      // `VALIDATION_ERROR` et non `BAD_REQUEST` : le filtre distingue le refus
      // du `ValidationPipe` — qui sait nommer le champ — d'un 400 générique.
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(response.body).toHaveProperty('details');
    });

    it('refuse en 400 une plage dont la fin précède le début', async () => {
      // Chaque borne est bien écrite, et une plage seule ne recouvre rien : sans
      // contrôle au DTO, celle-ci traversait jusqu'à
      // `staff_schedules_minutes_check` et ressortait en 500 (recette #32).
      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 3, startsAt: '12:00', endsAt: '09:00' }] })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(response.body.details)).toContain('endsAt');
    });

    it('refuse en 400 une plage vide — fin égale au début', async () => {
      // Elle ne produirait aucun créneau et ne déclencherait pas non plus la
      // contrainte d'exclusion : un horaire saisi qui ne sert à rien.
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 3, startsAt: '09:00', endsAt: '09:00' }] })
        .expect(400);
    });

    it('refuse en 400 un début à 24:00, qui ne peut désigner qu’une plage vide', async () => {
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 3, startsAt: '24:00', endsAt: '24:00' }] })
        .expect(400);
    });

    it('refuse en 400 le 0-dimanche de Date.getDay', async () => {
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [{ weekday: 0, startsAt: '09:00', endsAt: '12:00' }] })
        .expect(400);
    });

    it('refuse en 400 un champ non déclaré — dont un tenantId glissé dans le corps', async () => {
      // `forbidNonWhitelisted` est ce qui empêche l'injection d'un tenant par le
      // corps de la requête (tenant-isolation §2).
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          entries: [{ weekday: 2, startsAt: '09:00', endsAt: '12:00' }],
          tenantId: harness.b.id,
        })
        .expect(400);
    });

    it('refuse en 422 deux plages du même jour qui se recouvrent', async () => {
      const response = await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          entries: [
            { weekday: 2, startsAt: '09:00', endsAt: '13:00' },
            { weekday: 2, startsAt: '12:00', endsAt: '18:00' },
          ],
        })
        .expect(422);

      expect(response.body.code).toBe('OVERLAPPING_SCHEDULE_RANGES');
      expect(response.body.details).toEqual({ weekday: 2, ranges: ['09:00–13:00', '12:00–18:00'] });
    });

    it('accepte deux plages adjacentes', async () => {
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          entries: [
            { weekday: 2, startsAt: '09:00', endsAt: '12:00' },
            { weekday: 2, startsAt: '12:00', endsAt: '18:00' },
          ],
        })
        .expect(200);
    });

    it('réserve l’écriture au rang MANAGER', async () => {
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ entries: [] })
        .expect(403);
    });

    it('exige un jeton', async () => {
      await request(server()).put(SCHEDULE_PATH(staffId)).send({ entries: [] }).expect(401);
    });
  });

  describe('jours de fermeture', () => {
    it('rend une liste vide pour un salon ouvert toute la semaine', async () => {
      const response = await request(server())
        .get(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual({ weekdays: [] });
    });

    it('remplace la liste et la relit croissante', async () => {
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ weekdays: [7, 1] })
        .expect(200);

      const response = await request(server())
        .get(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual({ weekdays: [1, 7] });
    });

    it('rouvre toute la semaine sur une liste vide', async () => {
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ weekdays: [7] })
        .expect(200);

      const response = await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ weekdays: [] })
        .expect(200);

      expect(response.body).toEqual({ weekdays: [] });
    });

    it('refuse en 400 un jour déclaré deux fois', async () => {
      // Sans ce refus, l'unique `(tenant_id, weekday)` produirait une violation
      // brute, donc un 500 là où le contrat annonce un 400.
      const response = await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ weekdays: [7, 7] })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuse en 400 un jour hors de la semaine', async () => {
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ weekdays: [8] })
        .expect(400);
    });

    it('réserve l’écriture au rang MANAGER', async () => {
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ weekdays: [] })
        .expect(403);
    });

    it('exige un jeton en lecture comme en écriture', async () => {
      await request(server()).get(CLOSING_DAYS_PATH).expect(401);
      await request(server()).put(CLOSING_DAYS_PATH).send({ weekdays: [] }).expect(401);
    });
  });

  describe('fuseau de l’établissement', () => {
    it('rend celui du porteur du jeton, jamais celui du voisin', async () => {
      const neighbourStaff = harness.repository.seedStaff({ tenantId: harness.b.id });

      const response = await request(server())
        .get(SCHEDULE_PATH(neighbourStaff.id))
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(response.body.timezone).toBe(OTHER_TENANT_TIMEZONE);
    });

    it('n’accepte pas un fuseau soumis dans le corps', async () => {
      // Le fuseau appartient à l'établissement, pas à la charge utile : le
      // laisser soumettre reviendrait à laisser décaler l'agenda d'un salon.
      await request(server())
        .put(SCHEDULE_PATH(staffId))
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ entries: [], timezone: 'Pacific/Kiritimati' })
        .expect(400);
    });
  });
});
