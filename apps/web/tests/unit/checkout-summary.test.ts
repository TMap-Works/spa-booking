import type { AppointmentStatus, PaymentMethod, PaymentStatus } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_METHODS,
  checkoutBlocker,
  checkoutFailureMessage,
  isAlreadySettledRefusal,
  isSettleable,
  isSettled,
  methodHint,
  methodPhrase,
  receiptDisclaimer,
  receiptIsProvisional,
  settledReceiptDisclaimer,
  settlementBadge,
  settlementOf,
} from '@/lib/admin/checkout-summary';
import type { PaymentTransaction } from '@/lib/admin/payment-contract';

/**
 * Les règles du comptoir, vérifiées sans monter d'écran (#59).
 *
 * Ce qui compte ici n'est pas la formulation des messages mais **le partage
 * qu'ils traduisent** : quel moyen de paiement est ouvert sur quel statut, et
 * lequel des deux reçus peut affirmer qu'un encaissement est inscrit.
 */

describe('quel moyen de paiement est ouvert', () => {
  it('n’offre que deux moyens, et aucun qui suppose un lecteur absent', () => {
    // La maquette de #30 en dessine trois — le troisième est un lien de
    // paiement que l'API ne sert pas. Un bouton qui ne mène à rien coûte plus
    // cher au comptoir que son absence.
    expect([...CHECKOUT_METHODS]).toEqual(['cash', 'card']);
  });

  it('refuse tout encaissement sur un rendez-vous annulé', () => {
    for (const method of CHECKOUT_METHODS) {
      expect(checkoutBlocker('cancelled', method)).toMatch(/annulé/i);
    }

    expect(isSettleable('cancelled')).toBe(false);
  });

  it('laisse encaisser en espèces un rendez-vous honoré ou non présenté', () => {
    // C'est le cas nominal du comptoir : la prestation est passée, la cliente
    // paie en partant. Le tunnel en ligne les refuse, la caisse non.
    for (const status of ['completed', 'no_show'] satisfies AppointmentStatus[]) {
      expect(checkoutBlocker(status, 'cash')).toBeNull();
      expect(isSettleable(status)).toBe(true);
    }
  });

  it('ferme la carte sur un rendez-vous honoré ou non présenté, et dit quoi faire', () => {
    // L'API refuse l'ouverture d'intention en 422 sur ces statuts. L'écran doit
    // le dire **avant** l'appel, et proposer l'issue qui reste.
    for (const status of ['completed', 'no_show'] satisfies AppointmentStatus[]) {
      const blocker = checkoutBlocker(status, 'card');

      expect(blocker).not.toBeNull();
      expect(blocker).toMatch(/espèces/i);
    }
  });

  it('ouvre les deux moyens sur un rendez-vous à venir', () => {
    for (const status of ['pending', 'confirmed'] satisfies AppointmentStatus[]) {
      for (const method of CHECKOUT_METHODS) {
        expect(checkoutBlocker(status, method)).toBeNull();
      }
    }
  });
});

