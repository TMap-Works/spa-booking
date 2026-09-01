import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createAvailabilityHarness, type AvailabilityHarness } from './availability.harness';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Isolation inter-tenant des plages bloquées et congés — la case de Definition
 * of Done laissée décochée sur #302, refermée par #303.
 *
 * Le protocole est celui de tenant-isolation §6, déroulé sur les **cinq**
 * chemins de `/api/v1/staff-time-off` et non sur un échantillon :
 *
 * | Tentative depuis le voisin | Attendu |
 * |---|---|
 * | `GET /staff-time-off/:id` | 404, et rien du tenant A dans le corps |
 * | `PATCH /staff-time-off/:id` | 404, et la ligne de A **intacte** |
 * | `DELETE /staff-time-off/:id` | 404, et la ligne de A toujours là |
 * | `GET /staff-time-off` | liste vide — aucune absence de A |
 * | `POST /staff-time-off` avec le praticien de A | 404 |
 *
 * **404 partout, jamais 403** : un 403 confirmerait l'existence de la ressource,
 * et cette confirmation est exactement l'information à ne pas donner
 * (tenant-isolation §4).
 *
 * ## Le cas propre à ce module : la clé étrangère composite
 *
 * Poser une absence sur le praticien d'un autre établissement est le seul geste
 * de ce module qui puisse écrire une ligne à cheval sur deux tenants. Il est
 * refusé par `(tenant_id, staff_id)` en base — donc par la traduction du code
 * Prisma `P2003` en 404 — et non par un contrôle applicatif qui aurait eu à
 * choisir entre 403 et 404. La suite le vérifie dans les deux sens, parce qu'une
 * asymétrie ici ne serait qu'une fuite qu'on n'a pas cherchée du bon côté.
 *
 * ## Le cas de référence
 *
 * « Inconnu ici » et « connu ailleurs » doivent produire la **même** réponse,
 * faute de quoi la différence sert de sonde d'existence (§4). `UNKNOWN_ID` est
 * là pour cela.
 */

const PATH = '/api/v1/staff-time-off';
const pathOf = (id: string): string => `${PATH}/${id}`;

/** Le congé de référence, posé chez A. */
const STARTS_AT = '2026-08-03T00:00:00Z';
const ENDS_AT = '2026-08-06T00:00:00Z';
const REASON = 'Formation interne';

/**
 * La borne de fin telle que l'API la **rend** — millisecondes comprises.
 *
 * `ToUtcInstant` normalise à la frontière par `Date.toISOString()`, qui écrit
 * toujours les millisecondes. Comparer à la chaîne envoyée ferait échouer
 * l'assertion « intacte » pour une raison qui n'a rien à voir avec l'isolation.
 */
const ENDS_AT_RENDERED = '2026-08-06T00:00:00.000Z';

