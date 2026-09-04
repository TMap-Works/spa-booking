import { HANDLED_EVENT_TYPES, readWebhookEvent } from '../stripe-webhook.types';

/**
 * La lecture d'un corps Stripe — et ce qu'elle refuse de lire.
 *
 * Deux propriétés y sont éprouvées, dans cet ordre d'importance :
 *
 * 1. **rien de ce qui ressemble à une donnée de carte ne survit à la lecture** ;
 * 2. un corps hors périmètre, ou incomplet, est *acquitté* et non traité — un
 *    refus ferait rejouer indéfiniment un événement dont le rejeu ne changerait
 *    rien.
 */

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function stripeEvent(type: string, object: Record<string, unknown>, id = 'evt_1'): Buffer {
  return body({ id, type, data: { object } });
}

describe('readWebhookEvent — périmètre', () => {
  it('déclare exactement les quatre événements du MVP', () => {
    // La liste est celle de payments-stripe §3. L'y comparer ici évite qu'un
    // cinquième type s'y glisse sans décision.
    expect([...HANDLED_EVENT_TYPES]).toEqual([
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'charge.refunded',
      'charge.dispute.created',
    ]);
  });

  it('acquitte sans traiter un type hors périmètre', () => {
    expect(readWebhookEvent(stripeEvent('customer.created', { id: 'cus_1' }))).toEqual({
      status: 'ignored',
      eventId: 'evt_1',
      eventType: 'customer.created',
    });
  });

  it('déclare illisible ce qui n’est pas un événement', () => {
    expect(readWebhookEvent(Buffer.from('pas du json'))).toEqual({ status: 'unreadable' });
    expect(readWebhookEvent(body([1, 2, 3]))).toEqual({ status: 'unreadable' });
    expect(readWebhookEvent(body({ type: 'payment_intent.succeeded' }))).toEqual({
      status: 'unreadable',
    });
    expect(readWebhookEvent(body({ id: 'evt_1' }))).toEqual({ status: 'unreadable' });
  });
});

describe('readWebhookEvent — payment_intent.succeeded', () => {
  it('rend l’intention, la charge et le tenant annoncé', () => {
    const outcome = readWebhookEvent(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_1',
        latest_charge: 'ch_1',
        metadata: { tenantId: 'tenant-a', appointmentId: 'rdv-1' },
      }),
    );

    expect(outcome).toEqual({
      status: 'handled',
      event: {
        eventId: 'evt_1',
        eventType: 'payment_intent.succeeded',
        tenantHint: 'tenant-a',
        fact: { kind: 'payment-succeeded', paymentIntentId: 'pi_1', chargeId: 'ch_1' },
      },
    });
  });

  it('accepte une référence développée aussi bien qu’une chaîne', () => {
    const outcome = readWebhookEvent(
      stripeEvent('payment_intent.succeeded', { id: 'pi_1', latest_charge: { id: 'ch_1' } }),
    );

    expect(outcome).toMatchObject({
      event: { fact: { chargeId: 'ch_1' }, tenantHint: null },
    });
  });

  it('ne recopie aucune donnée de carte, même quand Stripe en envoie', () => {
    // Le corps réel de Stripe porte `payment_method_details.card.last4`,
    // `brand`, `exp_month`. La garantie n'est pas qu'on les efface : c'est
    // qu'il n'existe nulle part où les mettre.
    const outcome = readWebhookEvent(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_1',
        latest_charge: 'ch_1',
        payment_method_details: { card: { last4: '4242', brand: 'visa', exp_month: 12 } },
        charges: { data: [{ payment_method_details: { card: { last4: '4242' } } }] },
      }),
    );

    expect(JSON.stringify(outcome)).not.toMatch(/4242|visa|exp_month|last4/i);
  });

  it('ignore une intention sans identifiant', () => {
    expect(readWebhookEvent(stripeEvent('payment_intent.succeeded', {}))).toMatchObject({
      status: 'ignored',
    });
  });
});

describe('readWebhookEvent — payment_intent.payment_failed', () => {
  it('rend l’intention concernée', () => {
    expect(
      readWebhookEvent(stripeEvent('payment_intent.payment_failed', { id: 'pi_2' })),
    ).toMatchObject({
      status: 'handled',
      event: { fact: { kind: 'payment-failed', paymentIntentId: 'pi_2' } },
    });
  });
});

describe('readWebhookEvent — charge.refunded', () => {
  it('conclut au remboursement total quand tout le capturé est rendu', () => {
    expect(
      readWebhookEvent(
        stripeEvent('charge.refunded', {
          id: 'ch_1',
          payment_intent: 'pi_1',
          amount_captured: 5000,
          amount_refunded: 5000,
        }),
      ),
    ).toMatchObject({
      event: {
        fact: {
          kind: 'charge-refunded',
          paymentIntentId: 'pi_1',
          chargeId: 'ch_1',
          refundedAmountMinor: 5000,
          fullyRefunded: true,
        },
      },
    });
  });

  it('conclut au remboursement partiel en dessous', () => {
    expect(
      readWebhookEvent(
        stripeEvent('charge.refunded', {
          id: 'ch_1',
          payment_intent: 'pi_1',
          amount_captured: 5000,
          amount_refunded: 1500,
        }),
      ),
    ).toMatchObject({ event: { fact: { refundedAmountMinor: 1500, fullyRefunded: false } } });
  });

  it('reste prudent quand le montant capturé n’est pas lisible', () => {
    // `PARTIALLY_REFUNDED` n'interdit aucune suite ; conclure au total sur une
    // donnée manquante fermerait le dossier à tort.
    expect(
      readWebhookEvent(
        stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 5000 }),
      ),
    ).toMatchObject({ event: { fact: { fullyRefunded: false } } });
  });

  it('refuse un montant qui n’est pas un entier positif', () => {
    // Un flottant ici entrerait dans un calcul d'argent, ce que les règles de
    // code interdisent — et signale surtout un champ mal lu.
    for (const amount of [12.5, -100, '5000', null]) {
      expect(
        readWebhookEvent(
          stripeEvent('charge.refunded', {
            id: 'ch_1',
            payment_intent: 'pi_1',
            amount_refunded: amount,
          }),
        ),
      ).toMatchObject({ status: 'ignored' });
    }
  });

  it('ignore un remboursement sans intention rattachée', () => {
    // Un encaissement fait à la main dans le tableau de bord Stripe : il n'est
    // passé par aucun de nos tunnels, il n'y a rien à mettre à jour.
    expect(
      readWebhookEvent(stripeEvent('charge.refunded', { id: 'ch_1', amount_refunded: 100 })),
    ).toMatchObject({ status: 'ignored' });
  });
});

describe('readWebhookEvent — charge.dispute.created', () => {
  it('rend le litige et ses références', () => {
    expect(
      readWebhookEvent(
        stripeEvent('charge.dispute.created', {
          id: 'dp_1',
          charge: 'ch_1',
          payment_intent: 'pi_1',
          amount: 5000,
        }),
      ),
    ).toMatchObject({
      event: {
        fact: {
          kind: 'dispute-opened',
          disputeId: 'dp_1',
          chargeId: 'ch_1',
          paymentIntentId: 'pi_1',
        },
      },
    });
  });

  it('accepte un litige dont seule la charge est connue', () => {
    expect(
      readWebhookEvent(stripeEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_1' })),
    ).toMatchObject({ event: { fact: { paymentIntentId: null, chargeId: 'ch_1' } } });
  });
});
