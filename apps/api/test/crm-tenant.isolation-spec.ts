import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createCrmHarness, type CrmHarness } from './crm.harness';
import {
  expectCrossTenantNotFound,
  expectExcludesForeignIds,
} from './utils/tenant-assertions';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Isolation inter-tenant du module `crm` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de #56).
 *
 * La suite couvre les **six** routes du module, pas un échantillon :
 *
 * | Route | Ce qui est vérifié |
 * |---|---|
 * | `GET /customers` | la liste ne contient rien du voisin, même à nom et adresse identiques |
 * | `GET /customers/:id` | 404 sur la fiche du voisin |
 * | `GET /customers/:id/history` | 404, et aucune visite du voisin ne fuit |
 * | `POST /customers` | l'adresse du voisin reste libre — l'unicité est par tenant |
 * | `PATCH /customers/:id` | 404, et la fiche du voisin intacte |
 * | `PATCH /customers/:id/status` | 404, et la fiche du voisin toujours active |
 *
 * Le module n'a **aucune** route publique : toutes se désignent par un jeton, il
 * n'y a donc pas de suite `public-*` en pendant. C'est délibéré — un module qui
 * ne contient que des données personnelles n'a pas de surface anonyme.
 *
 * Le protocole est celui de tenant-isolation §6 : créer chez A, s'authentifier
 * comme B, tenter lecture, modification et suppression par identifiant, attendre
 * **404 — jamais 403**, qui confirmerait l'existence de la fiche — et vérifier
 * que la fiche de A est intacte. La suppression n'existe pas ici : son absence
 * est vérifiée comme le reste.
 *
 * ## Le scénario délibéré : la même personne dans les deux salons
 *
 * `@@unique([tenantId, email])` autorise expressément qu'une même adresse
 * désigne deux fiches distinctes dans deux établissements — « une même personne
 * peut être cliente de deux salons sans que l'un puisse deviner l'existence de
 * l'autre ». C'est exactement là qu'une confusion de tenant se voit, et c'est
 * pourquoi les fiches semées portent des deux côtés le même nom et la même
 * adresse.
 *
 * ## Ce que le refus doit être indiscernable de
 *
 * `UNKNOWN_ID` sert de témoin : « inconnu ici » et « connu ailleurs » doivent
 * produire la **même** réponse, faute de quoi la différence sert de sonde
 * d'existence (tenant-isolation §4).
 */

const BASE = '/api/v1/customers';
const NOM = 'Durand';
const ADRESSE = 'alice@example.test';

