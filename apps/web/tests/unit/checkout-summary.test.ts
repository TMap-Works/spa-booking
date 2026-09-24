import type {
  Appointment,
  AppointmentStatus,
  Money,
  PaymentMethod,
  PaymentStatus,
} from '@spa/shared';
import { ERROR_CODES, PAYMENT_ERROR_CODES } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  COUNTER_MEANS,
  checkoutBlocker,
  checkoutFailureMessage,
  firstSettlementCeiling,
  isAlreadySettledRefusal,
  isSettleable,
  isSettled,
  meanHint,
  methodOfMean,
  methodPhrase,
  priceDriftOf,
  receiptDisclaimer,
  settlementBadge,
  settlementOf,
  terminalReferenceField,
  terminalReferenceIssue,
  terminalReferenceRefusal,
} from '@/lib/admin/checkout-summary';
import type { PaymentTransaction, SaleSummary } from '@/lib/admin/payment-contract';

/**
 * Les règles du comptoir, vérifiées sans monter d'écran (#59).
 *
 * Ce qui compte ici n'est pas la formulation des messages mais **le partage
 * qu'ils traduisent** : quel moyen de paiement est ouvert sur quel statut, et
 * lequel des deux reçus peut affirmer qu'un encaissement est inscrit.
 */

describe('quel moyen de paiement est ouvert', () => {
  it('n’offre que les deux moyens que le comptoir sait produire', () => {
    // Ce sont les combinaisons du fil, celles que
    // `POST /v1/sales/{saleId}/payments` accepte. `CARD_ONLINE` n'y est pas et
    // ne peut pas y être : « Stripe n'est plus utilisé au comptoir » est la
    // forme du contrat, pas un contrôle à écrire (ADR 0015).
    expect([...COUNTER_MEANS]).toEqual(['CASH', 'CARD_TERMINAL']);
  });

  it('ramène chaque moyen du fil au moyen du domaine, sans troisième valeur', () => {
    expect(methodOfMean('CASH')).toBe('cash');
    expect(methodOfMean('CARD_TERMINAL')).toBe('card');
  });

  it('refuse tout encaissement sur un rendez-vous annulé', () => {
    expect(checkoutBlocker('cancelled')).toMatch(/annulé/i);
    expect(isSettleable('cancelled')).toBe(false);
  });

  it('laisse encaisser un rendez-vous honoré ou non présenté, par l’un ou l’autre moyen', () => {
    // C'est le cas nominal du comptoir : la prestation est passée, la cliente
    // paie en partant. Le tunnel en ligne les refusait ; le comptoir n'ouvre
    // plus d'intention, et les deux moyens acceptent donc les mêmes statuts.
    for (const status of ['completed', 'no_show'] satisfies AppointmentStatus[]) {
      expect(checkoutBlocker(status)).toBeNull();
      expect(isSettleable(status)).toBe(true);
    }
  });

  it('ouvre les deux moyens sur un rendez-vous à venir', () => {
    for (const status of ['pending', 'confirmed'] satisfies AppointmentStatus[]) {
      expect(checkoutBlocker(status)).toBeNull();
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

  it('ferme le comptoir sur un rendez-vous déjà réglé', () => {
    const settlement = settlementOf([payment('succeeded')], APPOINTMENT);

    expect(checkoutBlocker('completed', settlement)).toMatch(/déjà été encaissé/i);
  });

  it('ferme les **deux** moyens tant qu’une intention en ligne n’est pas conclue', () => {
    // `SettlementRepository` refuse tout règlement de comptoir sur un ticket
    // qui porte une intention vivante, quel qu'en soit le moyen. Tant que le
    // comptoir ouvrait lui-même l'intention, « reprendre la carte » était une
    // issue ; depuis #835 il n'a plus rien à reprendre.
    for (const status of ['pending', 'failed'] satisfies PaymentStatus[]) {
      const settlement = settlementOf([payment(status)], APPOINTMENT);

      expect(checkoutBlocker('confirmed', settlement)).toMatch(/en ligne/i);
    }
  });

  it('laisse l’annulation expliquer le reste — elle passe avant le règlement', () => {
    const settlement = settlementOf([payment('succeeded')], APPOINTMENT);

    expect(checkoutBlocker('cancelled', settlement)).toMatch(/annulé/i);
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
      'paiement en ligne en cours',
      'paiement en ligne en échec',
    ]);
    expect(new Set(labels.map((badge) => badge.modifier)).size).toBe(5);
  });

  it('nomme le remboursement partiel pour ce qu’il est', () => {
    expect(
      settlementBadge(settlementOf([payment('partially_refunded', 'card', 2000)], APPOINTMENT))
        .label,
    ).toMatch(/partiellement/i);
  });

  /**
   * Le ticket à moitié payé que la liste appelait « réglé » — #1240, premier
   * critère.
   *
   * Le repère est celui de l'issue : un ticket de 78,00 € dont 50,00 € ont été
   * pris en espèces. Une seule ligne de `payments`, aboutie — c'est bien pour
   * cela que `settlementOf` s'y trompait —, et 28,00 € encore dus sur la pièce.
   */
  describe('le reste dû du ticket, seule autorité sur « réglé » — #1240', () => {
    const TICKET = 'dddddddd-0000-4000-8000-000000000009';

    /**
     * Une **part** de règlement : la même ligne, avec son montant à elle et un
     * identifiant qui en dépend.
     *
     * Les deux comptent pour le règlement mixte : deux lignes qui partageraient
     * le même identifiant ne seraient pas deux règlements, et c'est exactement
     * ce que la table refuse.
     */
    function partOf(
      status: PaymentStatus,
      method: PaymentMethod = 'card',
      refundedMinor = 0,
      amountMinor = 6500,
    ): PaymentTransaction {
      return {
        ...payment(status, method, refundedMinor),
        id: `ffffffff-0000-4000-8000-${String(amountMinor).padStart(12, '0')}`,
        amount: { amountMinor, currency: 'EUR' },
      };
    }

    function ticket(remainingMinor: number, settledMinor = 7800 - remainingMinor): SaleSummary {
      return {
        id: TICKET,
        appointmentId: APPOINTMENT,
        cashierUserId: 'cccccccc-0000-4000-8000-000000000003',
        subtotal: { amountMinor: 6500, currency: 'EUR' },
        tax: { amountMinor: 1300, currency: 'EUR' },
        tip: { amountMinor: 0, currency: 'EUR' },
        total: { amountMinor: 7800, currency: 'EUR' },
        settled: { amountMinor: settledMinor, currency: 'EUR' },
        remaining: { amountMinor: remainingMinor, currency: 'EUR' },
        settledAt: remainingMinor === 0 ? '2026-09-04T09:10:00.000Z' : null,
        createdAt: '2026-09-04T08:45:00.000Z',
      };
    }

    const tickets = (sale: SaleSummary): ReadonlyMap<string, SaleSummary> =>
      new Map([[APPOINTMENT, sale]]);

    it('ne dit plus « réglé » d’un ticket dont il reste un centime dû', () => {
      const settlement = settlementOf(
        [partOf('succeeded', 'cash', 0, 5000)],
        APPOINTMENT,
        tickets(ticket(2800)),
      );

      expect(settlement.kind).toBe('partiel');
      expect(isSettled(settlement)).toBe(false);
      expect(settlementBadge(settlement).label).toBe('partiellement réglé');
    });

    it('dit « réglé » dès que le ticket est soldé, et lui seul en décide', () => {
      const settlement = settlementOf(
        [partOf('succeeded', 'cash', 0, 7800)],
        APPOINTMENT,
        tickets(ticket(0)),
      );

      expect(settlement.kind).toBe('regle');
      expect(settlementBadge(settlement).label).toBe('réglé');
    });

    it('laisse prendre le reste — un ticket partiel ne ferme aucun moyen', () => {
      // C'est la moitié utile de l'état : avant #1240 l'écran retombait sur
      // « déjà encaissé », et les 28,00 € restants devenaient inatteignables dès
      // qu'on rechargeait entre les deux gestes.
      const settlement = settlementOf(
        [partOf('succeeded', 'cash', 0, 5000)],
        APPOINTMENT,
        tickets(ticket(2800)),
      );

      expect(checkoutBlocker('completed', settlement)).toBeNull();
    });

    it('tient un règlement mixte pour un seul état, pas pour deux lignes', () => {
      // 50,00 € d'espèces puis 28,00 € au terminal : deux lignes abouties sur le
      // même rendez-vous, puisque `payments.appointment_id` s'y résout par la
      // vente. `find` en retenait une au hasard de l'ordre de l'API.
      const settlement = settlementOf(
        [partOf('succeeded', 'card', 0, 2800), partOf('succeeded', 'cash', 0, 5000)],
        APPOINTMENT,
        tickets(ticket(0)),
      );

      expect(settlement.kind).toBe('regle');
    });

    it('ne laisse pas un « pending » qui suit un encaissement rouvrir la carte', () => {
      const settlement = settlementOf(
        [partOf('pending', 'card'), partOf('succeeded', 'cash', 0, 7800)],
        APPOINTMENT,
        tickets(ticket(0)),
      );

      expect(settlement.kind).toBe('regle');
    });

    it('ne rouvre pas le comptoir sous une intention carte encore en vol', () => {
      // Le cas atteignable depuis #817 : 50,00 € d'espèces au comptoir, puis la
      // cliente règle le reste depuis son navigateur. `hasLiveCardIntent` refuse
      // alors en 409 tout règlement de comptoir sur cette pièce
      // (`settlement.repository.ts`) : conclure `partiel` aurait rouvert les deux
      // moyens pour faire retomber le refus **après** le clic.
      const settlement = settlementOf(
        [partOf('pending', 'card', 0, 2800), partOf('succeeded', 'cash', 0, 5000)],
        APPOINTMENT,
        tickets(ticket(2800)),
      );

      expect(settlement.kind).toBe('ouvert');
      expect(checkoutBlocker('completed', settlement)).not.toBeNull();
    });

    it('laisse prendre le reste malgré une carte en ligne **refusée**', () => {
      // La garde de l'API ne porte que sur `PENDING` : une carte refusée
      // n'immobilise pas la pièce, et les 28,00 € restants doivent rester
      // encaissables au comptoir.
      const settlement = settlementOf(
        [partOf('failed', 'card', 0, 2800), partOf('succeeded', 'cash', 0, 5000)],
        APPOINTMENT,
        tickets(ticket(2800)),
      );

      expect(settlement.kind).toBe('partiel');
      expect(checkoutBlocker('completed', settlement)).toBeNull();
    });

    it('reste sur « réglé » quand aucun ticket n’a pu être relu', () => {
      // C'est l'état d'avant, et il est assumé : conclure « partiel » faute de
      // preuve serait l'erreur inverse, et la plus fréquente. La prudence est un
      // cran plus haut — la page tait la colonne entière (`page.tsx`).
      expect(settlementOf([partOf('succeeded')], APPOINTMENT).kind).toBe('regle');
      expect(settlementOf([partOf('succeeded')], APPOINTMENT, new Map()).kind).toBe('regle');
    });

    it('n’emprunte la nuance d’un autre état qu’en écrivant son libellé', () => {
      // WCAG 1.4.1 : `partiel` partage la rampe d'avertissement avec la carte en
      // cours, comme « partiellement remboursé » partage celle du remboursement
      // depuis #828. Ce qui distingue les deux est le mot, toujours écrit.
      const partial = settlementBadge(
        settlementOf([partOf('succeeded', 'cash', 0, 5000)], APPOINTMENT, tickets(ticket(2800))),
      );
      const open = settlementBadge(settlementOf([partOf('pending')], APPOINTMENT));

      expect(partial.modifier).toBe(open.modifier);
      expect(partial.label).not.toBe(open.label);
    });
  });
});

/**
 * Le tarif qui a bougé entre la réservation et le comptoir — #1240, deuxième
 * critère.
 *
 * Les deux prix arrivent **du même appel** : `GET /appointments` sert `price`
 * (figé à la réservation) et `service.price` (tarif courant du catalogue). Rien
 * de ce qui suit ne demande une lecture de plus, et c'est ce qui permet de tenir
 * le critère sans ouvrir de route.
 */
describe('l’écart de tarif, expliqué avant le clic — #1240', () => {
  const euros = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

  /**
   * Un rendez-vous dont les **deux** prix divergent — celui figé à la
   * réservation, et celui que le catalogue porte aujourd'hui.
   *
   * Les deux sont servis par `GET /appointments` : `price` et `service.price`. Le
   * repère est donc construit sans cast — le contrat dit déjà que le comptoir a
   * les deux sous la main, et un `as Appointment` aurait laissé la divergence de
   * forme passer pour un détail de test.
   */
  function appointment(bookedMinor: number, catalogMinor: number, currency = 'EUR'): Appointment {
    return {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      reference: 'RDV-8F3K-27',
      status: 'completed',
      client: {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        firstName: 'Awa',
        lastName: 'Ndiaye',
      },
      staff: { id: 'cccccccc-0000-4000-8000-000000000003', displayName: 'Lucie' },
      service: {
        id: 'eeeeeeee-0000-4000-8000-000000000004',
        name: 'Soin visage',
        durationMinutes: 60,
        price: { amountMinor: catalogMinor, currency },
      },
      startsAt: '2026-09-04T08:00:00.000Z',
      endsAt: '2026-09-04T09:00:00.000Z',
      price: euros(bookedMinor),
      createdAt: '2026-09-01T08:00:00.000Z',
    };
  }

  function ticketTotalling(totalMinor: number): SaleSummary {
    return {
      id: 'dddddddd-0000-4000-8000-000000000009',
      appointmentId: 'aaaaaaaa-0000-4000-8000-000000000001',
      cashierUserId: 'cccccccc-0000-4000-8000-000000000003',
      subtotal: euros(totalMinor),
      tax: euros(0),
      tip: euros(0),
      total: euros(totalMinor),
      settled: euros(0),
      remaining: euros(totalMinor),
      settledAt: null,
      createdAt: '2026-09-04T08:45:00.000Z',
    };
  }

  it('se tait quand le catalogue dit encore ce que la cliente a accepté', () => {
    expect(priceDriftOf(appointment(6500, 6500), null)).toBeNull();
  });

  it('nomme le tarif du catalogue tant que le ticket n’existe pas', () => {
    expect(priceDriftOf(appointment(7800, 6500), null)).toEqual({
      kind: 'catalogue',
      charged: euros(6500),
      booked: euros(7800),
    });
  });

  it('laisse le ticket faire foi dès qu’il existe — pourboire et articles compris', () => {
    expect(priceDriftOf(appointment(6500, 6500), ticketTotalling(7000))).toEqual({
      kind: 'ticket',
      charged: euros(7000),
      booked: euros(6500),
    });
  });

  it('tient une devise différente pour un écart, et non pour une coïncidence', () => {
    // `POST /sales` refuse en 422 `SALE_CURRENCY_MISMATCH` : autant le dire avant.
    expect(priceDriftOf(appointment(6500, 6500, 'MGA'), null)).not.toBeNull();
  });

  it('plafonne le premier règlement à ce que le ticket pourra porter', () => {
    // Le cas qui sortait en 422 `SALE_OVERPAYMENT` : tarif baissé depuis la
    // réservation, et l'écran envoyait quand même le prix figé.
    expect(firstSettlementCeiling(appointment(7800, 6500))).toEqual(euros(6500));
  });

  it('ne facture jamais une hausse que la cliente n’a pas vue', () => {
    expect(firstSettlementCeiling(appointment(6500, 7800))).toEqual(euros(6500));
  });

  it('garde le prix figé quand les deux devises divergent', () => {
    expect(firstSettlementCeiling(appointment(6500, 100, 'MGA'))).toEqual(euros(6500));
  });
});

describe('ce que l’écran dit du moyen choisi', () => {
  it('dit que la carte passe par le terminal du salon, et qu’aucun numéro n’est saisi', () => {
    // La mention n'est pas décorative : le prochain contributeur doit trouver la
    // raison avant d'ajouter le champ qui semblerait manquer.
    expect(meanHint('CARD_TERMINAL')).toMatch(/terminal/i);
    expect(meanHint('CARD_TERMINAL')).toMatch(/aucun numéro/i);
  });

  it('ne promet plus que la carte se saisit dans des champs servis par Stripe', () => {
    // Le formulaire a quitté le comptoir avec l'ADR 0015 : une aide qui le
    // nommerait encore décrirait un écran qui n'existe plus.
    expect(meanHint('CARD_TERMINAL')).not.toMatch(/stripe/i);
  });

  it('dit que les espèces n’appellent aucun prestataire', () => {
    expect(meanHint('CASH')).toMatch(/caisse fait foi/i);
  });
});

describe('le numéro du ticket du terminal', () => {
  it('accepte l’absence — le caissier n’a pas toujours le ticket sous la main', () => {
    expect(terminalReferenceIssue('')).toBeNull();
    expect(terminalReferenceIssue('   ')).toBeNull();
    expect(terminalReferenceField('')).toEqual({});
    expect(terminalReferenceField('  ')).toEqual({});
  });

  it('accepte une référence alphanumérique et la transmet sans espaces', () => {
    expect(terminalReferenceIssue('A1B2C3')).toBeNull();
    expect(terminalReferenceField(' A1B2C3 ')).toEqual({ terminalReference: 'A1B2C3' });
  });

  it('refuse les séparateurs — ce sont eux qui déguisent un numéro de carte', () => {
    expect(terminalReferenceIssue('4242 4242 4242 4242')).not.toBeNull();
    expect(terminalReferenceIssue('4242-4242-4242-4242')).not.toBeNull();
  });

  it('refuse au-delà de 32 caractères, la borne de la colonne', () => {
    expect(terminalReferenceIssue('A'.repeat(32))).toBeNull();
    expect(terminalReferenceIssue('A'.repeat(33))).not.toBeNull();
  });

  it('laisse passer ce que seule l’API sait refuser', () => {
    // Seize chiffres collés : la forme est irréprochable — alphanumérique,
    // sous la borne — et c'est la clé de Luhn, côté API, qui tranche. Cet
    // écart est délibéré : le contrôle de conformité ne vit qu'à un endroit
    // (`payments/terminal-reference.ts`), et c'est ce qui rend le chemin
    // ci-dessous nécessaire.
    expect(terminalReferenceIssue('4242424242424242')).toBeNull();
  });
});

describe('le refus que l’API oppose à la référence — #1025, critère 3', () => {
  /** Le 400 tel que le filtre d'exception de l'API le compose. */
  const violations = {
    violations: [
      'terminalReference : ce champ n’est pas celui d’un numéro de carte — saisir le numéro du ticket du terminal',
    ],
  };

  it('reconnaît le 400 qui nomme le champ, et rend la phrase du catalogue', () => {
    const refused = terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, violations);

    expect(refused).not.toBeNull();
    expect(refused).toMatch(/numéro de ticket TPE a été refusé/i);
    // Jamais le message de l'API : il n'est traduit nulle part, et « La
    // requête est invalide. » n'apprend rien au comptoir (web-frontend §2).
    expect(refused).not.toMatch(/requête est invalide/i);
  });

  it('parle les deux langues de l’écran', () => {
    expect(terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, violations, 'en')).toMatch(
      /terminal receipt number was refused/i,
    );
  });

  it('ignore le repli HTTP_400, qui ne porte jamais de violations', () => {
    // `ApiClientError` ne compose `HTTP_<statut>` que sur la branche sans
    // `details` : un 400 dont le corps est au contrat garde son vrai code. Lire
    // ce repli ici serait une garde qui ne peut pas se déclencher.
    expect(terminalReferenceRefusal('HTTP_400', violations)).toBeNull();
  });

  it('laisse au bloc tout refus qui ne parle pas de ce champ', () => {
    // Un 400 sans violation nommée, ou qui en nomme une autre, doit rester
    // visible : posé sur un champ sans rapport, il disparaîtrait de l'écran.
    expect(terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, undefined)).toBeNull();
    expect(terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, {})).toBeNull();
    expect(
      terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, { violations: [] }),
    ).toBeNull();
    expect(
      terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, {
        violations: ['amountMinor : entier attendu'],
      }),
    ).toBeNull();
    // Une forme inattendue ne fait pas tomber l'écran : `violations` est du
    // corps d'erreur, et rien ne garantit son type côté front.
    expect(
      terminalReferenceRefusal(ERROR_CODES.VALIDATION_ERROR, { violations: 'terminalReference' }),
    ).toBeNull();
  });

  it('ne détourne aucun autre refus vers le champ', () => {
    // Le 409 « déjà soldé » fait **changer l'écran d'état** (#828) : l'égarer
    // sous un champ de saisie laisserait le bouton actif sur un règlement qui
    // ne peut qu'échouer.
    expect(
      terminalReferenceRefusal(PAYMENT_ERROR_CODES.SALE_ALREADY_SETTLED, violations),
    ).toBeNull();
    expect(terminalReferenceRefusal(ERROR_CODES.NOT_FOUND, violations)).toBeNull();
  });
});

