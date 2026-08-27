import { Prisma } from '@prisma/client';

import { ConflictError, InvalidStateTransitionError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import type { ScopedPrismaClient } from '../../../infrastructure/database/prisma-clients';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import { AppointmentsRepository } from '../appointments.repository';
import type { AppointmentDraft, RescheduleDraft } from '../appointments.types';

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
  rescheduledFromId: null,
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

/**
 * Le report, vu de la seule chose qui se teste sans base : **l'ordre des
 * opérations et la forme des écritures** (#39).
 *
 * L'atomicité, elle, appartient à PostgreSQL — c'est le `ROLLBACK` qui rend
 * l'échec inoffensif, et `test/appointments-exclusion.integration-spec.ts` le
 * prouve contre un vrai moteur. Ce qui se prouve ici est ce qu'un test contre la
 * base ne montrerait que par intermittence : que l'annulation **précède**
 * l'insertion, que l'écriture est conditionnée au statut, et que rien de la
 * demande ne franchit la frontière de ce qui doit être recopié.
 */

/** Le rendez-vous à déplacer, tel que la base le rend — confirmé, avec une note. */
const PREVIOUS_ROW = {
  ...ROW,
  id: '66666666-6666-4666-8666-666666666666',
  status: 'CONFIRMED' as const,
  clientNote: 'allergie aux huiles essentielles',
};

/** Le nouveau créneau, chez un **autre** praticien. */
const MOVE: RescheduleDraft = {
  previousId: PREVIOUS_ROW.id,
  staffId: '77777777-7777-4777-8777-777777777777',
  startsAt: new Date('2026-09-02T09:00:00.000Z'),
  endsAt: new Date('2026-09-02T10:00:00.000Z'),
};

interface MovingDouble {
  readonly prisma: ScopedPrismaClient;
  order(): string[];
  rawValues(): unknown[];
  updateArgs(): { where?: unknown; data?: unknown }[];
  createData(): Record<string, unknown>[];
}

/**
 * Le client scopé pour un report, réduit à ce que `reschedule` en appelle.
 *
 * `released` est le compte que rend l'écriture conditionnelle : `1` quand elle a
 * bien annulé le rendez-vous, `0` quand la ligne n'était plus dans un statut
 * occupant au moment où le moteur l'a relue — c'est-à-dire quand un autre report
 * a gagné la course.
 */
function movingClient(
  options: {
    previous?: typeof PREVIOUS_ROW | null;
    released?: number;
    inserts?: (Error | typeof ROW)[];
  } = {},
): MovingDouble {
  const order: string[] = [];
  const values: unknown[] = [];
  const updates: { where?: unknown; data?: unknown }[] = [];
  const creates: Record<string, unknown>[] = [];
  const inserts = options.inserts ?? [ROW];
  let index = 0;

  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      order.push('lock');
      values.push(...bound);
      return 1;
    }),
    appointment: {
      findFirst: jest.fn(async () => {
        order.push('read');
        return options.previous === undefined ? PREVIOUS_ROW : options.previous;
      }),
      updateMany: jest.fn(async (args: { where?: unknown; data?: unknown }) => {
        order.push('update');
        updates.push(args);
        return { count: options.released ?? 1 };
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('insert');
        creates.push(args.data);
        const answer = inserts[Math.min(index, inserts.length - 1)];
        index += 1;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      }),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as ScopedPrismaClient;

  return {
    prisma,
    order: () => order,
    rawValues: () => values,
    updateArgs: () => updates,
    createData: () => creates,
  };
}

/** Le report, exercé dans une portée de tenant — comme en production. */
async function reschedule(prisma: ScopedPrismaClient): Promise<unknown> {
  return runWithTenant(TENANT_ID, async () => new AppointmentsRepository(prisma).reschedule(MOVE));
}

