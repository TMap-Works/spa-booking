import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  createNotificationTemplatesHarness,
  type NotificationTemplatesHarness,
} from './notification-templates.harness';

/**
 * Isolation inter-tenant des modèles de messages — obligatoire pour tout
 * endpoint nouveau ou **modifié** (tenant-isolation §6, DoD de #69 et de #854).
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
 * Un modèle se désigne par ce qu'il est — un message, un canal, une langue —,
 * jamais par l'identifiant d'une ligne. Il n'y a donc pas de « lecture par id
 * d'une ressource du voisin » à tenter, et le 404 de traversée n'a pas d'objet :
 * le triplet `(type, channel, locale)` existe pour **tous** les établissements.
 * Ce qui se vérifie est ce que chacun y voit.
 *
 * | Ce qui est vérifié | Route |
 * |---|---|
 * | A ne lit pas la personnalisation de B — il retombe sur le défaut | `GET …/:type/:channel/:locale` |
 * | A ne la voit pas non plus dans sa liste, ni nue ni filtrée par langue | `GET …` |
 * | B lit la sienne, sur les mêmes données — la borne symétrique | `GET …/:type/:channel/:locale` |
 * | l'écriture de A ne touche pas la ligne de B | `PUT …/:type/:channel/:locale` |
 * | l'effacement par A ne supprime pas celle de B | `DELETE …/:type/:channel/:locale` |
 * | l'aperçu de A rend son modèle à lui, pas celui de B | `POST …/:type/:channel/:locale/preview` |
 * | sans jeton, les cinq routes refusent | toutes |
 *
 * ## Le scénario délibéré : les deux salons personnalisent le même message
 *
 * Même type, même canal, **même langue**. C'est la configuration où une confusion
 * d'établissement ne se voit **que** dans le contenu — un jeu dissemblable aurait
 * laissé la suite passer en comparant des coordonnées qui, elles, diffèrent.
 *
 * ## La langue est une coordonnée de plus, pas une frontière de moins (#854)
 *
 * L'unique est passé à `(tenant_id, type, channel, locale)`. Le risque que cette
 * dimension ajoute est celui d'un scoping qui n'agirait plus que sur trois
 * membres sur quatre : une lecture du `fr` qui retomberait sur l'`en` du voisin
 * faute de trouver le sien. Deux cas l'éprouvent — l'écriture d'une langue chez A
 * laisse l'**autre** langue de B intacte, et la liste filtrée par langue ne
 * montre pas davantage que la liste nue.
 */

const BASE = '/api/v1/notification-templates';
const CIBLE = `${BASE}/booking_confirmation/email/fr`;
const CIBLE_EN = `${BASE}/booking_confirmation/email/en`;
const APERCU = `${CIBLE}/preview`;

const TEXTE_MAISON = 'Chez nous, le {{date}}.';
const TEXTE_VOISIN = 'Chez le voisin, le {{date}}.';
/** Le marqueur qui survit à la substitution des balises — pour l'aperçu. */
const MARQUEUR_VOISIN = 'Chez le voisin';

interface TemplateBody {
  type: string;
  channel: string;
  locale: string;
  origin: string;
  subject: string;
  text: string;
}

interface PreviewBody {
  locale: string;
  origin: string;
  rendered: { subject: string; html: string; text: string };
}

describe('Isolation inter-tenant — modèles de messages', () => {
  let harness: NotificationTemplatesHarness;

  beforeEach(async () => {
    harness = await createNotificationTemplatesHarness();

    harness.seed({
      tenantId: harness.otherTenantId,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      locale: 'fr',
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
    expect(body.locale).toBe('fr');
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

  it('ne la laisse pas davantage paraître dans la liste filtrée sur sa langue', async () => {
    // Le filtre est la porte la plus étroite de la liste, et c'est justement
    // celle où un scoping qui aurait oublié un membre de la clé se verrait : la
    // langue du voisin est exactement celle qu'on demande.
    const response = await request(server())
      .get(`${BASE}?locale=fr`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as { items: TemplateBody[] };

    expect(JSON.stringify(body)).not.toContain(TEXTE_VOISIN);
    expect(body.items.every((item) => item.locale === 'fr')).toBe(true);
    expect(body.items.every((item) => item.origin === 'platform')).toBe(true);
  });

  it('le voisin voit la sienne — la borne symétrique', async () => {
    // Sans cette assertion, un dépôt qui rendrait toujours le défaut passerait au
    // vert sur les précédentes.
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

  it('l’écriture d’une langue chez le salon laisse l’autre langue du voisin intacte', async () => {
    // La coordonnée ajoutée par #854 : un scoping qui n'agirait que sur trois
    // membres sur quatre écrirait ici la ligne du voisin en croyant créer celle
    // du salon.
    await request(server())
      .put(CIBLE_EN)
      .set('Authorization', await harness.bearer('MANAGER'))
      .send({ subject: 'Our place', html: '<p>At our place.</p>', text: 'At our place.' })
      .expect(200);

    const chezLeVoisin = await request(server())
      .get(CIBLE)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .expect(200);

    expect((chezLeVoisin.body as TemplateBody).origin).toBe('tenant');
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

  it('l’aperçu du salon rend son modèle à lui, jamais celui du voisin', async () => {
    // L'aperçu est la route de #854 qui **rend** un contenu plutôt que de le
    // recopier : sans jeu d'essai, elle aurait pu lire le modèle effectif hors
    // portée sans que les quatre autres cas le voient.
    const response = await request(server())
      .post(APERCU)
      .set('Authorization', await harness.bearer('STAFF'))
      .send({})
      .expect(200);

    const body = response.body as PreviewBody;

    expect(body.origin).toBe('platform');
    expect(body.locale).toBe('fr');
    expect(JSON.stringify(body.rendered)).not.toContain(MARQUEUR_VOISIN);
  });

  it('le voisin, lui, voit le sien dans son aperçu — la borne symétrique', async () => {
    const response = await request(server())
      .post(APERCU)
      .set('Authorization', await harness.bearer('STAFF', harness.otherTenantId))
      .send({})
      .expect(200);

    const body = response.body as PreviewBody;

    expect(body.origin).toBe('tenant');
    expect(body.rendered.text).toContain(MARQUEUR_VOISIN);
  });

  it('refuse les cinq routes sans jeton', async () => {
    await request(server()).get(BASE).expect(401);
    await request(server()).get(CIBLE).expect(401);
    await request(server()).put(CIBLE).send({ text: 'x' }).expect(401);
    await request(server()).delete(CIBLE).expect(401);
    await request(server()).post(APERCU).send({}).expect(401);
  });
});
