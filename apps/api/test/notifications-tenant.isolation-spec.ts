import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { expectExcludesForeignIds } from './utils/tenant-assertions';
import { createNotificationsHarness, type NotificationsHarness } from './notifications.harness';

/**
 * Isolation inter-tenant du module `notifications` — obligatoire pour tout
 * endpoint nouveau (tenant-isolation §6, DoD de #70).
 *
 * ## Le protocole, adapté à une route sans identifiant en chemin
 *
 * `GET /notifications` ne prend aucun identifiant de ressource : il n'y a donc
 * pas de lecture par id à tenter, et pas de 404 de traversée à écrire. Ce qui
 * pourrait fuir ici n'est pas une ressource nommée, c'est une **ligne de
 * journal** — la trace qu'un message est parti pour une cliente du salon
 * voisin.
 *
 * Le protocole se joue donc sur la liste et sur son filtre :
 *
 * | Ce qui est vérifié |
 * |---|
 * | la liste de A ne contient aucune trace de B |
 * | le filtre `appointmentId` **du voisin** rend une liste vide, jamais ses traces |
 * | un jeton de B ne voit que B, sur les mêmes données |
 * | sans jeton, la route refuse |
 *
 * Le troisième point est le plus important, et c'est celui qu'une suite écrite
 * à la légère oublie : vérifier que A ne voit pas B ne prouve rien si B ne voit
 * rien non plus — un dépôt cassé qui rendrait toujours vide passerait au vert.
 *
 * ## Le scénario délibéré : les deux salons ont exactement le même envoi
 *
 * Même type, même canal, même statut, même instant. C'est la configuration où
 * une confusion d'établissement ne se voit **que** dans les identifiants — un
 * jeu dissemblable aurait laissé la suite passer en comparant des statuts qui,
 * eux, diffèrent.
 */

const BASE = '/api/v1/notifications';

/** Le rendez-vous du voisin — celui qu'aucune réponse de A ne doit servir. */
const RDV_VOISIN = '99999999-9999-4999-8999-999999999999';
const RDV_MAISON = '11111111-1111-4111-8111-111111111111';

const TRACE_MAISON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRACE_VOISIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface ListBody {
  items: { id: string; appointmentId?: string }[];
}

describe('Isolation inter-tenant — module notifications', () => {
  let harness: NotificationsHarness;

  beforeEach(async () => {
    harness = await createNotificationsHarness();

    // Le même envoi des deux côtés : seuls les identifiants diffèrent.
    const commun = {
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      status: 'SENT',
      createdAt: new Date('2026-09-06T08:00:00Z'),
      sentAt: new Date('2026-09-06T08:00:01Z'),
    } as const;

    harness.seed({
      ...commun,
      tenantId: harness.tenantId,
      id: TRACE_MAISON,
      appointmentId: RDV_MAISON,
    });
    harness.seed({
      ...commun,
      tenantId: harness.otherTenantId,
      id: TRACE_VOISIN,
      appointmentId: RDV_VOISIN,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  it('la liste ne porte que les envois de l’établissement du jeton', async () => {
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items.map((item) => item.id)).toEqual([TRACE_MAISON]);
    expectExcludesForeignIds(body, [TRACE_VOISIN, RDV_VOISIN]);
  });

  it('le rendez-vous du voisin rend une liste vide, jamais ses traces', async () => {
    // Une liste vide et non un 404 : ce module n'a rien à dire de l'existence
    // d'un rendez-vous, et prétendre le contraire lui ferait lire `appointments`.
    // Ce qui compte est que la trace du voisin ne sorte pas.
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV_VOISIN}`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toEqual([]);
    expectExcludesForeignIds(body, [TRACE_VOISIN]);
  });

  it('le voisin voit les siennes — la borne symétrique', async () => {
    // Sans cette assertion, un dépôt qui rendrait toujours vide passerait au
    // vert sur les deux précédentes.
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items.map((item) => item.id)).toEqual([TRACE_VOISIN]);
    expectExcludesForeignIds(body, [TRACE_MAISON, RDV_MAISON]);
  });

  it('sans jeton, la route refuse — 401 et rien du journal', async () => {
    const response = await request(server()).get(BASE).expect(401);

    expect(JSON.stringify(response.body)).not.toContain(TRACE_MAISON);
  });

  it('un rôle sous le seuil est refusé en 403', async () => {
    // `CLIENT` n'a rien à faire dans le journal d'un salon : ce qu'elle a reçu,
    // elle l'a reçu, et un statut technique ne le lui apprendrait pas.
    await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('CLIENT'))
      .expect(403);
  });

  it('un `tenantId` glissé dans la requête est rejeté, pas honoré', async () => {
    // `forbidNonWhitelisted` : le champ n'est pas déclaré au DTO, donc la
    // requête tombe en 400. C'est le scénario de fuite le plus direct
    // (tenant-isolation §2).
    await request(server())
      .get(`${BASE}?tenantId=${harness.otherTenantId}`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(400);
  });
});