/** La fenêtre de planning qui le contient. */
const WINDOW = { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' } as const;

describe('Isolation inter-tenant — plages bloquées et congés', () => {
  let harness: AvailabilityHarness;
  /** Un praticien de l'établissement de l'appelant. */
  let staffA: string;
  /** Un praticien de l'établissement voisin. */
  let staffB: string;
  /** L'absence de A, celle que B ne doit ni voir, ni modifier, ni retirer. */
  let timeOffOfA: string;

  beforeEach(async () => {
    harness = await createAvailabilityHarness();

    staffA = harness.timeOff.registerStaff(harness.a.id);
    staffB = harness.timeOff.registerStaff(harness.b.id);

    const created = await request(harness.app.getHttpServer())
      .post(PATH)
      .set('Authorization', await harness.bearer('MANAGER'))
      .send({ staffId: staffA, startsAt: STARTS_AT, endsAt: ENDS_AT, reason: REASON })
      .expect(201);

    timeOffOfA = created.body.id;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Un porteur de l'établissement **voisin**, au rang le plus capable. */
  const asB = async (): Promise<string> => harness.bearer('ADMIN', harness.b);

  /** L'absence de A, telle que A la voit — l'assertion « intacte ». */
  const readAsOwner = async (): Promise<request.Response> =>
    request(server())
      .get(pathOf(timeOffOfA))
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

  describe('lecture par identifiant', () => {
    it('répond 404 au voisin, pas 403', async () => {
      const response = await request(server())
        .get(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('ne laisse filtrer ni l’identifiant visé, ni celui de l’établissement, ni le motif', async () => {
      const response = await request(server())
        .get(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .expect(404);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(harness.a.id);
      expect(body).not.toContain(staffA);
      expect(body).not.toContain(REASON);
    });

    it('rend la même réponse que pour un identifiant qui ne désigne rien', async () => {
      // Sans cette égalité, la différence entre les deux réponses serait une
      // sonde d'existence.
      const unknown = await request(server())
        .get(pathOf(UNKNOWN_ID))
        .set('Authorization', await asB())
        .expect(404);

      const neighbour = await request(server())
        .get(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .expect(404);

      expect(neighbour.body).toEqual(unknown.body);
    });
  });

  describe('modification par identifiant', () => {
    it('répond 404 au voisin et laisse la ligne de A intacte', async () => {
      await request(server())
        .patch(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .send({ reason: 'Détourné', endsAt: '2026-09-30T00:00:00Z' })
        .expect(404);

      const untouched = await readAsOwner();

      expect(untouched.body).toMatchObject({ endsAt: ENDS_AT_RENDERED, reason: REASON });
    });

    it('n’écrit rien du tout — pas même une ligne chez le voisin', async () => {
      await request(server())
        .patch(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .send({ reason: 'Détourné' })
        .expect(404);

      // La seule ligne du magasin est celle de A, inchangée : un `updateMany`
      // mal scopé aurait écrit sans que le 404 ne change.
      const rows = harness.timeOff.snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: harness.a.id, reason: REASON });
    });
  });

  describe('suppression par identifiant', () => {
    it('répond 404 au voisin et laisse la ligne de A en place', async () => {
      await request(server())
        .delete(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .expect(404);

      const untouched = await readAsOwner();

      expect(untouched.body.id).toBe(timeOffOfA);
      expect(harness.timeOff.snapshot()).toHaveLength(1);
    });

    it('rend la même réponse que pour un identifiant qui ne désigne rien', async () => {
      const unknown = await request(server())
        .delete(pathOf(UNKNOWN_ID))
        .set('Authorization', await asB())
        .expect(404);

      const neighbour = await request(server())
        .delete(pathOf(timeOffOfA))
        .set('Authorization', await asB())
        .expect(404);

      expect(neighbour.body).toEqual(unknown.body);
    });
  });

  describe('planning', () => {
    it('la liste du voisin est vide', async () => {
      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await asB())
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('filtrer sur le praticien de A ne rend rien au voisin, et ne refuse pas non plus', async () => {
      // Un 403 sur ce filtre apprendrait que ce praticien existe ailleurs ; une
      // liste vide n'apprend rien.
      const response = await request(server())
        .get(PATH)
        .query({ ...WINDOW, staffId: staffA })
        .set('Authorization', await asB())
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('la liste de A ne contient que ses absences, quand les deux en ont', async () => {
      await request(server())
        .post(PATH)
        .set('Authorization', await asB())
        .send({ staffId: staffB, startsAt: STARTS_AT, endsAt: ENDS_AT })
        .expect(201);

      const response = await request(server())
        .get(PATH)
        .query(WINDOW)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(timeOffOfA);
      expect(JSON.stringify(response.body)).not.toContain(staffB);
    });
  });

  describe('pose sur le praticien du voisin', () => {
    it('répond 404 quand A vise le praticien de B', async () => {
      const response = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: staffB, startsAt: STARTS_AT, endsAt: ENDS_AT })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // Aucune ligne à cheval : le magasin ne porte toujours que celle de A.
      expect(harness.timeOff.snapshot()).toHaveLength(1);
    });

    it('répond 404 quand B vise le praticien de A', async () => {
      // La symétrie n'est pas décorative : une fuite cherchée d'un seul côté est
      // une fuite trouvée une fois sur deux.
      await request(server())
        .post(PATH)
        .set('Authorization', await asB())
        .send({ staffId: staffA, startsAt: STARTS_AT, endsAt: ENDS_AT })
        .expect(404);

      expect(harness.timeOff.snapshot()).toHaveLength(1);
    });

    it('rend la même réponse que pour un praticien qui n’existe nulle part', async () => {
      const unknown = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: UNKNOWN_ID, startsAt: STARTS_AT, endsAt: ENDS_AT })
        .expect(404);

      const neighbour = await request(server())
        .post(PATH)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ staffId: staffB, startsAt: STARTS_AT, endsAt: ENDS_AT })
        .expect(404);

      expect(neighbour.body).toEqual(unknown.body);
    });
  });

  describe('cache de disponibilité', () => {
    it('l’écriture de A ne chasse que les clés de A', async () => {
      // Le préfixe commence par le tenant : c'est ce qui garantit qu'une
      // invalidation d'un établissement ne peut pas toucher le cache d'un autre
      // (tenant-isolation §5).
      harness.cache.entries.set(`avail:${harness.a.id}:s:any:2026-08-04`, '{}');
      harness.cache.entries.set(`avail:${harness.b.id}:s:any:2026-08-04`, '{}');

      await request(server())
        .delete(pathOf(timeOffOfA))
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(204);

      expect(harness.cache.keysOf(harness.a.id)).toEqual([]);
      expect(harness.cache.keysOf(harness.b.id)).toHaveLength(1);
    });
  });
});
