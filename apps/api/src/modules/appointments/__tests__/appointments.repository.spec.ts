import { Prisma } from '@prisma/client';

import { runWithTenant } from '../../../common/tenant/tenant-context';
import type { ScopedPrismaClient } from '../../../infrastructure/database/prisma-clients';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import { AppointmentsRepository } from '../appointments.repository';
import type { AppointmentDraft } from '../appointments.types';

/**
 * Conduite du repository **face à l'échec** — la seule partie de `create` qui se
 * teste sans base.
 *
 * Ce que cette suite ne prouve pas, et ne peut pas prouver : que la contrainte
 * existe, qu'elle refuse un chevauchement, qu'une course produit exactement un
 * gagnant. Tout cela est de l'atomicité de PostgreSQL, et se prouve contre lui
 * seul — `test/appointments-exclusion.integration-spec.ts`.
 *
 * Ce qu'elle prouve, et que le test d'intégration ne montrerait que par
 * intermittence : le **nombre** de tentatives et la classe d'erreur finale. Un
 * réessai qui se déclencherait sur un créneau pris, ou une boucle qui ne
 * s'arrêterait jamais, ne se voit pas dans un test qui dépend de
 * l'ordonnancement.
 */

const DRAFT: AppointmentDraft = {
  clientId: '11111111-1111-4111-8111-111111111111',
  staffId: '22222222-2222-4222-8222-222222222222',
  serviceId: '33333333-3333-4333-8333-333333333333',
  startsAt: new Date('2026-09-01T09:00:00.000Z'),
  endsAt: new Date('2026-09-01T10:00:00.000Z'),
  price: { amountMinor: 3500, currency: 'EUR' },
  clientNote: null,
};

const ROW = {
  id: '44444444-4444-4444-8444-444444444444',
  clientId: DRAFT.clientId,
  staffId: DRAFT.staffId,
  serviceId: DRAFT.serviceId,
  startsAt: DRAFT.startsAt,
  endsAt: DRAFT.endsAt,
  status: 'PENDING' as const,
  priceAmountMinor: 3500,
  priceCurrency: 'EUR',
  clientNote: null,
};

function deadlock(): Error {
  return new Prisma.PrismaClientUnknownRequestError(
    'PostgresError { code: "40P01", message: "deadlock detected" }',
    { clientVersion: '6.12.0' },
  );
}

function slotTaken(): Error {
  return new Prisma.PrismaClientUnknownRequestError(
    'PostgresError { code: "23P01", message: "conflicting key value violates exclusion ' +
      'constraint \\"appointments_no_overlap\\"" }',
    { clientVersion: '6.12.0' },
  );
}

/** L'établissement courant — le repository dérive de lui la clé de son verrou. */
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

interface Double {
  readonly prisma: ScopedPrismaClient;
  /** Nombre d'insertions tentées. */
  calls(): number;
  /** Le SQL brut émis, dans l'ordre — c'est là que le verrou se voit. */
  rawSql(): string[];
  /** Les paramètres liés du SQL brut, dans l'ordre. */
  rawValues(): unknown[];
  /** L'ordre des opérations, verrou et insertion confondus. */
  order(): string[];
}

/**
 * Le client scopé, réduit à ce que le repository en appelle.
 *
 * Un double et non un mock de module : ce qui compte est la **suite** des
 * réponses, et une file d'attente la dit plus clairement qu'un empilement de
 * `mockRejectedValueOnce`.
 */
function clientAnswering(...answers: (Error | typeof ROW)[]): Double {
  let index = 0;
  const order: string[] = [];
  const sql: string[] = [];
  const values: unknown[] = [];

  const create = jest.fn(async () => {
    order.push('insert');
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  });

  const executeRaw = jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    order.push('lock');
    sql.push(strings.join('?'));
    values.push(...bound);
    return 1;
  });

  const tx = { $executeRaw: executeRaw, appointment: { create } };
  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as ScopedPrismaClient;

  return {
    prisma,
    calls: () => create.mock.calls.length,
    rawSql: () => sql,
    rawValues: () => values,
    order: () => order,
  };
}

