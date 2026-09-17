import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NotFoundError } from '../../../common/errors';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { runWithTenant } from '../../../common/tenant';
import { SaleAlreadySettledError, SaleOverpaymentError } from '../payments.errors';
import type { PaymentsRepository } from '../payments.repository';
import type { SalesService } from '../sales.service';
import { SettlementService } from '../settlement.service';
import { FakeSettlementRepository, asSettlementRepository } from './settlement.doubles';

/**
 * **Encaisser la carte au comptoir par TPE** — le septième critère de #834, ses
 * cinq points, dans l'ordre où l'issue les écrit.
 *
 * | Ce qui est exercé | Ce que cela protège |
 * |---|---|
 * | un règlement TPE n'appelle jamais Stripe | la frontière PCI : le comptoir n'a plus de chemin vers un prestataire |
 * | espèces puis TPE soldent la vente | le règlement mixte de #817 survit au nouveau moyen |
 * | un TPE qui dépasse le reste dû rend 422 | le serveur ne rogne jamais un montant en silence |
 * | une référence qui ressemble à une carte rend 400 | `terminal-reference.spec.ts`, qui la couvre numéro par numéro |
 * | le ticket d'un autre établissement rend 404 | la frontière du tenant, indiscernable d'un inconnu |
 *
 * Le quatrième point vit dans `terminal-reference.spec.ts` : il se joue à la
 * frontière HTTP, sur le DTO, et non dans le service — la valeur n'atteint
 * jamais cette couche.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const NEIGHBOUR = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

/** Le ticket du constat : 78,00 €, réglé 50,00 € en espèces puis 28,00 € au TPE. */
const TICKET_MINOR = 7800;

/** Le journal, muet — la sortie est vérifiée ailleurs, pas ici. */
class SilentLogger extends StructuredLogger {
  public constructor() {
    super({ logLevel: 'error' } as never);
  }

  protected override emit(): void {
    /* rien : une suite ne doit pas écrire sur la sortie standard */
  }
}

function serviceWith(settlements: FakeSettlementRepository): SettlementService {
  return new SettlementService(
    // Ni `PaymentsRepository` ni `SalesService` ne sont atteints par
    // `settleSale` : il ne compose pas de vente, il règle une pièce existante.
    // Les fournir vides est ce qui rend visible qu'ils ne servent pas ce chemin.
    {} as unknown as PaymentsRepository,
    asSettlementRepository(settlements),
    {} as unknown as SalesService,
    new SilentLogger(),
  );
}

describe('le règlement au TPE n’appelle aucun prestataire — premier point', () => {
  /**
   * La preuve est **structurelle**, et c'est la seule qui tienne.
   *
   * Compter zéro appel sur un double de passerelle ne prouverait rien : le
   * double serait tenu par la suite, pas par le service. Ce qui prouve
   * qu'aucun appel n'a lieu est qu'il n'y a **nulle part où le passer** — les
   * trois fichiers du chemin TPE n'importent rien de `stripe/`, et le
   * constructeur du service ne reçoit pas de passerelle. C'est le même
   * raisonnement que celui de `payments.boundaries.spec.ts`, appliqué au
   * chemin que #834 ouvre.
   */
  const MODULE_DIR = join(__dirname, '..');

  /** Le fichier privé de ses commentaires — on interdit de *détenir*, pas d'expliquer. */
  const code = (name: string): string =>
    readFileSync(join(MODULE_DIR, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it.each(['settlement.service.ts', 'settlement.repository.ts', 'terminal-reference.ts'])(
    '%s n’importe rien de `stripe/`',
    (name) => {
      const imports = [...code(name).matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

      expect(imports.filter((specifier) => (specifier ?? '').includes('stripe'))).toEqual([]);
    },
  );

  it('inscrit un règlement TPE sans la moindre référence de prestataire', async () => {
    const settlements = new FakeSettlementRepository();
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    const settlement = await runWithTenant(TENANT, () =>
      serviceWith(settlements).settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-tpe-0001'),
    );

    // Ce que la ligne porte, et ce qu'elle ne porte pas. `cardChannel` dit le
    // terminal du salon ; les deux références de prestataire sont nulles **par
    // construction** — le chemin n'a personne à appeler pour en produire une.
    expect(settlement.payment).toMatchObject({
      method: 'CARD',
      cardChannel: 'TERMINAL',
      status: 'SUCCEEDED',
      providerPaymentIntentId: null,
      providerChargeId: null,
    });
    // L'opérateur et l'horodatage, que le critère 2 exige du règlement déclaré.
    expect(settlement.payment.capturedAt).toBeInstanceOf(Date);
    expect(settlement.settledAt).toBeInstanceOf(Date);
  });

  it('conserve la référence du ticket du terminal quand le caissier l’a saisie', async () => {
    const settlements = new FakeSettlementRepository();
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    const settlement = await runWithTenant(TENANT, () =>
      serviceWith(settlements).settleSale(
        sale.id,
        OPERATOR,
        { method: 'CARD', terminalReference: 'A0000123' },
        'cle-tpe-0002',
      ),
    );

    expect(settlement.payment.terminalReference).toBe('A0000123');
  });
});

describe('espèces puis TPE soldent la vente — deuxième point', () => {
  it('additionne les deux règlements et ferme le ticket au centime', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    const first = await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CASH', amountMinor: 5000 }, 'cle-mixte-a'),
    );

    // Le premier règlement ne solde pas : il reste 28,00 € dus, et l'écran doit
    // le lire sans recalculer quoi que ce soit.
    expect(first.remaining.amountMinor).toBe(2800);
    expect(first.settledAt).toBeNull();

    const second = await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-mixte-b'),
    );

    expect(second.settled.amountMinor).toBe(TICKET_MINOR);
    expect(second.remaining.amountMinor).toBe(0);
    expect(second.settledAt).toBeInstanceOf(Date);

    // Deux lignes, deux moyens : c'est ce que la relève du TPE lit, et les
    // fondre en une seule effacerait du rapprochement la moitié de la recette.
    expect(settlements.meansOf(sale.id)).toEqual(['CASH', 'CARD_TERMINAL']);
  });

  it('refuse un troisième règlement sur un ticket soldé — 409', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CASH' }, 'cle-solde-a'),
    );

    await expect(
      runWithTenant(TENANT, () =>
        service.settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-solde-b'),
      ),
    ).rejects.toBeInstanceOf(SaleAlreadySettledError);
  });
});