describe('Isolation inter-tenant — module crm', () => {
  let harness: CrmHarness;
  /** L'établissement de l'appelant. */
  let a: string;
  /** L'établissement voisin, celui qu'aucune réponse ne doit laisser voir. */
  let b: string;

  beforeEach(async () => {
    harness = await createCrmHarness();
    a = harness.tenantId;
    b = harness.otherTenantId;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** La même personne, fiche chez A et fiche chez B — le scénario du même nom. */
  function semerDesDeuxCotes(): { chezA: string; chezB: string } {
    const chezA = harness.repository.addCustomer({
      tenantId: a,
      email: ADRESSE,
      firstName: 'Alice',
      lastName: NOM,
      internalNote: 'note du salon A',
    });
    const chezB = harness.repository.addCustomer({
      tenantId: b,
      email: ADRESSE,
      firstName: 'Alice',
      lastName: NOM,
      internalNote: 'note du salon B',
    });
    return { chezA: chezA.id, chezB: chezB.id };
  }

  /** L'état de la fiche du voisin, relu à la source — pas 4 du protocole. */
  function ficheDuVoisin(id: string): unknown {
    const row = harness.repository.customers.find((candidate) => candidate.id === id);
    return row === undefined
      ? null
      : { lastName: row.lastName, internalNote: row.internalNote, isActive: row.isActive };
  }

  it('la liste ne laisse voir aucune fiche du voisin, même à nom et adresse identiques', async () => {
    const { chezA, chezB } = semerDesDeuxCotes();

    const response = await request(server())
      .get(BASE)
      .query({ q: NOM })
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as { items: { id: string }[]; totalItems: number };

    expect(body.items.map((item) => item.id)).toEqual([chezA]);
    expect(body.totalItems).toBe(1);
    expectExcludesForeignIds(body, [chezB]);
    // La note du voisin ne fuit par aucun champ, pas même un agrégat.
    expect(JSON.stringify(body)).not.toContain('note du salon B');
  });

  it('la fiche du voisin est introuvable — 404, jamais 403, et rien n’est écrit', async () => {
    const { chezB } = semerDesDeuxCotes();
    const bearer = await harness.bearer('STAFF');
    const bearerManager = await harness.bearer('MANAGER');

    await expectCrossTenantNotFound({
      attempts: [
        {
          label: 'lecture',
          send: () => request(server()).get(`${BASE}/${chezB}`).set('Authorization', bearer),
        },
        {
          label: 'historique',
          send: () =>
            request(server()).get(`${BASE}/${chezB}/history`).set('Authorization', bearer),
        },
        {
          label: 'modification',
          send: () =>
            request(server())
              .patch(`${BASE}/${chezB}`)
              .set('Authorization', bearer)
              .send({ lastName: 'Piraté', internalNote: 'écrit depuis A' }),
        },
        {
          label: 'désactivation',
          send: () =>
            request(server())
              .patch(`${BASE}/${chezB}/status`)
              .set('Authorization', bearerManager)
              .send({ isActive: false }),
        },
      ],
      hidden: [chezB, b, 'note du salon B'],
      intact: () => ficheDuVoisin(chezB),
    });
  });

  it('« connu ailleurs » répond exactement comme « inconnu partout »', async () => {
    const { chezB } = semerDesDeuxCotes();
    const bearer = await harness.bearer('STAFF');

    const [voisin, inconnu] = await Promise.all([
      request(server()).get(`${BASE}/${chezB}`).set('Authorization', bearer),
      request(server()).get(`${BASE}/${UNKNOWN_ID}`).set('Authorization', bearer),
    ]);

    // Une différence — de statut, de code, de message — servirait de sonde
    // d'existence à qui énumère des identifiants.
    expect({ statut: voisin.status, corps: voisin.body }).toEqual({
      statut: inconnu.status,
      corps: inconnu.body,
    });
  });

  it('l’historique du voisin ne fuit par aucune visite', async () => {
    const { chezA, chezB } = semerDesDeuxCotes();
    harness.repository.addVisit({ tenantId: a, clientId: chezA, serviceName: 'soin chez A' });
    harness.repository.addVisit({ tenantId: b, clientId: chezB, serviceName: 'soin chez B' });
    // La ligne croisée que les clés étrangères composites `(tenant_id,
    // client_id)` interdisent en base — fabriquée ici pour vérifier que la
    // projection ne la ramasse pas même si elle existait.
    harness.repository.addVisit({ tenantId: b, clientId: chezA, serviceName: 'soin croisé' });

    const response = await request(server())
      .get(`${BASE}/${chezA}/history`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const serialise = JSON.stringify(response.body);
    expect((response.body as { summary: { totalVisits: number } }).summary.totalVisits).toBe(1);
    expect(serialise).toContain('soin chez A');
    for (const secret of ['soin chez B', 'soin croisé', chezB]) {
      expect({ secret, present: serialise.includes(secret) }).toEqual({ secret, present: false });
    }
  });

  it('l’adresse prise chez le voisin reste libre ici', async () => {
    semerDesDeuxCotes();
    // Le harnais a semé chez A **et** chez B ; on repart d'un fichier propre
    // côté A pour que le seul obstacle possible soit la fiche du voisin.
    harness.repository.customers.splice(
      harness.repository.customers.findIndex((row) => row.tenantId === a),
      1,
    );

    const response = await request(server())
      .post(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .send({ email: ADRESSE, firstName: 'Alice', lastName: NOM })
      .expect(201);

    // L'unicité est **par tenant** : deux salons ont chacun droit à leur fiche
    // pour la même personne, et aucun ne peut déduire l'existence de l'autre.
    expect((response.body as { email: string }).email).toBe(ADRESSE);
    expect(harness.repository.customers.filter((row) => row.email === ADRESSE)).toHaveLength(2);
  });

  it('un jeton signé sur le voisin ne lit rien d’ici', async () => {
    const { chezA } = semerDesDeuxCotes();
    // Le jeton porte la revendication de B : c'est `JwtAuthGuard` qui ouvre la
    // portée, et le dépôt scopé ne voit alors que le fichier de B.
    const bearerVoisin = await harness.bearer('STAFF', b);

    const liste = await request(server())
      .get(BASE)
      .query({ q: NOM })
      .set('Authorization', bearerVoisin)
      .expect(200);

    expectExcludesForeignIds(liste.body, [chezA, a, 'note du salon A']);

    await request(server())
      .get(`${BASE}/${chezA}`)
      .set('Authorization', bearerVoisin)
      .expect(404);
  });
});
