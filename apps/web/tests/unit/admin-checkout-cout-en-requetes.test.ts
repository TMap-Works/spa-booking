import type { PaymentStatus } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchAppointmentSales = vi.fn();
const fetchPayments = vi.fn();

vi.mock('@/lib/api-client', () => ({
  fetchAppointmentSales: (...args: unknown[]) => fetchAppointmentSales(...args),
  fetchPayments: (...args: unknown[]) => fetchPayments(...args),
}));

const { readDayTickets } = await import(
  '@/app/(admin)/[tenantSlug]/admin/encaissement/settlements'
);

/**
 * Le coût en requêtes de la pastille à trois états — #1240, premier critère :
 * « le coût est **mesuré et tenu** ».
 *
 * ## Ce que ce fichier mesure, et pourquoi il le mesure ici
 *
 * Le badge ne peut pas dire vrai sans le reste dû du ticket, et le reste dû
 * n'est servi que par `GET /sales`. Il y avait donc un appel à ajouter, et
 * l'issue le disait — « N requêtes de plus […] c'est un choix de conception ».
 * Ce qui rend le choix tenable n'est pas une intention, c'est un compte : les
 * assertions ci-dessous sont ce compte, et elles échoueront le jour où
 * quelqu'un ajoutera une lecture par **ligne de la liste**.
 *
 * ## Le compte, journée d'un salon à l'appui
 *
 * | État de la journée | Lectures de tickets |
 * |---|---|
 * | rien d'encaissé — l'ouverture | **0** |
 * | quelques prestations réglées | autant qu'elles, et pas une de plus |
 * | un rendez-vous ouvert à l'écran | **0** — la page ne l'appelle pas |
 * | plus de 32 réglées | **0**, et la colonne se tait |
 *
 * La page fait par ailleurs trois lectures fixes — la vitrine, l'agenda du jour,
 * les encaissements du jour. La pastille en ajoute donc entre zéro et une par
 * prestation **déjà réglée**, jamais par rendez-vous affiché.
 */

const TOKEN = 'jeton-de-comptoir';

/** Une ligne d'encaissement du jour, rattachée à son rendez-vous. */
function payment(appointmentId: string | null, status: PaymentStatus = 'succeeded') {
  return {
    id: `ffffffff-0000-4000-8000-${String(appointmentId ?? 'x').slice(-12)}`,
    appointmentId,
    saleId: '99999999-0000-4000-8000-000000000009',
    amount: { amountMinor: 5000, currency: 'EUR' },
    refunded: { amountMinor: 0, currency: 'EUR' },
    method: 'cash' as const,
    status,
    capturedAt: '2026-09-04T08:45:00.000Z',
    createdAt: '2026-09-04T08:45:00.000Z',
  };
}

/** Un ticket dont il reste `remainingMinor` à prendre. */
function sale(appointmentId: string, remainingMinor: number) {
  return {
    id: `dddddddd-0000-4000-8000-${String(appointmentId).slice(-12)}`,
    appointmentId,
    cashierUserId: 'cccccccc-0000-4000-8000-000000000003',
    subtotal: { amountMinor: 7800, currency: 'EUR' },
    tax: { amountMinor: 0, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 7800, currency: 'EUR' },
    settled: { amountMinor: 7800 - remainingMinor, currency: 'EUR' },
    remaining: { amountMinor: remainingMinor, currency: 'EUR' },
    settledAt: remainingMinor === 0 ? '2026-09-04T09:10:00.000Z' : null,
    createdAt: '2026-09-04T08:45:00.000Z',
  };
}

