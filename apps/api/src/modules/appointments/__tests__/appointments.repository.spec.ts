import { Prisma } from '@prisma/client';
import { APPOINTMENT_REFERENCE_PATTERN } from '@spa/shared';

import { ConflictError, InvalidStateTransitionError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import type { ScopedPrismaClient } from '../../../infrastructure/database/prisma-clients';
import type { ClientDirectoryService } from '../../crm/client-directory.service';
import { APPOINTMENT_REFERENCE_UNIQUE } from '../appointments.conflicts';
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
 * seul : `test/appointments-exclusion.integration-spec.ts` pour la contrainte et
 * son refus, `test/appointments-exclusion.concurrency-spec.ts` — jouée par la
 * cible `npm run test:concurrency` (#326) — pour la course.
 *
 * Ce qu'elle prouve, et que le test d'intégration ne montrerait que par
 * intermittence : le **nombre** de tentatives et la classe d'erreur finale. Un
 * réessai qui se déclencherait sur un créneau pris, ou une boucle qui ne
 * s'arrêterait jamais, ne se voit pas dans un test qui dépend de
 * l'ordonnancement.
 */

/** La fiche que la porte `crm` rend — celle que l'insertion doit désigner (#313). */
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

const DRAFT: AppointmentDraft = {
  // Une fiche **désignée**, la seule forme depuis #1222 : les deux surfaces —
  // tunnel public et comptoir — soumettent un identifiant que `crm` confirme
  // dans la transaction d'insertion (#465).
  client: { clientId: CLIENT_ID },
  staffId: '22222222-2222-4222-8222-222222222222',
  serviceId: '33333333-3333-4333-8333-333333333333',
  startsAt: new Date('2026-09-01T09:00:00.000Z'),
  endsAt: new Date('2026-09-01T10:00:00.000Z'),
  price: { amountMinor: 3500, currency: 'EUR' },
  clientNote: null,
  // Daté par le service, jamais par le repository (#790) : le brouillon porte
  // déjà l'instant, et l'insertion ne fait que l'écrire.
  dataConsentAt: new Date('2026-08-27T08:00:00.000Z'),
};

const ROW = {
  id: '44444444-4444-4444-8444-444444444444',
  // La référence citable, telle que la ligne la porte en base (#796) : elle est
  // **relue**, jamais recalculée, et une ligne mimée qui l'omettrait ferait
  // rendre `undefined` là où le domaine annonce une chaîne.
  reference: 'RDV-8F3K-27',
  clientId: CLIENT_ID,
  staffId: DRAFT.staffId,
  serviceId: DRAFT.serviceId,
  startsAt: DRAFT.startsAt,
  endsAt: DRAFT.endsAt,
  status: 'PENDING' as const,
  priceAmountMinor: 3500,
  priceCurrency: 'EUR',
  clientNote: null,
  rescheduledFromId: null,
  // Une ligne fraîchement insérée n'a aucune trace d'annulation. Les trois
  // colonnes sont présentes parce que `APPOINTMENT_SELECT` les demande : une
  // ligne mimée qui les omettrait ferait rendre `undefined` là où le domaine
  // annonce `null` (#40).
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
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

/** Le refus de l'unique `(tenant_id, reference)` — un tirage déjà pris (#796). */
function referenceTaken(): Error {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${APPOINTMENT_REFERENCE_UNIQUE}\`)`,
    {
      code: 'P2002',
      clientVersion: '6.12.0',
      meta: { modelName: 'Appointment', target: APPOINTMENT_REFERENCE_UNIQUE },
    },
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
  /** L'ordre des opérations — verrou, résolution de la fiche, insertion. */
  order(): string[];
  /** Les charges utiles d'insertion, pour lire le `clientId` effectivement écrit. */
  createData(): Record<string, unknown>[];
}

/**
 * La porte `crm`, réduite à ce que le repository en appelle (#313).
 *
 * Un double et non le vrai service : ce qui se prouve ici est la **place** de la
 * résolution dans la transaction et la conduite face à ses deux refus, jamais le
 * SQL qu'elle émet — celui-là s'exerce contre un vrai PostgreSQL
 * (`test/appointments-exclusion.integration-spec.ts`).
 *
 * `scopes` retient la portée reçue à chaque appel : c'est ce qui prouve que le
 * contrôle est fait **dans** la transaction, et non par un client à part.
 */
function directoryAnswering(
  options: {
    /** Les réponses successives — un identifiant, ou l'échec à lever. */
    answers?: (Error | string)[];
    /** Le journal d'ordre du double Prisma, quand la suite veut la place exacte. */
    order?: string[];
  } = {},
): {
  service: ClientDirectoryService;
  scopes(): unknown[];
  calls(): number;
  /** Les identifiants soumis au contrôle de la porte, dans l'ordre (#465). */
  asserted(): string[];
} {
  const answers = options.answers ?? [];
  let index = 0;
  const scopes: unknown[] = [];
  const asserted: string[] = [];

  const nextAnswer = (fallback: string): string => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? fallback;
    index += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };

  // Le seul battant de la porte depuis #1222 (#465) : il confirme la fiche que
  // l'appelant a désignée, et ne crée jamais rien.
  const assertBookableWithin = jest.fn(async (scope: unknown, clientId: string) => {
    options.order?.push('resolve');
    scopes.push(scope);
    asserted.push(clientId);
    return nextAnswer(clientId);
  });

  return {
    service: { assertBookableWithin } as unknown as ClientDirectoryService,
    scopes: () => scopes,
    calls: () => assertBookableWithin.mock.calls.length,
    asserted: () => asserted,
  };
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
  const creates: Record<string, unknown>[] = [];

  const create = jest.fn(async (args: { data: Record<string, unknown> }) => {
    order.push('insert');
    creates.push(args.data);
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
    createData: () => creates,
  };
}

/**
 * Le repository, exercé dans une portée de tenant — comme en production.
 *
 * La porte `crm` est passée en second : sans argument, elle rend toujours
 * `CLIENT_ID`, ce qui laisse les suites d'origine parler du seul créneau.
 */
async function createAppointment(
  prisma: ScopedPrismaClient,
  clients: ClientDirectoryService = directoryAnswering().service,
): Promise<unknown> {
  return runWithTenant(TENANT_ID, async () =>
    new AppointmentsRepository(prisma, clients).create(DRAFT),
  );
}

describe('AppointmentsRepository.create — sérialisation par praticien', () => {
  it('prend un verrou consultatif de transaction avant d’insérer', async () => {
    // L'ordre est tout : un verrou pris après l'insertion ne sérialise rien, et
    // le cycle d'attente qui produit les interblocages se reformerait. La fiche
    // cliente se résout entre les deux (#313) : après le verrou, parce qu'il
    // ordonne les candidates au créneau ; avant l'insertion, parce que
    // `appointments.client_id` est `NOT NULL`.
    const double = clientAnswering(ROW);
    const directory = directoryAnswering({ order: double.order() });

    await createAppointment(double.prisma, directory.service);

    expect(double.order()).toEqual(['lock', 'resolve', 'insert']);
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

  it('tire une référence citable à chaque insertion, et la retire après collision', async () => {
    // Le tirage est **dans** `insert`, et c'est ce qui rend le réessai utile :
    // une référence calculée à l'étage au-dessus se serait rejouée identique,
    // et les trois tentatives auraient buté sur la même valeur prise (#796).
    const double = clientAnswering(referenceTaken(), ROW);

    await expect(createAppointment(double.prisma)).resolves.toMatchObject({
      reference: ROW.reference,
    });
    expect(double.calls()).toBe(2);

    const [first, second] = double.createData();
    expect(first?.reference).toEqual(expect.stringMatching(APPOINTMENT_REFERENCE_PATTERN));
    expect(second?.reference).toEqual(expect.stringMatching(APPOINTMENT_REFERENCE_PATTERN));
    expect(first?.reference).not.toBe(second?.reference);
  });

  it('ne maquille pas une collision de référence en créneau pris', async () => {
    // Les deux refus n'ont rien à voir : l'un dit « ce créneau est pris »,
    // l'autre « ce tirage est à refaire ». Les confondre ferait renoncer à une
    // réservation sur un créneau libre.
    const double = clientAnswering(referenceTaken());

    await expect(createAppointment(double.prisma)).rejects.not.toBeInstanceOf(
      SlotNoLongerAvailableError,
    );
    expect(double.calls()).toBe(3);
  });
});

/**
 * La fiche désignée passe par `crm`, quelle que soit la surface (#465, #1136).
 *
 * Jusqu'ici la forme `{ clientId }` descendait telle quelle jusqu'aux clés
 * étrangères. Elles jugent l'existence de la ligne et son établissement, jamais
 * son **rôle** : un identifiant de collègue produisait un rendez-vous valide
 * dont la cliente était un employé.
 *
 * C'est désormais le **seul** chemin : le tunnel public désignait une fiche par
 * des coordonnées jusqu'à #1136, et cette résolution a été retirée par #1222
 * avec la porte `crm` qui la servait. Les deux surfaces soumettent un
 * identifiant, et le même contrôle les juge.
 *
 * Ce que cette suite prouve, et que le test d'intégration ne montrerait qu'au
 * travers du moteur : la **place** du contrôle — dans la transaction, après le
 * verrou, avant l'insertion — et le fait qu'un refus n'insère rien et ne se
 * rejoue pas.
 */
describe('AppointmentsRepository.create — la fiche désignée passe par `crm`', () => {
  async function createAtDesk(
    prisma: ScopedPrismaClient,
    clients: ClientDirectoryService,
  ): Promise<unknown> {
    return runWithTenant(TENANT_ID, async () =>
      new AppointmentsRepository(prisma, clients).create(DRAFT),
    );
  }

  it('soumet l’identifiant à la porte `crm` avant d’insérer', async () => {
    const double = clientAnswering(ROW);
    const directory = directoryAnswering({ order: double.order() });

    await createAtDesk(double.prisma, directory.service);

    expect(directory.asserted()).toEqual([CLIENT_ID]);
    // L'ordre est ce qui rend le contrôle juste : après le verrou, qui ordonne
    // les candidates au créneau ; avant l'insertion, qu'il doit pouvoir empêcher.
    expect(double.order()).toEqual(['lock', 'resolve', 'insert']);
  });

  it('contrôle dans la portée de la transaction, jamais par un client à part', async () => {
    // Même garantie que pour la résolution d'invitée (#313) : un contrôle fait
    // hors de la transaction jugerait un état que le `COMMIT` n'engage pas.
    const double = clientAnswering(ROW);
    const directory = directoryAnswering();

    await createAtDesk(double.prisma, directory.service);

    const [scope] = directory.scopes();
    expect(scope).toHaveProperty('appointment');
    expect(scope).not.toBe(double.prisma);
  });

  it('écrit l’identifiant que la porte rend, jamais celui du brouillon', async () => {
    // La porte est la source : si elle rendait un jour autre chose que ce qu'on
    // lui a soumis, c'est cela qui devrait être écrit. Rien ici ne court-circuite.
    const autre = '99999999-9999-4999-8999-999999999999';
    const double = clientAnswering(ROW);
    const directory = directoryAnswering({ answers: [autre] });

    await createAtDesk(double.prisma, directory.service);

    expect(double.createData()[0]).toMatchObject({ clientId: autre });
  });

  it('n’insère rien quand la porte refuse la fiche, et ne rejoue pas', async () => {
    // Un compte du personnel, une fiche du salon voisin, un identifiant inventé :
    // le même 404, et aucune de ces trois causes n'est une course. Les rejouer
    // rendrait trois fois le même refus.
    const refus = new NotFoundError('Cliente introuvable.');
    const double = clientAnswering(ROW);
    const directory = directoryAnswering({ answers: [refus] });

    await expect(createAtDesk(double.prisma, directory.service)).rejects.toBe(refus);
    expect(directory.calls()).toBe(1);
    expect(double.calls()).toBe(0);
  });

  it('contrôle une fois, et n’écrit jamais dans `users`', async () => {
    // La porte ne crée plus de fiche depuis #1222 : `assertBookableWithin` est
    // le seul battant, et une réservation n'appelle rien d'autre. Un second
    // appel voudrait dire qu'une branche de résolution est revenue.
    const double = clientAnswering(ROW);
    const directory = directoryAnswering();

    await createAtDesk(double.prisma, directory.service);

    expect(directory.calls()).toBe(1);
    expect(directory.asserted()).toEqual([CLIENT_ID]);
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

/**
 * Le rendez-vous à déplacer, tel que la base le rend — confirmé, avec ses deux
 * notes.
 *
 * `staffNote` n'est pas dans `ROW` et ne doit pas y être : la seule lecture du
 * module qui demande cette colonne est celle du report (#317). Une ligne mimée
 * qui la porterait partout laisserait passer un `APPOINTMENT_SELECT` élargi par
 * mégarde.
 */
const PREVIOUS_ROW = {
  ...ROW,
  id: '66666666-6666-4666-8666-666666666666',
  status: 'CONFIRMED' as const,
  clientNote: 'allergie aux huiles essentielles',
  staffNote: 'cliente très sensible au bruit — cabine du fond',
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
  /** Les colonnes que la lecture de la ligne d'origine demande (#317). */
  readSelect(): Record<string, unknown>[];
  /** Les colonnes que l'insertion **relit** — la frontière de sortie (#317). */
  createSelect(): Record<string, unknown>[];
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
  const readSelects: Record<string, unknown>[] = [];
  const createSelects: Record<string, unknown>[] = [];
  const inserts = options.inserts ?? [ROW];
  let index = 0;

  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      order.push('lock');
      values.push(...bound);
      return 1;
    }),
    appointment: {
      findFirst: jest.fn(async (args: { select: Record<string, unknown> }) => {
        order.push('read');
        readSelects.push(args.select);
        return options.previous === undefined ? PREVIOUS_ROW : options.previous;
      }),
      updateMany: jest.fn(async (args: { where?: unknown; data?: unknown }) => {
        order.push('update');
        updates.push(args);
        return { count: options.released ?? 1 };
      }),
      create: jest.fn(async (args: { data: Record<string, unknown>; select: Record<string, unknown> }) => {
        order.push('insert');
        creates.push(args.data);
        createSelects.push(args.select);
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
    readSelect: () => readSelects,
    createSelect: () => createSelects,
  };
}

/**
 * Le report, exercé dans une portée de tenant — comme en production.
 *
 * La porte `crm` est fournie parce que le constructeur l'exige, et elle n'est
 * **jamais appelée** : reporter recopie la cliente de la ligne d'origine, jamais
 * des coordonnées. C'est ce que vérifie la suite « le report ne résout aucune
 * fiche ».
 */
async function reschedule(
  prisma: ScopedPrismaClient,
  clients: ClientDirectoryService = directoryAnswering().service,
): Promise<unknown> {
  return runWithTenant(TENANT_ID, async () =>
    new AppointmentsRepository(prisma, clients).reschedule(MOVE),
  );
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

  it('recopie cliente, prestation, prix, notes et statut depuis la ligne relue', async () => {
    const double = movingClient();

    await reschedule(double.prisma);

    expect(double.createData()[0]).toEqual({
      // La référence citable est la seule chose qui **ne se recopie pas** (#796)
      // : l'unique par établissement interdit de la reprendre, et un report
      // produit un rendez-vous neuf — nouvel identifiant, nouvelle référence.
      reference: expect.stringMatching(APPOINTMENT_REFERENCE_PATTERN),
      clientId: PREVIOUS_ROW.clientId,
      serviceId: PREVIOUS_ROW.serviceId,
      priceAmountMinor: PREVIOUS_ROW.priceAmountMinor,
      priceCurrency: PREVIOUS_ROW.priceCurrency,
      clientNote: PREVIOUS_ROW.clientNote,
      staffNote: PREVIOUS_ROW.staffNote,
      // Repris, et non remis à `PENDING` : déplacer un créneau n'annule pas une
      // confirmation déjà obtenue.
      status: 'CONFIRMED',
      staffId: MOVE.staffId,
      startsAt: MOVE.startsAt,
      endsAt: MOVE.endsAt,
      rescheduledFromId: PREVIOUS_ROW.id,
    });
  });

  it('conserve la note interne du staff sur le successeur (#317)', async () => {
    // La note appartient au rendez-vous, pas au créneau : sans cette reprise,
    // « cliente très sensible au bruit » restait orpheline sur la ligne annulée
    // et le praticien retrouvait un rendez-vous nu au report.
    const double = movingClient();

    await reschedule(double.prisma);

    // Lue là où elle est recopiée — et c'est la seule lecture du module qui la
    // demande.
    expect(double.readSelect()[0]).toMatchObject({ staffNote: true });
    expect(double.createData()[0]?.staffNote).toBe(PREVIOUS_ROW.staffNote);
  });

  it('n’ouvre pas pour autant la frontière de sortie du module (#317)', async () => {
    // L'autre moitié du ticket, et celle qui coûte cher si elle cède : la note
    // est **écrite** sans jamais être relue. Le `select` de l'insertion ne la
    // demande pas, donc aucune valeur de `staff_note` n'atteint un
    // `AppointmentRecord` — ni, en aval, `AppointmentView` et `AppointmentDto`,
    // qui servent le parcours public.
    const double = movingClient();

    const outcome = (await reschedule(double.prisma)) as {
      previous: Record<string, unknown>;
      created: Record<string, unknown>;
    };

    expect(double.createSelect()[0]).not.toHaveProperty('staffNote');
    expect(outcome.created).not.toHaveProperty('staffNote');
    // Et pas davantage sur la ligne d'origine, que le repository rend depuis la
    // lecture élargie : c'est `toRecord` qui la laisse tomber.
    expect(outcome.previous).not.toHaveProperty('staffNote');
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

  it('ne résout aucune fiche cliente : elle est recopiée de la ligne relue', async () => {
    // Reporter ne change pas la cliente (#39), et la porte `crm` n'a donc rien à
    // faire sur ce chemin. L'y appeler aurait créé une fiche depuis un
    // rendez-vous qui en a déjà une — et l'aurait créée depuis des coordonnées
    // que la demande de report ne porte même pas.
    const double = movingClient();
    const directory = directoryAnswering();

    await reschedule(double.prisma, directory.service);

    expect(directory.calls()).toBe(0);
    expect(double.createData()[0]).toMatchObject({ clientId: PREVIOUS_ROW.clientId });
  });
});
