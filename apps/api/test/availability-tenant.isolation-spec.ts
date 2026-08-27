import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import {
  createAvailabilityHarness,
  OTHER_TENANT_TIMEZONE,
  type AvailabilityHarness,
} from './availability.harness';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Isolation inter-tenant du module `availability` — obligatoire pour tout
 * endpoint nouveau (tenant-isolation §6, DoD de #32).
 *
 * La suite couvre les **quatre** routes du module, pas un échantillon :
 *
 * | Route | Ce qui est vérifié |
 * |---|---|
 * | `GET /staff/:staffId/schedule` | 404 sur le praticien du voisin, et ses plages restent invisibles |
 * | `PUT /staff/:staffId/schedule` | 404, et la semaine du voisin intacte |
 * | `GET /closing-days` | la liste ne contient aucune fermeture du voisin |
 * | `PUT /closing-days` | l'écriture ici ne touche pas les fermetures du voisin |
 *
 * Le protocole est celui de tenant-isolation §6 : créer chez A, s'authentifier
 * comme B, tenter lecture et modification par identifiant, attendre 404 —
 * **jamais 403**, qui confirmerait l'existence de la ressource — et vérifier que
 * la ressource de A est intacte. La suppression n'existe pas dans ce module :
 * son absence est vérifiée comme le reste, un `PUT` vide en tenant lieu.
 *
 * ## Le cas propre à ce module : le fuseau
 *
 * Une confusion de tenant ne se voit pas seulement sur des identifiants. Les
 * heures rendues par ce module sont **murales** : lues avec le fuseau du voisin,
 * elles désignent d'autres instants sans qu'aucun identifiant ne change. Les
 * deux établissements du harnais sont donc dans deux fuseaux distincts —
 * `Europe/Paris` et `Indian/Antananarivo` —, et la suite vérifie que chacun
 * reçoit le sien.
 *
 * ## Le cas de référence
 *
 * « Inconnu ici » et « connu ailleurs » doivent produire la **même** réponse,
 * faute de quoi la différence sert de sonde d'existence (§4). `UNKNOWN_ID` est
 * là pour cela.
 */

const SCHEDULE_PATH = (staffId: string): string => `/api/v1/staff/${staffId}/schedule`;
const CLOSING_DAYS_PATH = '/api/v1/closing-days';

/** Une semaine de travail quelconque, mais reconnaissable. */
const MONDAY_MORNING = { weekday: 1, startsAt: '09:00', endsAt: '12:00' };

describe('Isolation inter-tenant — module availability', () => {
  let harness: AvailabilityHarness;
  /** Un praticien de l'établissement voisin, avec ses plages et ses fermetures. */
  let neighbourStaffId: string;

  beforeEach(async () => {
    harness = await createAvailabilityHarness();

    neighbourStaffId = harness.repository.seedStaff({ tenantId: harness.b.id }).id;
    harness.repository.seedSchedule({
      tenantId: harness.b.id,
      staffId: neighbourStaffId,
      weekday: 1,
      startMinute: 540,
      endMinute: 720,
    });
    harness.repository.seedClosingDay({ tenantId: harness.b.id, weekday: 3 });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Un porteur de l'établissement A, au rang le plus capable. */
  const asA = async (): Promise<string> => harness.bearer('ADMIN');

  describe('horaires du personnel', () => {
    it('la lecture du praticien du voisin répond 404, pas 403', async () => {
      const response = await request(server())
        .get(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await asA())
        .expect(404);

      // Un 403 confirmerait que ce praticien existe quelque part.
      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(neighbourStaffId);
      expect(JSON.stringify(response.body)).not.toContain(harness.b.id);
    });

    it('rend la même réponse pour un identifiant qui ne désigne rien', async () => {
      // Sans cette égalité, la différence entre les deux réponses serait une
      // sonde d'existence.
      const unknown = await request(server())
        .get(SCHEDULE_PATH(UNKNOWN_ID))
        .set('Authorization', await asA())
        .expect(404);

      const neighbour = await request(server())
        .get(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await asA())
        .expect(404);

      expect(neighbour.body).toEqual(unknown.body);
    });

    it('l’écriture sur le praticien du voisin répond 404 et ne touche à rien', async () => {
      await request(server())
        .put(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await asA())
        .send({ entries: [{ weekday: 6, startsAt: '08:00', endsAt: '09:00' }] })
        .expect(404);

      // La semaine du voisin est intacte, vue de chez lui.
      const untouched = await request(server())
        .get(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(untouched.body.entries).toEqual([MONDAY_MORNING]);
    });

    it('vider une semaine chez soi ne vide pas celle du voisin', async () => {
      const own = harness.repository.seedStaff({ tenantId: harness.a.id }).id;

      await request(server())
        .put(SCHEDULE_PATH(own))
        .set('Authorization', await asA())
        .send({ entries: [] })
        .expect(200);

      const untouched = await request(server())
        .get(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(untouched.body.entries).toEqual([MONDAY_MORNING]);
    });

    it('rend à chacun le fuseau de son établissement', async () => {
      // Une confusion de tenant sur le fuseau ne change aucun identifiant : elle
      // décalerait silencieusement toutes les heures murales rendues.
      const own = harness.repository.seedStaff({ tenantId: harness.a.id }).id;

      const mine = await request(server())
        .get(SCHEDULE_PATH(own))
        .set('Authorization', await asA())
        .expect(200);

      const theirs = await request(server())
        .get(SCHEDULE_PATH(neighbourStaffId))
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(mine.body.timezone).toBe('Europe/Paris');
      expect(theirs.body.timezone).toBe(OTHER_TENANT_TIMEZONE);
    });

    it('n’écrit pas chez le voisin par un tenantId glissé dans le corps', async () => {
      const own = harness.repository.seedStaff({ tenantId: harness.a.id }).id;

      // `forbidNonWhitelisted` refuse le champ avant même que l'extension de
      // scoping n'ait à l'écraser — deux barrières, la première suffit.
      await request(server())
        .put(SCHEDULE_PATH(own))
        .set('Authorization', await asA())
        .send({ entries: [MONDAY_MORNING], tenantId: harness.b.id })
        .expect(400);

      expect(
        harness.repository.schedules.filter((row) => row.tenantId === harness.a.id),
      ).toEqual([]);
    });
  });

  describe('jours de fermeture', () => {
    it('la liste ne laisse voir aucune fermeture du voisin', async () => {
      const response = await request(server())
        .get(CLOSING_DAYS_PATH)
        .set('Authorization', await asA())
        .expect(200);

      expect(response.body).toEqual({ weekdays: [] });
    });

    it('écrire les siennes ne touche pas à celles du voisin', async () => {
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await asA())
        .send({ weekdays: [1] })
        .expect(200);

      const untouched = await request(server())
        .get(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(untouched.body).toEqual({ weekdays: [3] });
    });

    it('rouvrir toute sa semaine ne rouvre pas celle du voisin', async () => {
      // Le `deleteMany` sans `where` du remplacement est celui qui, mal scopé,
      // effacerait les fermetures de tous les établissements.
      await request(server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await asA())
        .send({ weekdays: [] })
        .expect(200);

      const untouched = await request(server())
        .get(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('STAFF', harness.b))
        .expect(200);

      expect(untouched.body).toEqual({ weekdays: [3] });
    });
  });
});