/** `n` identifiants de rendez-vous distincts, de la forme d'un UUID v4. */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, index) =>
    `aaaaaaaa-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
}

/**
 * Le périmètre affiché — assez large pour ne rien écarter par accident.
 *
 * Il est passé explicitement parce que la lecture **doit** l'exiger : la fenêtre
 * de caisse couvre trois journées (`readDaySettlements`), et les rendez-vous des
 * deux voisines n'ont ni ligne à l'écran ni ticket à relire. La journée hors
 * périmètre a son propre test, plus bas.
 */
const ALL = new Set(ids(64));

afterEach(() => {
  fetchAppointmentSales.mockReset();
  fetchPayments.mockReset();
});

describe('le coût en requêtes du reste dû de la journée', () => {
  it('n’appelle personne sur une journée dont rien n’est encore encaissé', async () => {
    await expect(readDayTickets(TOKEN, [], ALL)).resolves.toEqual(new Map());

    expect(fetchAppointmentSales).not.toHaveBeenCalled();
  });

  it('n’appelle personne quand l’historique lui-même est inconnu', async () => {
    // `GET /payments` est au seuil `MANAGER` : un comptoir tenu par un compte
    // `STAFF` reçoit un 403, et la colonne est tue de toute façon.
    await expect(readDayTickets(TOKEN, null, ALL)).resolves.toBeNull();

    expect(fetchAppointmentSales).not.toHaveBeenCalled();
  });

  it('ne lit un ticket que par prestation **déjà réglée**', async () => {
    const [premier, deuxieme, troisieme] = ids(3);

    fetchAppointmentSales.mockImplementation(async (_token: string, appointmentId: string) => [
      sale(appointmentId, 2800),
    ]);

    const tickets = await readDayTickets(TOKEN, [
      payment(premier ?? ''),
      payment(deuxieme ?? '', 'pending'),
      payment(troisieme ?? '', 'failed'),
      // Une vente retail : aucun rendez-vous, donc aucune pastille à démentir.
      payment(null),
    ], ALL);

    // Un seul des quatre encaissements est abouti : un seul ticket est lu.
    expect(fetchAppointmentSales).toHaveBeenCalledTimes(1);
    expect(tickets?.size).toBe(1);
    expect(tickets?.get(premier ?? '')?.remaining.amountMinor).toBe(2800);
  });

  it('ne compte qu’une lecture par rendez-vous, règlement mixte compris', async () => {
    const [seul] = ids(1);

    fetchAppointmentSales.mockResolvedValue([sale(seul ?? '', 0)]);

    // 50,00 € d'espèces puis 28,00 € au terminal : deux lignes, un rendez-vous.
    await readDayTickets(TOKEN, [payment(seul ?? ''), { ...payment(seul ?? ''), id: 'autre' }], ALL);

    expect(fetchAppointmentSales).toHaveBeenCalledTimes(1);
  });

  it('se tait au-delà du plafond, sans lire un seul ticket', async () => {
    // Trente-trois prestations réglées : la journée est d'un volume que cet écran
    // n'est pas l'outil pour relire, et affirmer « réglé » sans vérifier serait
    // exactement le défaut que ce ticket corrige.
    const payments = ids(33).map((id) => payment(id));

    await expect(readDayTickets(TOKEN, payments, ALL)).resolves.toBeNull();

    expect(fetchAppointmentSales).not.toHaveBeenCalled();
  });

  it('lit jusqu’au plafond, et d’un seul trait', async () => {
    fetchAppointmentSales.mockImplementation(async (_token: string, appointmentId: string) => [
      sale(appointmentId, 0),
    ]);

    const tickets = await readDayTickets(TOKEN, ids(32).map((id) => payment(id)), ALL);

    expect(fetchAppointmentSales).toHaveBeenCalledTimes(32);
    expect(tickets?.size).toBe(32);
  });

  it('rend « inconnu » plutôt qu’une journée à moitié lue', async () => {
    // Un refus au milieu du lot laisserait des rendez-vous sans ticket, donc des
    // pastilles qui diraient « réglé » faute de preuve. `null` tait la colonne.
    const [premier, deuxieme] = ids(2);

    fetchAppointmentSales.mockResolvedValueOnce([sale(premier ?? '', 0)]);
    fetchAppointmentSales.mockRejectedValueOnce(new Error('403'));

    await expect(
      readDayTickets(TOKEN, [payment(premier ?? ''), payment(deuxieme ?? '')], ALL),
    ).resolves.toBeNull();
  });

  it('retient le ticket qui doit encore, et non le premier venu', async () => {
    // Un rendez-vous peut porter une vente retail ajoutée après coup : c'est bien
    // « il reste à prendre » qu'il faut annoncer si l'une des deux n'est pas
    // soldée.
    const [seul] = ids(1);

    fetchAppointmentSales.mockResolvedValue([sale(seul ?? '', 0), sale(seul ?? '', 1500)]);

    const tickets = await readDayTickets(TOKEN, [payment(seul ?? '')], ALL);

    expect(tickets?.get(seul ?? '')?.remaining.amountMinor).toBe(1500);
  });

  it('ne relit rien des deux journées voisines que la liste n’affiche pas', async () => {
    // `readDaySettlements` lit **trois** journées — le filtre de `GET /payments`
    // porte sur l'ouverture de l'encaissement, pas sur le rendez-vous réglé. Les
    // rendez-vous de la veille et du lendemain n'ont donc ni ligne à l'écran ni
    // pastille à démentir : les relire serait une requête pour rien.
    const [affiche, veille, lendemain] = ids(3);

    fetchAppointmentSales.mockImplementation(async (_token: string, appointmentId: string) => [
      sale(appointmentId, 2800),
    ]);

    const tickets = await readDayTickets(
      TOKEN,
      [payment(affiche ?? ''), payment(veille ?? ''), payment(lendemain ?? '')],
      new Set([affiche ?? '']),
    );

    expect(fetchAppointmentSales).toHaveBeenCalledTimes(1);
    expect(tickets?.size).toBe(1);
  });

  it('ne fait pas franchir le plafond à une journée par ses voisines', async () => {
    // Le défaut concret : une veille chargée — vingt prestations réglées — et une
    // journée qui n'en compte que quinze. Les trente-cinq lignes de la fenêtre
    // dépassaient le plafond, et la colonne disparaissait d'une journée qui,
    // à elle, tenait largement dedans.
    const journee = ids(35).slice(20);

    fetchAppointmentSales.mockImplementation(async (_token: string, appointmentId: string) => [
      sale(appointmentId, 0),
    ]);

    const tickets = await readDayTickets(
      TOKEN,
      ids(35).map((id) => payment(id)),
      new Set(journee),
    );

    expect(tickets?.size).toBe(15);
    expect(fetchAppointmentSales).toHaveBeenCalledTimes(15);
  });
});
