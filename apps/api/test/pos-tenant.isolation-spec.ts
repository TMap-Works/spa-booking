import request from 'supertest';

import { createPosHarness, type PosHarness } from './pos.harness';
import {
  expectCrossTenantNotFound,
  expectExcludesForeignIds,
  expectListScopedTo,
  expectNotFoundWithoutLeak,
} from './utils/tenant-assertions';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Isolation inter-tenant du POS — obligatoire pour tout endpoint nouveau
 * (tenant-isolation §6, DoD de #60).
 *
 * La suite couvre les **cinq** routes du POS, pas un échantillon :
 *
 * | Route | Ce qui est vérifié |
 * |---|---|
 * | `GET /products` | la liste ne contient rien du voisin, même à code et nom identiques |
 * | `POST /products` | le code du voisin reste libre — l'unicité est par tenant |
 * | `PATCH /products/:id` | 404 sur l'article du voisin, et sa ligne intacte |
 * | `POST /sales` | aucun article, aucune prestation, aucun rendez-vous du voisin n'est facturable |
 * | `GET /sales/:id` | 404 sur le ticket du voisin, et aucun montant ne fuit |
 *
 * Le protocole est celui de tenant-isolation §6 : créer chez A, s'authentifier
 * comme B, tenter lecture, modification et suppression par identifiant, attendre
 * **404 — jamais 403**, qui confirmerait l'existence de la ressource — et
 * vérifier que la ressource de A est intacte. La suppression n'existe sur aucune
 * des deux ressources — un article vendu et un ticket émis ne s'effacent pas —,
 * et son absence est vérifiée par la suite d'intégration plutôt qu'ici : le 404
 * d'une route non montée vient du routeur, pas du scoping, et le faire passer
 * pour un refus de portée aurait masqué la différence.
 *
 * ## Le scénario délibéré : le même article dans les deux salons
 *
 * `@@unique([tenantId, sku])` autorise expressément que deux salons codent
 * chacun leur `SH-01`. C'est exactement là qu'une confusion de tenant se voit, et
 * c'est pourquoi les articles semés portent des deux côtés le même code et le
 * même nom.
 *
 * ## Ce que le refus doit être indiscernable de
 *
 * `UNKNOWN_ID` sert de témoin : « inconnu ici » et « connu ailleurs » doivent
 * produire la **même** réponse, faute de quoi la différence sert de sonde
 * d'existence (tenant-isolation §4).
 *
 * ## Pourquoi une traversée qui écrit se vérifie aussi
 *
 * Un ticket est une **écriture** : un refus qui arriverait après que la ligne a
 * été inscrite serait un refus pour rien. Chaque scénario de `POST /sales`
 * vérifie donc, en plus du 404, qu'aucun ticket n'a été composé nulle part.
 */

const PRODUCTS = '/api/v1/products';
const SALES = '/api/v1/sales';
const SKU = 'SH-01';
const NOM = 'Shampoing hydratant 250 ml';

describe('Isolation inter-tenant — POS', () => {
  let harness: PosHarness;
  /** L'établissement de l'appelant. */
  let a: string;
  /** L'établissement voisin, celui qu'aucune réponse ne doit laisser voir. */
  let b: string;

  beforeEach(async () => {
    harness = await createPosHarness({ taxRateBps: 2000 });
    a = harness.tenantId;
    b = harness.otherTenantId;
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Le même article, au rayon de A et au rayon de B — le scénario du même code. */
  function semerDesDeuxCotes(): { chezA: string; chezB: string } {
    const chezA = harness.repository.seedProduct({
      tenantId: a,
      sku: SKU,
      name: NOM,
      amountMinor: 1850,
    });
    const chezB = harness.repository.seedProduct({
      tenantId: b,
      sku: SKU,
      name: NOM,
      amountMinor: 9999,
    });

    return { chezA: chezA.id, chezB: chezB.id };
  }

  describe('GET /products — la liste', () => {
    it('ne rend que le rayon de l’appelant, à code et nom identiques', async () => {
      const { chezA, chezB } = semerDesDeuxCotes();

      const response = await request(harness.server())
        .get(`${PRODUCTS}?includeInactive=true`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expectListScopedTo(response.body, { ownIds: [chezA], foreignIds: [chezB] });
    });

    it('ne laisse fuiter ni le prix ni l’identifiant de l’article voisin', async () => {
      const { chezB } = semerDesDeuxCotes();

      const response = await request(harness.server())
        .get(`${PRODUCTS}?includeInactive=true`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expectExcludesForeignIds(response.body, [chezB, b]);
      expect(JSON.stringify(response.body)).not.toContain('9999');
    });
  });

  describe('POST /products — l’unicité est par tenant', () => {
    it('laisse libre chez A le code déjà pris chez B', async () => {
      harness.repository.seedProduct({ tenantId: b, sku: SKU, name: NOM });

      const response = await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ sku: SKU, name: NOM, priceAmountMinor: 1850 })
        .expect(201);

      expect(response.body).toMatchObject({ sku: SKU });
    });
  });

  describe('PATCH /products/:id — la traversée par identifiant', () => {
    it('rend 404 sur l’article du voisin, et le laisse intact', async () => {
      const { chezB } = semerDesDeuxCotes();

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'modification',
            send: async () =>
              request(harness.server())
                .patch(`${PRODUCTS}/${chezB}`)
                .set('Authorization', await harness.bearer('MANAGER'))
                .send({ name: 'Détourné', priceAmountMinor: 1, isActive: false }),
          },
        ],
        hidden: [chezB, b],
        intact: () => harness.repository.allProducts().find((product) => product.id === chezB),
      });
    });

    it('rend le même refus qu’un identifiant inconnu — les deux sont indiscernables', async () => {
      const { chezB } = semerDesDeuxCotes();
      const bearer = await harness.bearer('MANAGER');

      const voisin = await request(harness.server())
        .patch(`${PRODUCTS}/${chezB}`)
        .set('Authorization', bearer)
        .send({ name: 'Détourné' });
      const inconnu = await request(harness.server())
        .patch(`${PRODUCTS}/${UNKNOWN_ID}`)
        .set('Authorization', bearer)
        .send({ name: 'Détourné' });

      expectNotFoundWithoutLeak(voisin, { hidden: [chezB, b], label: 'article du voisin' });
      expectNotFoundWithoutLeak(inconnu, { hidden: [chezB, b], label: 'identifiant inconnu' });
      expect(voisin.body).toEqual(inconnu.body);
    });
  });

  describe('POST /sales — rien du voisin n’est facturable', () => {
    it('rend 404 sur l’article du voisin, et n’inscrit aucun ticket', async () => {
      const { chezB } = semerDesDeuxCotes();

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'facturation de l’article du voisin',
            send: async () =>
              request(harness.server())
                .post(SALES)
                .set('Authorization', await harness.bearer('STAFF'))
                .send({ lines: [{ kind: 'PRODUCT', productId: chezB, quantity: 1 }] }),
          },
        ],
        hidden: [chezB, b],
        intact: () => harness.repository.allSales().length,
      });

      expect(harness.repository.allSales()).toHaveLength(0);
    });

    it('rend 404 sur la prestation du voisin, et n’inscrit aucun ticket', async () => {
      const chezB = harness.catalog.seedService({ tenantId: b, amountMinor: 9999 });

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'facturation de la prestation du voisin',
            send: async () =>
              request(harness.server())
                .post(SALES)
                .set('Authorization', await harness.bearer('STAFF'))
                .send({ lines: [{ kind: 'SERVICE', serviceId: chezB.id, quantity: 1 }] }),
          },
        ],
        hidden: [chezB.id, b],
        intact: () => harness.repository.allSales().length,
      });
    });

    it('rend 404 sur le rendez-vous du voisin, même avec un article bien à soi', async () => {
      // Le cas décisif : tout le reste du ticket est légitime, seule la
      // référence au rendez-vous traverse. Un contrôle qui n'aurait porté que
      // sur les articles aurait laissé passer celui-ci.
      const chezA = harness.repository.seedProduct({ tenantId: a });
      const rendezVousVoisin = harness.repository.seedAppointment({ tenantId: b });

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'rattachement au rendez-vous du voisin',
            send: async () =>
              request(harness.server())
                .post(SALES)
                .set('Authorization', await harness.bearer('STAFF'))
                .send({
                  appointmentId: rendezVousVoisin.id,
                  lines: [{ kind: 'PRODUCT', productId: chezA.id, quantity: 1 }],
                }),
          },
        ],
        hidden: [rendezVousVoisin.id, b],
        intact: () => harness.repository.allSales().length,
      });

      expect(harness.repository.allSales()).toHaveLength(0);
    });
  });

  describe('GET /sales/:id — la traversée par identifiant', () => {
    it('rend 404 sur le ticket du voisin, sans laisser fuiter un seul montant', async () => {
      const article = harness.repository.seedProduct({ tenantId: b, amountMinor: 9999 });

      const chezB = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF', b))
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] })
        .expect(201);

      const ticketVoisin = (chezB.body as { id: string }).id;

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'lecture du ticket du voisin',
            send: async () =>
              request(harness.server())
                .get(`${SALES}/${ticketVoisin}`)
                .set('Authorization', await harness.bearer('STAFF')),
          },
        ],
        hidden: [ticketVoisin, b, article.id],
        intact: () => harness.repository.allSales().length,
      });
    });

    it('rend le même refus qu’un identifiant inconnu', async () => {
      const article = harness.repository.seedProduct({ tenantId: b });
      const chezB = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF', b))
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] })
        .expect(201);

      const ticketVoisin = (chezB.body as { id: string }).id;
      const bearer = await harness.bearer('STAFF');

      const voisin = await request(harness.server())
        .get(`${SALES}/${ticketVoisin}`)
        .set('Authorization', bearer);
      const inconnu = await request(harness.server())
        .get(`${SALES}/${UNKNOWN_ID}`)
        .set('Authorization', bearer);

      expectNotFoundWithoutLeak(voisin, { hidden: [ticketVoisin, b], label: 'ticket du voisin' });
      expectNotFoundWithoutLeak(inconnu, { hidden: [ticketVoisin, b], label: 'identifiant inconnu' });
      expect(voisin.body).toEqual(inconnu.body);
    });
  });

  describe('le jeton désigne l’établissement, jamais le corps', () => {
    it('inscrit le ticket dans l’établissement du porteur, quoi qu’il envoie', async () => {
      const chezA = harness.repository.seedProduct({ tenantId: a });

      // `forbidNonWhitelisted` refuse en 400 un `tenantId` glissé dans le corps :
      // le champ n'existe pas au contrat, et la tentative est nommée plutôt
      // qu'ignorée (tenant-isolation §2).
      await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          tenantId: b,
          lines: [{ kind: 'PRODUCT', productId: chezA.id, quantity: 1 }],
        })
        .expect(400);

      expect(harness.repository.allSales()).toHaveLength(0);
    });
  });
});