describe('l’état de règlement, lu avant le clic', () => {
  const APPOINTMENT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const VOISIN = 'aaaaaaaa-0000-4000-8000-000000000002';

  function payment(
    status: PaymentStatus,
    method: PaymentMethod = 'card',
    refundedMinor = 0,
  ): PaymentTransaction {
    return {
      id: 'ffffffff-0000-4000-8000-000000000005',
      appointmentId: APPOINTMENT,
      amount: { amountMinor: 6500, currency: 'EUR' },
      refunded: { amountMinor: refundedMinor, currency: 'EUR' },
      method,
      status,
      capturedAt: '2026-09-04T08:45:00.000Z',
      createdAt: '2026-09-04T08:45:00.000Z',
    };
  }

  it('rend « dû » quand la journée ne porte aucun encaissement pour ce rendez-vous', () => {
    expect(settlementOf([], APPOINTMENT)).toEqual({ kind: 'du' });
    expect(settlementOf([payment('succeeded')], VOISIN)).toEqual({ kind: 'du' });
  });

  it('rend « réglé » sur les trois statuts où de l’argent a été pris', () => {
    // La liste vient du contrat (`CAPTURED_PAYMENT_STATUSES`) et non d'une copie
    // locale : un remboursement reste un encaissement inscrit, et proposer d'en
    // créer un second créerait une pièce comptable de trop.
    for (const status of [
      'succeeded',
      'refunded',
      'partially_refunded',
    ] satisfies PaymentStatus[]) {
      const settlement = settlementOf([payment(status)], APPOINTMENT);

      expect(settlement.kind).toBe('regle');
      expect(isSettled(settlement)).toBe(true);
    }
  });

  it('distingue l’intention carte en cours de celle qui a échoué', () => {
    // `replayOrRefuse` côté API refuse les espèces dans les deux cas : un
    // booléen « réglé ou non » aurait laissé l'écran les proposer, et le refus
    // serait revenu après le clic — le défaut même que #828 corrige.
    expect(settlementOf([payment('pending')], APPOINTMENT).kind).toBe('ouvert');
    expect(settlementOf([payment('failed')], APPOINTMENT).kind).toBe('echoue');
  });

  it('ferme les deux moyens sur un rendez-vous déjà réglé', () => {
    const settlement = settlementOf([payment('succeeded')], APPOINTMENT);

    for (const method of CHECKOUT_METHODS) {
      expect(checkoutBlocker('completed', method, settlement)).toMatch(/déjà été encaissé/i);
    }
  });

  it('ferme les espèces mais laisse reprendre la carte quand une intention court', () => {
    for (const status of ['pending', 'failed'] satisfies PaymentStatus[]) {
      const settlement = settlementOf([payment(status)], APPOINTMENT);

      expect(checkoutBlocker('confirmed', 'cash', settlement)).toMatch(/carte/i);
      expect(checkoutBlocker('confirmed', 'card', settlement)).toBeNull();
    }
  });

  it('laisse l’annulation expliquer le reste — elle passe avant le règlement', () => {
    const settlement = settlementOf([payment('succeeded')], APPOINTMENT);

    expect(checkoutBlocker('cancelled', 'cash', settlement)).toMatch(/annulé/i);
  });

  it('écrit toujours le libellé de la pastille — la couleur ne porte rien seule', () => {
    // WCAG 1.4.1 : la teinte n'accélère que le balayage d'une journée.
    const labels = (
      [
        [[], 'du'],
        [[payment('succeeded')], 'regle'],
        [[payment('refunded', 'card', 6500)], 'regle'],
        [[payment('pending')], 'ouvert'],
        [[payment('failed')], 'echoue'],
      ] as const
    ).map(([payments]) => settlementBadge(settlementOf(payments, APPOINTMENT)));

    expect(labels.map((badge) => badge.label)).toEqual([
      'à encaisser',
      'réglé',
      'remboursé',
      'carte en cours',
      'carte en échec',
    ]);
    expect(new Set(labels.map((badge) => badge.modifier)).size).toBe(5);
  });

  it('nomme le remboursement partiel pour ce qu’il est', () => {
    expect(
      settlementBadge(settlementOf([payment('partially_refunded', 'card', 2000)], APPOINTMENT))
        .label,
    ).toMatch(/partiellement/i);
  });
});

describe('ce que l’écran dit du moyen choisi', () => {
  it('écrit la frontière PCI sous le moyen carte', () => {
    // La mention n'est pas décorative : le prochain contributeur doit trouver la
    // raison avant d'ajouter le champ qui semblerait manquer.
    expect(methodHint('card')).toMatch(/aucun numéro/i);
  });

  it('dit que les espèces n’appellent aucun prestataire', () => {
    expect(methodHint('cash')).toMatch(/aucun appel au prestataire/i);
  });
});