describe('ce qu’un reçu peut affirmer', () => {
  it('rend le reçu du comptoir définitif — plus aucun tiers à attendre', () => {
    // Espèces comme TPE, l'API inscrit le règlement `SUCCEEDED` quand elle
    // répond : il n'y a plus de webhook dont le reçu dépendrait (ADR 0015).
    expect(receiptDisclaimer()).toMatch(/caisse/i);
    expect(receiptDisclaimer()).not.toMatch(/webhook/i);
  });

  it('accorde le moyen de paiement à la phrase qui le porte', () => {
    expect(methodPhrase('card')).toBe('par carte bancaire (TPE)');
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

  it('distingue la caisse injoignable d’un refus métier, et rassure sur le débit', () => {
    for (const code of ['PAYMENT_PROVIDER_UNAVAILABLE', ERROR_CODES.SERVICE_UNAVAILABLE]) {
      expect(checkoutFailureMessage(code, 'x')).toMatch(/rien n’a été encaissé/i);
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

  it('reconnaît le ticket soldé que « POST /payments/cash » rend depuis #817', () => {
    // Le cas relevé par l'audit `d20260917-2` (#1005) : depuis que la route
    // compose la vente avant de la régler, le second clic se heurte au **ticket**
    // soldé et rend 409 `SALE_ALREADY_SETTLED`, et non `PAYMENT_ALREADY_SETTLED`.
    // Le code manquait des deux listes du front : l'écran ne basculait pas, et
    // affichait « Ce ticket a déjà été réglé. » — le message brut de l'API.
    expect(isAlreadySettledRefusal('SALE_ALREADY_SETTLED')).toBe(true);
    expect(checkoutFailureMessage('SALE_ALREADY_SETTLED', 'Ce ticket a déjà été réglé.')).toMatch(
      /déjà été encaissé/i,
    );
  });

  it('ne laisse aucun code « … déjà réglé » du contrat hors de la bascule', () => {
    // Le garde qui empêche le prochain renommage de repasser en silence. Les
    // deux codes d'aujourd'hui sont arrivés à deux ans d'écart et par deux
    // tickets différents ; le troisième arrivera de la même façon. Le déduire de
    // `PAYMENT_ERROR_CODES` plutôt que de le recopier fait échouer **ce test** le
    // jour où l'API en sert un de plus, au lieu de laisser l'écran l'ignorer.
    const settledCodes = Object.values(PAYMENT_ERROR_CODES).filter((code) =>
      code.endsWith('_ALREADY_SETTLED'),
    );

    expect(settledCodes.length).toBeGreaterThan(1);

    for (const code of settledCodes) {
      expect(isAlreadySettledRefusal(code)).toBe(true);
      expect(checkoutFailureMessage(code, 'Message brut de l’API.')).not.toBe(
        'Message brut de l’API.',
      );
    }
  });

  it('dit la même chose de tous les refus « déjà encaissé », quel que soit le code', () => {
    // Un seul texte pour un seul état : deux formulations feraient croire au
    // comptoir à deux incidents différents, là où la conduite est la même.
    const codes = ['PAYMENT_ALREADY_SETTLED', 'SALE_ALREADY_SETTLED', ERROR_CODES.CONFLICT];
    const shown = codes.map((code) => checkoutFailureMessage(code, 'x'));

    expect(new Set(shown).size).toBe(1);
  });

  it('reconnaît aussi le repli « HTTP_409 » du filtre d’exception', () => {
    // Un 409 arrivé hors de la forme d'erreur du contrat porte `HTTP_409` —
    // c'est la raison même pour laquelle `HTTP_404` et `HTTP_429` sont lus ici.
    // Il ne rattrape pas pour autant un 409 **conforme** dont le code est inconnu
    // de la liste : c'est ce qui a laissé passer `SALE_ALREADY_SETTLED`.
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