/** Le repository, exercé dans une portée de tenant — comme en production. */
async function createAppointment(prisma: ScopedPrismaClient): Promise<unknown> {
  return runWithTenant(TENANT_ID, async () => new AppointmentsRepository(prisma).create(DRAFT));
}

describe('AppointmentsRepository.create — sérialisation par praticien', () => {
  it('prend un verrou consultatif de transaction avant d’insérer', async () => {
    // L'ordre est tout : un verrou pris après l'insertion ne sérialise rien, et
    // le cycle d'attente qui produit les interblocages se reformerait.
    const double = clientAnswering(ROW);

    await createAppointment(double.prisma);

    expect(double.order()).toEqual(['lock', 'insert']);
    expect(double.rawSql()[0]).toContain('pg_advisory_xact_lock');
  });

  it('clé le verrou sur l’établissement **et** le praticien', async () => {
    // Une clé qui ne porterait que le praticien fonctionnerait aujourd'hui et
    // collisionnerait le jour où deux portées se partagent l'espace de clés.
    const double = clientAnswering(ROW);

    await createAppointment(double.prisma);

    expect(double.rawValues()).toEqual([
      `appointments:tenant_id=${TENANT_ID}:staff_id=${DRAFT.staffId}`,
    ]);
  });

  it('n’interpole jamais la clé dans le texte du SQL', async () => {
    // Elle part en paramètre lié : une clé concaténée serait une injection SQL
    // pilotée par l'identifiant de praticien reçu de l'appelant.
    const double = clientAnswering(ROW);

    await createAppointment(double.prisma);

    expect(double.rawSql()[0]).not.toContain(TENANT_ID);
    expect(double.rawSql()[0]).not.toContain(DRAFT.staffId);
  });
});

describe('AppointmentsRepository.create — conduite face à l’échec', () => {
  it('n’insère qu’une fois quand la base accepte', async () => {
    const double = clientAnswering(ROW);

    await expect(createAppointment(double.prisma)).resolves.toMatchObject({
      id: ROW.id,
      status: 'PENDING',
      price: { amountMinor: 3500, currency: 'EUR' },
    });
    expect(double.calls()).toBe(1);
  });

  it('traduit un créneau pris en `SlotNoLongerAvailableError`, sans réessayer', async () => {
    // Réessayer un refus définitif ne ferait que retarder la même réponse, en
    // tenant une connexion de plus pendant ce temps.
    const double = clientAnswering(slotTaken());

    await expect(createAppointment(double.prisma)).rejects.toBeInstanceOf(
      SlotNoLongerAvailableError,
    );
    expect(double.calls()).toBe(1);
  });

  it('réessaie un interblocage et rend le rendez-vous obtenu au second essai', async () => {
    // Le verrou consultatif rend l'interblocage improbable sur ce chemin, pas
    // impossible : une écriture concurrente venue d'ailleurs — un changement de
    // statut, un report — n'y passe pas. Le filet reste donc utile.
    const double = clientAnswering(deadlock(), ROW);

    await expect(createAppointment(double.prisma)).resolves.toMatchObject({ id: ROW.id });
    expect(double.calls()).toBe(2);
  });

  it('conclut au créneau pris si le réessai bute sur la contrainte', async () => {
    const double = clientAnswering(deadlock(), slotTaken());

    await expect(createAppointment(double.prisma)).rejects.toBeInstanceOf(
      SlotNoLongerAvailableError,
    );
    expect(double.calls()).toBe(2);
  });

  it('cesse de réessayer au bout de trois tentatives, et ne maquille pas l’échec', async () => {
    // Trois interblocages d'affilée ne sont plus une course, c'est une
    // contention : le dire en 500 vaut mieux que d'annoncer « créneau pris » sur
    // un créneau peut-être libre, et de boucler indéfiniment.
    const double = clientAnswering(deadlock());

    await expect(createAppointment(double.prisma)).rejects.not.toBeInstanceOf(
      SlotNoLongerAvailableError,
    );
    expect(double.calls()).toBe(3);
  });

  it('laisse remonter telle quelle une erreur qui n’est ni l’un ni l’autre', async () => {
    const boom = new Error('Connection refused');
    const double = clientAnswering(boom);

    await expect(createAppointment(double.prisma)).rejects.toBe(boom);
    expect(double.calls()).toBe(1);
  });
});
