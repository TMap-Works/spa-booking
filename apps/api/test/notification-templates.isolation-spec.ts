import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  createNotificationTemplatesHarness,
  type NotificationTemplatesHarness,
} from './notification-templates.harness';

/**
 * Isolation inter-tenant des modèles de messages — obligatoire pour tout
 * endpoint nouveau (tenant-isolation §6, DoD de #69).
 *
 * ## Ce qui pourrait fuir ici, et pourquoi c'est grave
 *
 * Pas un identifiant : un **contenu**. Cette table décide de ce que reçoivent les
 * clientes de chaque salon. Une lecture qui traverserait la frontière servirait
 * au voisin le texte qu'un concurrent a écrit ; une écriture qui la traverserait
 * réécrirait ses messages, et il l'apprendrait par ses clientes.
 *
 * ## Le protocole, adapté à une ressource sans identifiant en chemin
 *
 * Un modèle se désigne par ce qu'il est — un message, un canal —, jamais par
 * l'identifiant d'une ligne. Il n'y a donc pas de « lecture par id d'une
 * ressource du voisin » à tenter, et le 404 de traversée n'a pas d'objet : le
 * couple `(type, channel)` existe pour **tous** les établissements. Ce qui se
 * vérifie est ce que chacun y voit.
 *
 * | Ce qui est vérifié |
 * |---|
 * | A ne lit pas la personnalisation de B — il retombe sur le défaut |
 * | B lit la sienne, sur les mêmes données — la borne symétrique |
 * | l'écriture de A ne touche pas la ligne de B |
 * | l'effacement par A ne supprime pas celle de B |
 * | sans jeton, les quatre routes refusent |
 *
 * ## Le scénario délibéré : les deux salons personnalisent le même message
 *
 * Même type, même canal. C'est la configuration où une confusion
 * d'établissement ne se voit **que** dans le contenu — un jeu dissemblable aurait
 * laissé la suite passer en comparant des couples qui, eux, diffèrent.
 */

const BASE = '/api/v1/notification-templates';
const CIBLE = `${BASE}/booking_confirmation/email`;

const TEXTE_MAISON = 'Chez nous, le {{date}}.';
const TEXTE_VOISIN = 'Chez le voisin, le {{date}}.';

interface TemplateBody {
  origin: string;
  subject: string;
  text: string;
}

describe('Isolation inter-tenant — modèles de messages', () => {
  let harness: NotificationTemplatesHarness;

  beforeEach(async () => {
    harness = await createNotificationTemplatesHarness();

    harness.seed({
      tenantId: harness.otherTenantId,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: { subject: 'Objet du voisin', html: `<p>${TEXTE_VOISIN}</p>`, text: TEXTE_VOISIN },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  it('ne sert pas au salon la personnalisation du voisin', async () => {
    const response = await request(server())
      .get(CIBLE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as TemplateBody;

    expect(body.origin).toBe('platform');
    expect(body.text).not.toContain(TEXTE_VOISIN);
    expect(body.subject).not.toBe('Objet du voisin');
  });

  it('ne la laisse pas non plus paraître dans la liste', async () => {
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain(TEXTE_VOISIN);
  });

  it('le voisin voit la sienne — la borne symétrique', async () => {
    // Sans cette assertion, un dépôt qui rendrait toujours le défaut passerait au
    // vert sur les deux précédentes.
    const response = await request(server())
      .get(CIBLE)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .expect(200);

    const body = response.body as TemplateBody;

    expect(body.origin).toBe('tenant');
    expect(body.text).toBe(TEXTE_VOISIN);
  });

  it('l’écriture du salon ne touche pas le modèle du voisin', async () => {
    await request(server())
      .put(CIBLE)
      .set('Authorization', await harness.bearer('MANAGER'))
      .send({ subject: 'Objet maison', html: `<p>${TEXTE_MAISON}</p>`, text: TEXTE_MAISON })
      .expect(200);

    const chezLeVoisin = await request(server())
      .get(CIBLE)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .expect(200);

    expect((chezLeVoisin.body as TemplateBody).text).toBe(TEXTE_VOISIN);
  });

  it('l’effacement par le salon ne supprime pas celui du voisin', async () => {
    await request(server())
      .delete(CIBLE)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);

    const chezLeVoisin = await request(server())
      .get(CIBLE)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .expect(200);

    expect((chezLeVoisin.body as TemplateBody).origin).toBe('tenant');
  });

  it('refuse les quatre routes sans jeton', async () => {
    await request(server()).get(BASE).expect(401);
    await request(server()).get(CIBLE).expect(401);
    await request(server()).put(CIBLE).send({ text: 'x' }).expect(401);
    await request(server()).delete(CIBLE).expect(401);
  });
});
