import request from 'supertest';

import { createPaymentsHarness, type PaymentsHarness } from './payments.harness';
import { expectCrossTenantNotFound, expectNotFoundWithoutLeak } from './utils/tenant-assertions';

/**
 * Isolation inter-tenant du module `payments` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de #57).
 *
 * ## Ce qui se traverse ici, et comment
 *
 * La route de ce module est **publique** : elle ne se désigne pas par un jeton
 * mais par le `:tenantSlug` de son URL, résolu contre la table `tenants` par
 * `TenantScopeMiddleware`. La tentative croisée consiste donc à demander le
 * rendez-vous de A **depuis l'espace public de B** — le geste qu'un curieux
 * ferait en changeant le premier segment de l'URL qu'il a sous les yeux.
 *
 * Le protocole reste celui de tenant-isolation §6 : créer chez A, se présenter
 * comme B, tenter l'opération par identifiant, attendre **404 — jamais 403**,
 * qui confirmerait l'existence de la ressource, et vérifier que la donnée de A
 * est intacte au bout.
 *
 * ## Le cas de référence, et pourquoi il est décisif ici
 *
 * « Inconnu partout » et « connu chez le voisin » doivent produire **la même
 * réponse**. Sans cela, la différence entre les deux sert de sonde : un salon
 * pourrait, en rejouant des identifiants, apprendre lesquels appartiennent à un
 * concurrent. Sur une route de paiement, c'est aussi un moyen de savoir qu'un
 * rendez-vous existe — donc qu'une cliente a réservé — sans jamais rien payer.
 *
 * ## Ce qui ne doit pas partir chez le prestataire non plus
 *
 * L'isolation ne s'arrête pas au corps de la réponse. Une tentative croisée qui
 * répondrait 404 **après** avoir créé une intention chez Stripe laisserait une
 * trace facturable au compte du salon visé. La suite vérifie donc aussi que la
 * passerelle n'a **rien** reçu.
 */

const ROUTE = (slug: string): string => `/api/v1/public/${slug}/payments/intents`;

/** Un identifiant de la bonne forme qui ne désigne rien, nulle part. */
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

describe('Isolation inter-tenant — module payments', () => {
  let harness: PaymentsHarness;

  beforeEach(async () => {
    harness = await createPaymentsHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<PaymentsHarness['server']> => harness.server();

  it('refuse d’ouvrir le paiement du rendez-vous de A depuis l’espace public de B', async () => {
    const appointment = harness.repository.seedAppointment({
      tenantId: harness.tenantId,
      amountMinor: 7000,
    });

    await expectCrossTenantNotFound({
      attempts: [
        {
          label: 'ouverture de paiement croisée',
          send: () =>
            request(server())
              .post(ROUTE(harness.otherTenantSlug))
              .send({ appointmentId: appointment.id }),
        },
      ],
      // Ni l'identifiant du rendez-vous, ni celui de son établissement ne
      // doivent apparaître dans le corps du refus.
      hidden: [appointment.id, harness.tenantId],
      // Pas 4 du protocole : le refus ne suffit pas, encore faut-il qu'aucune
      // ligne n'ait été écrite chez le voisin avant que le 404 ne parte.
      intact: () => harness.repository.allPayments().map((row) => row.id),
    });

    expect(harness.repository.allPayments()).toHaveLength(0);
  });

  it('n’appelle pas le prestataire pour un rendez-vous d’ailleurs', async () => {
    // Une intention créée puis « refusée » laisserait une trace facturable au
    // compte du salon visé, sans qu'aucun corps de réponse ne le montre.
    const appointment = harness.repository.seedAppointment({ tenantId: harness.tenantId });

    await request(server())
      .post(ROUTE(harness.otherTenantSlug))
      .send({ appointmentId: appointment.id })
      .expect(404);

    expect(harness.stripe.commands).toHaveLength(0);
    expect(harness.stripe.retrieved).toHaveLength(0);
  });

  it('rend la même réponse pour « inconnu partout » et « connu chez le voisin »', async () => {
    const appointment = harness.repository.seedAppointment({ tenantId: harness.tenantId });

    const foreign = await request(server())
      .post(ROUTE(harness.otherTenantSlug))
      .send({ appointmentId: appointment.id });
    const unknown = await request(server())
      .post(ROUTE(harness.otherTenantSlug))
      .send({ appointmentId: UNKNOWN_ID });

    expectNotFoundWithoutLeak(foreign, {
      hidden: [appointment.id, harness.tenantId],
      label: 'rendez-vous du voisin',
    });
    expectNotFoundWithoutLeak(unknown, { hidden: [harness.tenantId], label: 'identifiant inconnu' });
    // Indiscernables : c'est ce qui empêche la route de servir de sonde
    // d'existence (tenant-isolation §4).
    expect(foreign.body).toEqual(unknown.body);
  });

  it('ne laisse pas l’encaissement de A être repris depuis l’espace public de B', async () => {
    // Le scénario le plus coûteux : reprendre l'intention d'un autre
    // établissement rendrait son `client_secret`, avec lequel on peut confirmer
    // — ou lire — le paiement d'une cliente qui n'est pas la sienne.
    const appointment = harness.repository.seedAppointment({ tenantId: harness.tenantId });
    const payment = harness.repository.seedPayment({
      tenantId: harness.tenantId,
      appointmentId: appointment.id,
    });

    const response = await request(server())
      .post(ROUTE(harness.otherTenantSlug))
      .send({ appointmentId: appointment.id })
      .expect(404);

    expectNotFoundWithoutLeak(response, {
      hidden: [
        appointment.id,
        payment.id,
        harness.tenantId,
        payment.providerPaymentIntentId ?? 'pi_absent',
      ],
      label: 'reprise croisée',
    });
    expect(harness.stripe.retrieved).toHaveLength(0);
  });

  it('laisse chaque établissement encaisser son propre rendez-vous, sans se voir', async () => {
    // Le complément du protocole : l'isolation ne doit pas être obtenue en
    // refusant tout le monde. Deux établissements paient chacun le leur, et
    // aucune réponse ne porte quoi que ce soit de l'autre.
    const own = harness.repository.seedAppointment({ tenantId: harness.tenantId });
    const neighbour = harness.repository.seedAppointment({ tenantId: harness.otherTenantId });

    const mine = await request(server())
      .post(ROUTE(harness.tenantSlug))
      .send({ appointmentId: own.id })
      .expect(201);
    const theirs = await request(server())
      .post(ROUTE(harness.otherTenantSlug))
      .send({ appointmentId: neighbour.id })
      .expect(201);

    expect(JSON.stringify(mine.body)).not.toContain(neighbour.id);
    expect(JSON.stringify(theirs.body)).not.toContain(own.id);
    expect(mine.body.clientSecret).not.toBe(theirs.body.clientSecret);

    // Chaque ligne porte l'établissement qui l'a demandée, et la clé
    // d'idempotence envoyée à Stripe est distincte par établissement — sans
    // quoi deux salons partageraient une intention, donc un débit.
    const keys = harness.stripe.commands.map((command) => command.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain(harness.tenantId);
    expect(keys[1]).toContain(harness.otherTenantId);
    expect(harness.repository.allPayments().map((row) => row.tenantId).sort()).toEqual(
      [harness.tenantId, harness.otherTenantId].sort(),
    );
  });
});
