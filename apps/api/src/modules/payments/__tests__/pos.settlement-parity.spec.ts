import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import type { ServicesService } from '../../catalog/services.service';
import type { PosRepository } from '../pos.repository';
import { SalesService } from '../sales.service';
import { FakePosRepository, FakeServicesService } from './pos.doubles';

/**
 * **Un rendez-vous, un prix** — quatrième critère de #816.
 *
 * Le constat de l'issue tenait en deux chiffres : le même soin, annoncé 65,00 €,
 * s'inscrivait 78,00 € sur le ticket de caisse et 65,00 € sur l'encaissement au
 * comptoir. Deux chemins d'encaissement, deux prix pour la même prestation —
 * et aucun test ne les confrontait, parce qu'ils vivent dans deux services
 * distincts qui n'ont aucune raison de se connaître.
 *
 * C'est exactement ce que cette suite fait : elle monte les deux compositions
 * sur le **même rendez-vous**, au **même prix de catalogue**, et vérifie
 * qu'elles s'accordent au centime. Elle n'aurait pas passé avant #816.
 *
 * ## Ce que #817 a changé, et ce que la suite continue de prouver
 *
 * Il n'y a plus **deux écritures** à confronter : encaisser un rendez-vous
 * revient à composer sa vente puis à la régler, et l'encaissement porte le
 * total de cette vente-là. La divergence de #816 est donc devenue
 * structurellement impossible — ce qui n'est une bonne nouvelle que tant que la
 * composition du rendez-vous et celle du comptoir donnent le même total.
 *
 * C'est cela que la suite mesure désormais : `composeForAppointment` — qui part
 * du **prix figé à la réservation** — et `open` — qui part du **prix du
 * catalogue** — doivent tomber sur le même montant lorsque les deux prix sont
 * les mêmes, à tout taux et dans une devise sans sous-unité. Si l'une des deux
 * se remettait à ajouter la taxe au lieu de l'extraire, l'écart reparaîtrait
 * ici avant d'atteindre une caisse.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CASHIER = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '44444444-4444-4444-8444-444444444444';

/** Le soin du constat : 65,00 € annoncés dans le tunnel. */
const CATALOG_PRICE_MINOR = 6500;

describe('parité entre l’encaissement d’un rendez-vous et le total de sa vente', () => {
  const inTenant = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT, fn);

  /**
   * Monte les deux chemins sur un rendez-vous commun et rend les deux montants.
   *
   * Le prix du rendez-vous est **celui du catalogue** : c'est ce que le tunnel
   * fige à la réservation, et c'est ce que le comptoir relit pour encaisser.
   */
  const settleAndSell = async (
    taxRateBps: number,
    currency = 'EUR',
  ): Promise<{ settled: number; sold: number }> => {
    const appointmentId = randomUUID();

    const pos = new FakePosRepository();
    pos.seedTenant({ tenantId: TENANT, defaultCurrency: currency, taxRateBps });
    pos.seedAppointment({ tenantId: TENANT, id: appointmentId });

    const catalog = new FakeServicesService();
    const prestation = catalog.seedService({
      tenantId: TENANT,
      name: 'Soin éclat 45 min',
      amountMinor: CATALOG_PRICE_MINOR,
      currency,
    });

    const sales = new SalesService(
      pos as unknown as PosRepository,
      catalog as unknown as ServicesService,
    );

    const sale = await inTenant(() =>
      sales.open(
        { appointmentId, lines: [{ kind: 'SERVICE', serviceId: prestation.id, quantity: 1 }] },
        CASHIER,
      ),
    );

    // L'autre composition : celle que le règlement d'un rendez-vous emploie.
    // Elle part du prix **figé à la réservation**, que le tunnel a recopié du
    // catalogue — donc du même montant.
    const draft = await inTenant(() =>
      sales.composeForAppointment(
        {
          id: appointmentId,
          status: 'COMPLETED',
          serviceId: prestation.id,
          clientId: OPERATOR,
          price: { amountMinor: CATALOG_PRICE_MINOR, currency },
        },
        [],
        OPERATOR,
      ),
    );

    return { settled: draft.totalAmountMinor, sold: sale.total.amountMinor };
  };

  it('compose exactement le total du ticket, taxe comprise', async () => {
    const { settled, sold } = await settleAndSell(2000);

    expect(sold).toBe(CATALOG_PRICE_MINOR);
    expect(settled).toBe(sold);
  });

  it('s’accorde quel que soit le taux de l’établissement', async () => {
    // C'est la propriété, et non l'exemple, qui protège de la régression : le
    // total d'un ticket ne doit plus dépendre du taux du tout.
    for (const taxRateBps of [0, 550, 2000, 2100, 10_000]) {
      const { settled, sold } = await settleAndSell(taxRateBps);

      expect({ taxRateBps, sold }).toEqual({ taxRateBps, sold: CATALOG_PRICE_MINOR });
      expect(settled).toBe(sold);
    }
  });

  it('s’accorde dans une devise sans sous-unité', async () => {
    // MGA : l'arrondi se fait à l'unité de la devise, et la parité doit tenir
    // là aussi (points d'attention de #816).
    const { settled, sold } = await settleAndSell(2000, 'MGA');

    expect(settled).toBe(sold);
  });
});