describe('un règlement TPE qui dépasse le reste dû rend 422 — troisième point', () => {
  it('refuse le centime de trop, et dit ce qui restait', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CASH', amountMinor: 5000 }, 'cle-trop-a'),
    );

    const refusal = runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CARD', amountMinor: 2801 }, 'cle-trop-b'),
    );

    await expect(refusal).rejects.toBeInstanceOf(SaleOverpaymentError);
    // Le reste dû est dans `details` : sans lui, l'écran ne peut que faire
    // retâtonner l'opérateur montant après montant.
    await expect(refusal).rejects.toMatchObject({ details: { remainingAmountMinor: 2800 } });
    // Et rien n'a été écrit — un refus n'inscrit pas de pièce comptable.
    expect(settlements.meansOf(sale.id)).toEqual(['CASH']);
  });

  it('ne rend jamais la monnaie sur un passage au terminal', async () => {
    // Un terminal débite un montant exact : il n'a pas de tiroir-caisse à
    // ouvrir, et un « excédent » y serait une faute de frappe. Le DTO refuse
    // d'ailleurs `tenderedAmountMinor` hors espèces, en 400.
    const settlements = new FakeSettlementRepository();
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    const settlement = await runWithTenant(TENANT, () =>
      serviceWith(settlements).settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-exact'),
    );

    expect(settlement.change.amountMinor).toBe(0);
  });
});

describe('le ticket d’un autre établissement rend 404 — cinquième point', () => {
  it('ne distingue pas le ticket du voisin d’un identifiant inconnu', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const neighbour = settlements.seedSale({
      tenantId: NEIGHBOUR,
      totalAmountMinor: TICKET_MINOR,
    });

    // Même erreur, même message : la différence servirait de sonde d'existence
    // (tenant-isolation §4). Jamais 403, qui confirmerait que le ticket existe.
    await expect(
      runWithTenant(TENANT, () =>
        service.settleSale(neighbour.id, OPERATOR, { method: 'CARD' }, 'cle-voisin'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      runWithTenant(TENANT, () =>
        service.settleSale(
          '44444444-4444-4444-8444-444444444444',
          OPERATOR,
          { method: 'CARD' },
          'cle-inconnu',
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Et le ticket du voisin n'a rien reçu.
    expect(settlements.meansOf(neighbour.id)).toEqual([]);
  });
});

/**
 * **La clé d'idempotence** — quatrième critère : « une double soumission rend le
 * même règlement ».
 *
 * C'est la propriété que rien d'autre ne peut tenir : la route inscrit une pièce
 * comptable à chaque appel, et deux règlements de 25,00 € sur le même ticket
 * sont deux gestes légitimes. Sans clé, le serveur n'a aucun moyen de
 * distinguer le réseau qui a coupé du caissier qui encaisse une seconde part.
 */
describe('la clé d’idempotence — quatrième critère', () => {
  it('rejouée, rend le même règlement sans rien écrire', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    const first = await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-rejeu'),
    );
    const replay = await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CARD' }, 'cle-rejeu'),
    );

    expect(replay.payment.id).toBe(first.payment.id);
    expect(replay.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    // Une seule pièce : le deuxième clic n'a pas encaissé une seconde fois.
    expect(settlements.payments).toHaveLength(1);
    expect(replay.settled.amountMinor).toBe(TICKET_MINOR);
  });

  it('deux clés distinctes inscrivent deux règlements — c’est le règlement mixte', async () => {
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const sale = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: TICKET_MINOR });

    await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CASH', amountMinor: 5000 }, 'cle-part-1'),
    );
    await runWithTenant(TENANT, () =>
      service.settleSale(sale.id, OPERATOR, { method: 'CARD', amountMinor: 2800 }, 'cle-part-2'),
    );

    expect(settlements.payments).toHaveLength(2);
  });

  it('la même clé sur deux tickets décrit deux opérations, pas un rejeu', async () => {
    // La portée de la clé est le **ticket** : rendre à la seconde vente le
    // règlement de la première l'aurait soldée par l'encaissement d'une autre.
    const settlements = new FakeSettlementRepository();
    const service = serviceWith(settlements);
    const first = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: 5000 });
    const second = settlements.seedSale({ tenantId: TENANT, totalAmountMinor: 5000 });

    const one = await runWithTenant(TENANT, () =>
      service.settleSale(first.id, OPERATOR, { method: 'CARD' }, 'cle-partagee'),
    );
    const two = await runWithTenant(TENANT, () =>
      service.settleSale(second.id, OPERATOR, { method: 'CARD' }, 'cle-partagee'),
    );

    expect(two.replayed).toBe(false);
    expect(two.payment.id).not.toBe(one.payment.id);
    expect(settlements.payments).toHaveLength(2);
  });
});
