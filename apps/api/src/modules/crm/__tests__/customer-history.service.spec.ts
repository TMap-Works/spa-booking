import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { CustomerHistoryService, singleCurrencyTotal } from '../customer-history.service';
import { FakeCrmRepository } from './crm.doubles';

/**
 * L'historique agrégé — troisième critère de #56.
 *
 * Deux propriétés portent tout le reste, et elles sont indépendantes :
 *
 * 1. **l'agrégat porte sur la totalité, la liste sur une fenêtre.** Un compteur
 *    calculé sur les cinquante lignes rendues mentirait dès la cinquante et
 *    unième — et il le ferait en silence, ce qui est le pire mode de défaillance
 *    pour un chiffre affiché à un commerçant ;
 * 2. **le total dépensé ne mélange jamais deux devises.** Additionner des
 *    entiers dont les codes diffèrent produit un nombre plausible et faux.
 */

const TENANT = randomUUID();
const VOISIN = randomUUID();

async function chez<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, run);
}

function build(): { service: CustomerHistoryService; repository: FakeCrmRepository } {
  const repository = new FakeCrmRepository();
  return { service: new CustomerHistoryService(repository.asRepository()), repository };
}

describe('historique d’une fiche', () => {
  it('compte par statut, borne les visites honorées et somme leur prix', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'COMPLETED',
      startsAt: new Date('2026-01-10T09:00:00.000Z'),
      priceAmountMinor: 3500,
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'COMPLETED',
      startsAt: new Date('2026-06-10T09:00:00.000Z'),
      priceAmountMinor: 4500,
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'CANCELLED',
      startsAt: new Date('2026-07-10T09:00:00.000Z'),
      priceAmountMinor: 9900,
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'NO_SHOW',
      startsAt: new Date('2026-07-20T09:00:00.000Z'),
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'CONFIRMED',
      startsAt: new Date('2026-12-01T09:00:00.000Z'),
      priceAmountMinor: 5000,
    });

    const { summary } = await chez(TENANT, () => service.byCustomerId(fiche.id, 50));

    expect(summary).toEqual({
      totalVisits: 5,
      honoredVisits: 2,
      cancelledVisits: 1,
      noShowVisits: 1,
      upcomingVisits: 1,
      // Les bornes ne comptent que les visites **honorées** : un rendez-vous à
      // venir décalerait « la dernière visite » dans le futur, et une annulation
      // ferait remonter la première à une venue qui n'a pas eu lieu.
      firstVisitAt: new Date('2026-01-10T09:00:00.000Z'),
      lastVisitAt: new Date('2026-06-10T09:00:00.000Z'),
      // 3500 + 4500 : ni l'annulation à 9900, ni le rendez-vous à venir à 5000.
      totalSpentAmountMinor: 8000,
      totalSpentCurrency: 'EUR',
    });
  });

  it('rend un agrégat vide sans inventer un total à zéro', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    const { summary, visits } = await chez(TENANT, () => service.byCustomerId(fiche.id, 50));

    expect(visits).toEqual([]);
    expect({
      total: summary.totalVisits,
      montant: summary.totalSpentAmountMinor,
      devise: summary.totalSpentCurrency,
      premiere: summary.firstVisitAt,
    }).toEqual({ total: 0, montant: null, devise: null, premiere: null });
  });

  it('borne la liste sans borner l’agrégat', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    for (let index = 0; index < 12; index += 1) {
      repository.addVisit({
        tenantId: TENANT,
        clientId: fiche.id,
        status: 'COMPLETED',
        startsAt: new Date(Date.UTC(2026, 0, index + 1, 9)),
        priceAmountMinor: 1000,
      });
    }

    const { summary, visits } = await chez(TENANT, () => service.byCustomerId(fiche.id, 3));

    expect(visits).toHaveLength(3);
    // La propriété centrale : douze visites comptées, trois montrées.
    expect({ total: summary.totalVisits, somme: summary.totalSpentAmountMinor }).toEqual({
      total: 12,
      somme: 12_000,
    });
  });

  it('rend les visites de la plus récente à la plus ancienne', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: new Date('2026-01-01T09:00:00.000Z'),
      serviceName: 'ancienne',
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: new Date('2026-06-01T09:00:00.000Z'),
      serviceName: 'récente',
    });

    const { visits } = await chez(TENANT, () => service.byCustomerId(fiche.id, 50));

    expect(visits.map((visit) => visit.serviceName)).toEqual(['récente', 'ancienne']);
  });

  it('décline le total quand la fiche porte deux devises', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'COMPLETED',
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      status: 'COMPLETED',
      startsAt: new Date('2026-02-01T09:00:00.000Z'),
      priceAmountMinor: 120_000,
      priceCurrency: 'MGA',
    });

    const { summary } = await chez(TENANT, () => service.byCustomerId(fiche.id, 50));

    // Les visites sont comptées — elles ont bien eu lieu —, seul le total se
    // tait. Un `123500` sans devise serait plausible et faux.
    expect({
      honorees: summary.honoredVisits,
      montant: summary.totalSpentAmountMinor,
      devise: summary.totalSpentCurrency,
    }).toEqual({ honorees: 2, montant: null, devise: null });
  });
});

describe('frontière du tenant', () => {
  it('rend 404 sur la fiche du voisin plutôt qu’un historique vide en 200', async () => {
    const { service, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT });
    repository.addVisit({ tenantId: TENANT, clientId: chezA.id });

    // Sans la relecture préalable de la fiche, cet appel rendrait un agrégat
    // vide en 200 — indiscernable de celui d'une cliente jamais venue.
    await expect(chez(VOISIN, () => service.byCustomerId(chezA.id, 50))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('ne compte pas les visites d’un autre établissement pour un même identifiant', async () => {
    const { service, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT });
    repository.addVisit({ tenantId: TENANT, clientId: chezA.id, serviceName: 'chez A' });
    // La ligne croisée que les clés étrangères composites interdisent en base —
    // fabriquée ici pour vérifier que la projection ne la ramasse pas.
    repository.addVisit({ tenantId: VOISIN, clientId: chezA.id, serviceName: 'chez B' });

    const { summary, visits } = await chez(TENANT, () => service.byCustomerId(chezA.id, 50));

    expect(summary.totalVisits).toBe(1);
    expect(JSON.stringify(visits)).not.toContain('chez B');
  });

  it('rend 404 sur un compte du personnel', async () => {
    const { service, repository } = build();
    const praticienne = repository.addCustomer({ tenantId: TENANT, role: 'STAFF' });

    await expect(
      chez(TENANT, () => service.byCustomerId(praticienne.id, 50)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('singleCurrencyTotal', () => {
  it('rend null sans visite honorée, le total sur une devise, null sur deux', () => {
    expect(singleCurrencyTotal([])).toBeNull();
    expect(singleCurrencyTotal([{ currency: 'EUR', amountMinor: 8000 }])).toEqual({
      currency: 'EUR',
      amountMinor: 8000,
    });
    expect(
      singleCurrencyTotal([
        { currency: 'EUR', amountMinor: 3500 },
        { currency: 'MGA', amountMinor: 120_000 },
      ]),
    ).toBeNull();
  });
});
