import type { AppointmentStatus } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_METHODS,
  checkoutBlocker,
  checkoutFailureMessage,
  isSettleable,
  methodHint,
  receiptDisclaimer,
  receiptIsProvisional,
} from '@/lib/admin/checkout-summary';

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

  it('laisse passer le message de l’API sur un code qu’il ne connaît pas', () => {
    // Un code inconnu vaut mieux affiché que remplacé par une phrase générique.
    expect(checkoutFailureMessage('UN_CODE_INCONNU', 'Message précis de l’API.')).toBe(
      'Message précis de l’API.',
    );
  });
});