describe('ce qu’un reçu peut affirmer', () => {
  it('rend le reçu carte provisoire — le navigateur ne conclut pas un paiement', () => {
    expect(receiptIsProvisional('card')).toBe(true);
    expect(receiptDisclaimer('card')).toMatch(/webhook/i);
  });

  it('rend le reçu espèces définitif — la caisse fait foi', () => {
    expect(receiptIsProvisional('cash')).toBe(false);
    expect(receiptDisclaimer('cash')).toMatch(/caisse qui fait foi/i);
  });

  it('rend définitif le reçu **réimprimé** d’une carte déjà inscrite', () => {
    // C'est le webhook signé qui a écrit la ligne qu'on vient de relire : la
    // mention provisoire ferait dire à l'écran qu'il ne sait pas ce qu'il lit.
    expect(settledReceiptDisclaimer('card')).toMatch(/définitif/i);
    expect(settledReceiptDisclaimer('card')).not.toMatch(/pas de capture/i);
    expect(settledReceiptDisclaimer('cash')).toBe(receiptDisclaimer('cash'));
  });

  it('accorde le moyen de paiement à la phrase qui le porte', () => {
    expect(methodPhrase('card')).toBe('par carte');
    expect(methodPhrase('cash')).toBe('en espèces');
  });
});

describe('la lecture d’un refus de l’API', () => {
  it('réagit sur le code et non sur le message', () => {
    // Le message de l'API est destiné à un humain et peut changer sans préavis ;
    // c'est le code qui est le contrat (web-frontend §2).
    const shown = checkoutFailureMessage('PAYMENT_ALREADY_SETTLED', 'Already settled.');

    expect(shown).not.toBe('Already settled.');
    expect(shown).toMatch(/déjà été encaissé/i);
  });

  it('distingue le refus du prestataire d’un refus métier, et rassure sur le débit', () => {
    for (const code of ['PAYMENT_PROVIDER_UNAVAILABLE', ERROR_CODES.SERVICE_UNAVAILABLE]) {
      expect(checkoutFailureMessage(code, 'x')).toMatch(/rien n’a été débité/i);
    }
  });

  it('ne distingue pas le rendez-vous inconnu de celui du voisin', () => {
    // Un message différent ferait de cet écran une sonde d'existence
    // (tenant-isolation §4).
    expect(checkoutFailureMessage(ERROR_CODES.NOT_FOUND, 'x')).toBe(
      checkoutFailureMessage('HTTP_404', 'y'),
    );
  });

  it('reconnaît le refus « déjà encaissé » pour en faire un état, pas une ligne rouge', () => {
    // L'écran change d'état sur ce code : recliquer ne pourrait qu'échouer de la
    // même façon, et le proposer devant une cliente est le défaut que #828 ferme.
    expect(isAlreadySettledRefusal('PAYMENT_ALREADY_SETTLED')).toBe(true);
    expect(isAlreadySettledRefusal(ERROR_CODES.CONFLICT)).toBe(true);
    expect(isAlreadySettledRefusal(ERROR_CODES.NOT_FOUND)).toBe(false);
  });

  it('reconnaît aussi le repli « HTTP_409 » du filtre d’exception', () => {
    // Un 409 arrivé hors de la forme d'erreur du contrat porte `HTTP_409` —
    // c'est la raison même pour laquelle `HTTP_404` et `HTTP_429` sont lus ici.
    // L'omettre laissait ce refus-là sous un bouton resté actif.
    expect(isAlreadySettledRefusal('HTTP_409')).toBe(true);
    expect(checkoutFailureMessage('HTTP_409', 'Conflict.')).toMatch(/déjà été encaissé/i);
  });

  it('laisse passer le message de l’API sur un code qu’il ne connaît pas', () => {
    // Un code inconnu vaut mieux affiché que remplacé par une phrase générique.
    expect(checkoutFailureMessage('UN_CODE_INCONNU', 'Message précis de l’API.')).toBe(
      'Message précis de l’API.',
    );
  });
});