describe('AppointmentsRepository.reschedule — annulation puis création', () => {
  it('lit, annule, puis insère — dans cet ordre, sous le verrou de l’agenda d’arrivée', async () => {
    const double = movingClient();

    await reschedule(double.prisma);

    // L'ordre est tout : insérer avant d'annuler ferait juger le nouveau créneau
    // contre l'ancien, et la contrainte refuserait un déplacement légitime.
    expect(double.order()).toEqual(['lock', 'read', 'update', 'insert']);
  });

  it('sérialise sur l’agenda d’arrivée, pas sur celui de départ', async () => {
    // C'est là que l'insertion aura lieu. Prendre les deux verrous dans un ordre
    // dicté par les données reformerait le cycle d'attente qu'ils suppriment.
    const double = movingClient();

    await reschedule(double.prisma);

    expect(double.rawValues()).toEqual([
      `appointments:tenant_id=${TENANT_ID}:staff_id=${MOVE.staffId}`,
    ]);
  });

  it('conditionne l’annulation au statut, plutôt que de vérifier avant d’écrire', async () => {
    const double = movingClient();

    await reschedule(double.prisma);

    expect(double.updateArgs()).toEqual([
      {
        where: { id: PREVIOUS_ROW.id, status: { in: ['PENDING', 'CONFIRMED'] } },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      },
    ]);
  });

  it('recopie cliente, prestation, prix, note et statut depuis la ligne relue', async () => {
    const double = movingClient();

    await reschedule(double.prisma);

    expect(double.createData()[0]).toEqual({
      clientId: PREVIOUS_ROW.clientId,
      serviceId: PREVIOUS_ROW.serviceId,
      priceAmountMinor: PREVIOUS_ROW.priceAmountMinor,
      priceCurrency: PREVIOUS_ROW.priceCurrency,
      clientNote: PREVIOUS_ROW.clientNote,
      // Repris, et non remis à `PENDING` : déplacer un créneau n'annule pas une
      // confirmation déjà obtenue.
      status: 'CONFIRMED',
      staffId: MOVE.staffId,
      startsAt: MOVE.startsAt,
      endsAt: MOVE.endsAt,
      rescheduledFromId: PREVIOUS_ROW.id,
    });
  });

  it('rend l’ancien rendez-vous tel qu’il était, et le nouveau tel qu’il est', async () => {
    const double = movingClient();

    await expect(reschedule(double.prisma)).resolves.toMatchObject({
      previous: { id: PREVIOUS_ROW.id, status: 'CONFIRMED' },
      created: { id: ROW.id, rescheduledFromId: null },
    });
  });

  it('refuse en 404 un rendez-vous introuvable, sans rien écrire', async () => {
    // `findFirst` est scopé par l'extension : le rendez-vous d'un autre
    // établissement est introuvable, et rend donc 404 plutôt qu'un 403 qui
    // confirmerait son existence.
    const double = movingClient({ previous: null });

    await expect(reschedule(double.prisma)).rejects.toBeInstanceOf(NotFoundError);
    expect(double.order()).toEqual(['lock', 'read']);
  });

  it('refuse en 422 un rendez-vous qui n’occupe plus son créneau', async () => {
    const double = movingClient({ previous: { ...PREVIOUS_ROW, status: 'COMPLETED' as never } });

    await expect(reschedule(double.prisma)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(double.order()).toEqual(['lock', 'read']);
  });

  it('refuse en 409 quand l’écriture conditionnelle ne touche aucune ligne', async () => {
    // Deux reports concurrents du même rendez-vous : le second relit la ligne
    // après la validation du premier, ne la reconnaît plus, et met à jour zéro
    // ligne. Insérer quand même donnerait deux successeurs à un seul rendez-vous.
    const double = movingClient({ released: 0 });

    await expect(reschedule(double.prisma)).rejects.toBeInstanceOf(ConflictError);
    expect(double.order()).toEqual(['lock', 'read', 'update']);
  });

  it('traduit un créneau d’arrivée pris en `SlotNoLongerAvailableError`', async () => {
    const double = movingClient({ inserts: [slotTaken()] });

    await expect(reschedule(double.prisma)).rejects.toBeInstanceOf(SlotNoLongerAvailableError);
  });

  it('rejoue la transaction entière sur interblocage', async () => {
    // Le réessai reprend au verrou : la transaction a été annulée, donc la
    // lecture aussi. Reprendre à l'insertion écrirait sur la foi d'une ligne lue
    // dans une transaction qui n'existe plus.
    const double = movingClient({ inserts: [deadlock(), ROW] });

    await expect(reschedule(double.prisma)).resolves.toMatchObject({ created: { id: ROW.id } });
    expect(double.order()).toEqual([
      'lock',
      'read',
      'update',
      'insert',
      'lock',
      'read',
      'update',
      'insert',
    ]);
  });
});
