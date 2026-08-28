import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { ConflictError, InvalidStateTransitionError, NotFoundError } from '../src/common/errors';
import { runWithTenant } from '../src/common/tenant/tenant-context';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { SLOT_EXCLUSION_CONSTRAINT } from '../src/modules/appointments/appointments.conflicts';
import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import type {
  AppointmentDraft,
  CancelDraft,
  RescheduleDraft,
} from '../src/modules/appointments/appointments.types';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Contrainte d'exclusion anti-double-réservation — **contre un vrai
 * PostgreSQL** (#31, ADR 0002).
 *
 * ## Pourquoi cette suite ne peut pas être un test unitaire
 *
 * Le risque n°1 du projet (CDC §6) est une **course**, et une course ne se
 * simule pas contre un double en mémoire : ce qui est en cause est l'atomicité
 * du moteur, pas la logique du repository. Un test qui remplacerait Prisma par
 * un faux prouverait que le code traduit bien une erreur qu'il aurait lui-même
 * fabriquée — c'est-à-dire rien du tout.
 *
 * Ce qui est prouvé ici, et qui n'est prouvable nulle part ailleurs :
 *
 * 1. la contrainte **existe** en base, avec son extension et sa colonne générée ;
 * 2. deux rendez-vous qui se chevauchent sur le même praticien sont refusés, et
 *    le refus arrive au code sous la forme d'un `SlotNoLongerAvailableError` —
 *    jamais d'une erreur brute ;
 * 3. **N écritures parallèles sur le même créneau produisent exactement un
 *    succès** et N−1 conflits. C'est le test non négociable de booking-engine §6 ;
 * 4. un rendez-vous annulé ou marqué no-show **libère** son créneau ;
 * 5. deux établissements réservent le même instant sans se gêner — la frontière
 *    du tenant est dans l'index, pas seulement dans les intentions ;
 * 6. deux rendez-vous **adjacents** restent légaux : la borne `[)` ne perd pas
 *    un créneau sur deux.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre (#27, #274). La suite se crée une
 * **base jetable**, migrée puis détruite, dans un PostgreSQL 16 qu'elle démarre
 * elle-même (`utils/disposable-database.ts` — `postgres:16-alpine`,
 * `@testcontainers/postgresql`). Rien n'est partagé avec les suites voisines,
 * pas même le serveur — ce qui compte doublement ici, puisque plusieurs agents
 * de jalon peuvent exercer cette suite de front sur la même machine.
 * `DATABASE_URL` n'est plus lue depuis #274 : rien de ce que la machine héberge
 * n'entre dans le résultat.
 *
 * L'absence de démon fait échouer la suite, délibérément : une garantie
 * anti-double-réservation qui se désactiverait toute seule quand le moteur
 * manque serait pire qu'absente. Un échec se débogue alors du côté de Docker et
 * de l'image, jamais d'un serveur local ou d'un service de la CI — aucun des
 * deux n'étant en cause.
 */

/**
 * Le nombre d'écritures parallèles du test de concurrence.
 *
 * Huit, et non deux : deux requêtes peuvent se sérialiser par hasard sur un pool
 * de connexions, et un test qui passe par chance ne prouve rien. Huit dépasse le
 * parallélisme d'un pool par défaut sans allonger la suite de façon sensible.
 */
const CONCURRENT_ATTEMPTS = 8;

/** Le tenant, tel que cette suite le crée — le strict nécessaire du schéma. */
function tenantSeed(label: string): Prisma.TenantCreateInput {
  return {
    slug: `i31-${label}-${randomUUID()}`,
    name: `Établissement ${label}`,
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
  };
}

/**
 * Ouvre la portée du tenant **et y attend le résultat**.
 *
 * Sans l'`await` intérieur, la promesse Prisma serait construite dans la portée
 * et exécutée dehors : `AsyncLocalStorage` se referme dès que la fonction rend
 * la main, l'extension ne trouverait aucun tenant, et la suite rougirait sur une
 * `MissingTenantContextError` au lieu de prouver quoi que ce soit. Même détour,
 * et même raison, que dans `tenant-scope.isolation-spec.ts`.
 */
async function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, async () => {
    const result = await fn();
    return result;
  });
}

/** Un établissement complet : un client, un praticien, une prestation. */
interface Fixture {
  readonly tenantId: string;
  readonly clientId: string;
  readonly staffId: string;
  readonly secondStaffId: string;
  readonly serviceId: string;
}

const NINE = new Date('2026-09-01T09:00:00.000Z');
const TEN = new Date('2026-09-01T10:00:00.000Z');
const HALF_PAST_NINE = new Date('2026-09-01T09:30:00.000Z');
const HALF_PAST_TEN = new Date('2026-09-01T10:30:00.000Z');

/** Une heure, en millisecondes — la durée de toutes les prestations de la suite. */
const ONE_HOUR = 3_600_000;

/**
 * Les trois statuts qui **libèrent** le créneau, chacun sur sa propre journée
 * pour que les cas ne se marchent pas dessus.
 */
const FREEING_STATUSES = {
  CANCELLED: new Date('2026-09-20T09:00:00.000Z'),
  NO_SHOW: new Date('2026-09-21T09:00:00.000Z'),
  COMPLETED: new Date('2026-09-22T09:00:00.000Z'),
} as const;

type FreeingStatus = keyof typeof FREEING_STATUSES;

describe('Contrainte d’exclusion anti-double-réservation — contre un vrai PostgreSQL', () => {
  /**
   * La racine non scopée : elle sert ici à ce pour quoi elle existe — créer les
   * établissements, qui n'ont par définition aucun tenant courant, et
   * **observer** la base sans le filtre qu'on ne teste pas ici.
   */
  let prismaUnscoped: PrismaClient;
  let scoped: ReturnType<typeof createScopedPrismaClient>;
  let repository: AppointmentsRepository;
  let database: DisposableDatabase | undefined;

  let salon: Fixture;
  let voisin: Fixture;

  /** Sème un établissement complet et rend de quoi y réserver. */
  async function seedTenant(label: string): Promise<Fixture> {
    const tenantId = (await prismaUnscoped.tenant.create({ data: tenantSeed(label) })).id;

    // Le client non scopé est le bon outil pour semer : ces lignes précèdent
    // toute requête HTTP, donc tout contexte de tenant. Le `tenantId` est écrit
    // explicitement — c'est ce que tenant-isolation §3 exige d'un accès non scopé.
    const client = await prismaUnscoped.user.create({
      data: {
        tenantId,
        email: `client-${randomUUID()}@example.test`,
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Martin',
      },
    });

    const staffOf = async (name: string): Promise<string> => {
      const account = await prismaUnscoped.user.create({
        data: {
          tenantId,
          email: `staff-${randomUUID()}@example.test`,
          role: 'STAFF',
          firstName: name,
          lastName: 'Praticien',
        },
      });
      const profile = await prismaUnscoped.staff.create({
        data: { tenantId, userId: account.id, displayName: name },
      });
      return profile.id;
    };

    const service = await prismaUnscoped.service.create({
      data: {
        tenantId,
        slug: `massage-60-${randomUUID().slice(0, 8)}`,
        name: 'Massage 60 min',
        durationMinutes: 60,
        priceAmountMinor: 3500,
        priceCurrency: 'EUR',
      },
    });

    return {
      tenantId,
      clientId: client.id,
      staffId: await staffOf('Camille'),
      secondStaffId: await staffOf('Dominique'),
      serviceId: service.id,
    };
  }

  /** Un brouillon de rendez-vous pour cet établissement, sur ces bornes. */
  function draft(
    fixture: Fixture,
    startsAt: Date,
    endsAt: Date,
    staffId = fixture.staffId,
  ): AppointmentDraft {
    return {
      clientId: fixture.clientId,
      staffId,
      serviceId: fixture.serviceId,
      startsAt,
      endsAt,
      price: { amountMinor: 3500, currency: 'EUR' },
      clientNote: null,
    };
  }

  /**
   * Change le statut d'un rendez-vous **sans passer par le domaine** — ce que
   * ferait une correction d'exploitation. Écrit par le client non scopé parce
   * que la suite observe la base, elle n'exerce pas le scoping ici.
   *
   * À ne pas confondre avec `repository.cancel` (#40), qui inscrit la trace :
   * ce raccourci sert à **amener** un rendez-vous dans un statut de départ, pas
   * à exercer l'annulation.
   */
  async function setStatus(id: string, status: FreeingStatus): Promise<void> {
    await prismaUnscoped.appointment.update({ where: { id }, data: { status } });
  }

  beforeAll(async () => {
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });
    await prismaUnscoped.$connect();
    // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
    // que le schéma est en place. Une base joignable mais vide produirait sinon
    // une erreur bien plus loin, où elle se lirait comme un défaut du repository.
    await prismaUnscoped.tenant.count();

    scoped = createScopedPrismaClient(prismaUnscoped);
    repository = new AppointmentsRepository(scoped);

    salon = await seedTenant('salon');
    voisin = await seedTenant('voisin');
  });

  afterAll(async () => {
    // Le ménage tient en une ligne : la base entière disparaît. La déconnexion
    // d'abord, pour ne pas laisser Prisma journaliser une rupture de connexion
    // qui se lirait comme un incident.
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  describe('ce que la migration a réellement posé', () => {
    it('active l’extension `btree_gist`', async () => {
      // Sans elle, un index GiST ne sait pas comparer deux `uuid` par égalité :
      // la contrainte ne pourrait pas mêler `tenant_id`, `staff_id` et un
      // opérateur de chevauchement.
      //
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_extension` ne porte aucune donnée d'établissement, il n'y a rien à y filtrer.
      const rows = await prismaUnscoped.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM pg_extension WHERE extname = 'btree_gist'
      `;

      expect(rows[0]?.count).toBe(1n);
    });

    it('génère `time_range` depuis `starts_at` et `ends_at`, en `tstzrange`', async () => {
      // `attgenerated = 's'` est la seule preuve directe que la colonne est
      // *générée et stockée* : `information_schema` rend « USER-DEFINED » sur un
      // type intervalle et ne dirait donc rien du type réel.
      //
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_attribute` décrit le schéma, pas des lignes d'établissement.
      const rows = await prismaUnscoped.$queryRaw<{ type: string; generated: string }[]>`
        SELECT atttypid::regtype::text AS type, attgenerated AS generated
        FROM pg_attribute
        WHERE attrelid = 'appointments'::regclass AND attname = 'time_range'
      `;

      expect(rows[0]).toEqual({ type: 'tstzrange', generated: 's' });
    });

    it('pose `appointments_no_overlap` sur (tenant_id, staff_id, time_range), filtrée', async () => {
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_constraint` décrit le schéma, pas des lignes d'établissement.
      const rows = await prismaUnscoped.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = ${SLOT_EXCLUSION_CONSTRAINT}
      `;

      const definition = rows[0]?.definition ?? '';
      // L'ordre des colonnes compte : `tenant_id` en tête, comme tout index
      // métier (tenant-isolation §1).
      expect(definition).toContain('EXCLUDE USING gist');
      expect(definition).toMatch(/tenant_id WITH =/);
      expect(definition).toMatch(/staff_id WITH =/);
      expect(definition).toMatch(/time_range WITH &&/);
      // Le filtre partiel : sans lui, la première annulation rendrait le créneau
      // définitivement inréservable.
      expect(definition).toContain("'PENDING'");
      expect(definition).toContain("'CONFIRMED'");
      expect(definition).not.toContain("'CANCELLED'");
      expect(definition).not.toContain("'NO_SHOW'");
      expect(definition).not.toContain("'COMPLETED'");
    });

    it('remplit `time_range` sur les bornes du rendez-vous, ouvert à droite', async () => {
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, new Date('2026-10-05T08:00:00.000Z'), new Date('2026-10-05T09:00:00.000Z'))),
      );

      const rows = await prismaUnscoped.$queryRaw<{ bounds: string }[]>`
        SELECT "time_range"::text AS bounds
        FROM appointments
        WHERE "tenant_id" = ${salon.tenantId}::uuid AND "id" = ${created.id}::uuid
      `;

      expect(rows[0]?.bounds).toMatch(/^\["2026-10-05 08:00:00\+00","2026-10-05 09:00:00\+00"\)$/);
    });
  });

  describe('deux rendez-vous qui se chevauchent', () => {
    it('refuse le second, en `SlotNoLongerAvailableError` et non en erreur brute', async () => {
      await inTenant(salon.tenantId, () => repository.create(draft(salon, NINE, TEN)));

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(draft(salon, HALF_PAST_NINE, HALF_PAST_TEN)),
        ),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);
    });

    it('rend un conflit dont les détails ne disent rien du rendez-vous d’en face', async () => {
      const start = new Date('2026-09-02T09:00:00.000Z');
      const end = new Date('2026-09-02T10:00:00.000Z');
      await inTenant(salon.tenantId, () => repository.create(draft(salon, start, end)));

      const error = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end)).then(
          () => undefined,
          (thrown: unknown) => thrown,
        ),
      );

      expect(error).toBeInstanceOf(SlotNoLongerAvailableError);
      expect((error as SlotNoLongerAvailableError).status).toBe(409);
      expect((error as SlotNoLongerAvailableError).details).toEqual({
        staffId: salon.staffId,
        startsAt: start.toISOString(),
      });
    });

    it('laisse passer deux rendez-vous adjacents — la borne est `[)`', async () => {
      // Un soin qui finit à 10:00 et le suivant qui commence à 10:00 ne se
      // chevauchent pas. Avec `[]`, l'agenda perdrait un créneau sur deux.
      const first = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, new Date('2026-09-03T09:00:00.000Z'), new Date('2026-09-03T10:00:00.000Z'))),
      );
      const second = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, new Date('2026-09-03T10:00:00.000Z'), new Date('2026-09-03T11:00:00.000Z'))),
      );

      expect(first.id).not.toBe(second.id);
    });

    it('laisse passer le même créneau sur un autre praticien du même salon', async () => {
      const start = new Date('2026-09-04T09:00:00.000Z');
      const end = new Date('2026-09-04T10:00:00.000Z');
      await inTenant(salon.tenantId, () => repository.create(draft(salon, start, end)));

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(draft(salon, start, end, salon.secondStaffId)),
        ),
      ).resolves.toMatchObject({ staffId: salon.secondStaffId });
    });
  });

  describe('N écritures parallèles sur le même créneau', () => {
    it(`produit exactement un succès et ${CONCURRENT_ATTEMPTS - 1} conflits`, async () => {
      // Le test non négociable de booking-engine §6. Il ne prouve pas que le
      // code est prudent : il prouve que la prudence du code est **inutile**,
      // parce que la base tranche à sa place.
      const start = new Date('2026-09-10T09:00:00.000Z');
      const end = new Date('2026-09-10T10:00:00.000Z');

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
        ),
      );

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(CONCURRENT_ATTEMPTS - 1);
      // Toutes les perdantes en 409 : une seule qui remonterait brute suffirait à
      // rendre un 500 au client, et c'est précisément ce que #31 supprime.
      for (const outcome of rejected) {
        expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
      }

      // Et la base ne porte bien qu'une ligne — la preuve directe, sans passer
      // par ce que les promesses ont bien voulu dire.
      const stored = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, staffId: salon.staffId, startsAt: start },
      });
      expect(stored).toBe(1);
    });

    it('sérialise aussi des chevauchements partiels décalés', async () => {
      // Des bornes toutes différentes : aucune contrainte d'unicité ne les
      // rattraperait, seule l'exclusion sur l'intervalle le fait.
      const base = Date.UTC(2026, 8, 11, 9, 0, 0);
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.create(
              draft(
                salon,
                new Date(base + index * 60_000),
                new Date(base + index * 60_000 + ONE_HOUR),
              ),
            ),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
        }
      }
    });
  });

  describe('un rendez-vous qui n’occupe plus libère son créneau', () => {
    it.each(Object.keys(FREEING_STATUSES) as FreeingStatus[])(
      'rend le créneau réservable après passage en %s',
      async (status) => {
        const start = FREEING_STATUSES[status];
        const end = new Date(start.getTime() + ONE_HOUR);

        const first = await inTenant(salon.tenantId, () =>
          repository.create(draft(salon, start, end)),
        );

        // Tant qu'il occupe, le créneau est refusé…
        await expect(
          inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
        ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

        await setStatus(first.id, status);

        // …et dès qu'il n'occupe plus, il est réservable. C'est le filtre partiel
        // de la contrainte, et c'est un critère d'acceptation de #31.
        await expect(
          inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
        ).resolves.toMatchObject({ staffId: salon.staffId });
      },
    );
  });

  describe('la frontière du tenant', () => {
    it('laisse deux établissements réserver le même instant sans se gêner', async () => {
      const start = new Date('2026-09-30T09:00:00.000Z');
      const end = new Date('2026-09-30T10:00:00.000Z');

      const chezSalon = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end)),
      );
      const chezVoisin = await inTenant(voisin.tenantId, () =>
        repository.create(draft(voisin, start, end)),
      );

      expect(chezSalon.id).not.toBe(chezVoisin.id);
    });

    it('ne laisse pas le voisin lire le rendez-vous du salon par son identifiant', async () => {
      // 404 et non 403 : un 403 confirmerait l'existence de la ligne
      // (tenant-isolation §4). Le repository rend `null`, ce que le service
      // traduira en `NotFoundError`.
      const start = new Date('2026-10-01T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      await expect(
        inTenant(voisin.tenantId, () => repository.findById(created.id)),
      ).resolves.toBeNull();
      await expect(
        inTenant(salon.tenantId, () => repository.findById(created.id)),
      ).resolves.toMatchObject({ id: created.id });
    });

    it('ne rend jamais le `tenant_id` d’une ligne', async () => {
      const start = new Date('2026-10-02T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      expect(Object.keys(created).sort()).toEqual([
        'cancellationReason',
        'cancelledAt',
        'cancelledBy',
        'clientNote',
        'clientId',
        'endsAt',
        'id',
        'price',
        'rescheduledFromId',
        'serviceId',
        'staffId',
        'startsAt',
        'status',
      ].sort());
    });
  });

  /**
   * Le report contre un vrai moteur (#39).
   *
   * Trois choses ne se prouvent qu'ici, et aucune ne se simule :
   *
   * 1. **le nouveau créneau peut chevaucher l'ancien.** C'est la raison
   *    technique du « annuler puis créer » : un `UPDATE` des bornes se serait
   *    heurté à la contrainte, qui compare la ligne modifiée à elle-même ;
   * 2. **un refus ne laisse aucune trace.** Le `ROLLBACK` emporte l'annulation
   *    avec l'insertion — l'ancien rendez-vous est intact, au statut où il
   *    était ;
   * 3. **la clé composite tient la frontière.** Un rendez-vous ne peut pas
   *    déclarer remplacer celui d'un autre établissement, quelle que soit
   *    l'origine de l'écriture.
   */
  describe('le report — annulation et création liées', () => {
    /** Un report vers ces bornes, chez le praticien indiqué. */
    function move(
      previousId: string,
      startsAt: Date,
      endsAt: Date,
      staffId: string,
    ): RescheduleDraft {
      return { previousId, staffId, startsAt, endsAt };
    }

    it('a posé la colonne, son index préfixé et sa clé composite', async () => {
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_constraint` et `pg_indexes` décrivent le schéma, pas des lignes d'établissement.
      const keys = await prismaUnscoped.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'appointments'::regclass AND contype = 'f'
      `;
      const definitions = keys.map((row) => row.definition);

      // La clé mono-colonne est muette sur le tenant : celle qui tient la
      // frontière est la composite (tenant-isolation §1).
      expect(definitions).toContainEqual(
        expect.stringContaining(
          'FOREIGN KEY (tenant_id, rescheduled_from_id) REFERENCES appointments(tenant_id, id)',
        ),
      );

      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_indexes` décrit le schéma.
      const indexes = await prismaUnscoped.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'appointments' AND indexname = 'appointments_tenant_id_rescheduled_from_id_idx'
      `;
      expect(indexes[0]?.indexdef).toContain('(tenant_id, rescheduled_from_id)');
    });

    it('annule l’ancien rendez-vous et crée le nouveau qui le référence', async () => {
      const start = new Date('2026-12-01T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      const target = new Date('2026-12-01T14:00:00.000Z');

      const outcome = await inTenant(salon.tenantId, () =>
        repository.reschedule(
          move(previous.id, target, new Date(target.getTime() + ONE_HOUR), salon.staffId),
        ),
      );

      expect(outcome.created.rescheduledFromId).toBe(previous.id);
      const rows = await prismaUnscoped.appointment.findMany({
        where: { tenantId: salon.tenantId, id: { in: [previous.id, outcome.created.id] } },
        select: { id: true, status: true, cancelledAt: true, rescheduledFromId: true },
        orderBy: { createdAt: 'asc' },
      });

      // Deux lignes, et le lien entre elles : c'est l'historique que le
      // quatrième critère de #39 demande.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: previous.id, status: 'CANCELLED' });
      expect(rows[0]?.cancelledAt).toBeInstanceOf(Date);
      expect(rows[1]).toMatchObject({ id: outcome.created.id, rescheduledFromId: previous.id });
    });

    it('accepte un créneau qui chevauche celui d’origine — ce qu’un UPDATE aurait refusé', async () => {
      // Le cas le plus courant du comptoir : décaler d'une demi-heure un soin
      // qui en dure une. La contrainte compare la ligne modifiée à elle-même :
      // un `UPDATE` des bornes aurait rendu 409 sur un déplacement légitime.
      const start = new Date('2026-12-02T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      const target = new Date('2026-12-02T09:30:00.000Z');

      await expect(
        inTenant(salon.tenantId, () =>
          repository.reschedule(
            move(previous.id, target, new Date(target.getTime() + ONE_HOUR), salon.staffId),
          ),
        ),
      ).resolves.toMatchObject({ created: { startsAt: target } });
    });

    it('laisse l’ancien rendez-vous intact quand le créneau d’arrivée est pris', async () => {
      const start = new Date('2026-12-03T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      const target = new Date('2026-12-03T14:00:00.000Z');
      await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, target, new Date(target.getTime() + ONE_HOUR))),
      );

      await expect(
        inTenant(salon.tenantId, () =>
          repository.reschedule(
            move(previous.id, target, new Date(target.getTime() + ONE_HOUR), salon.staffId),
          ),
        ),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

      // Le `ROLLBACK` a emporté l'annulation avec l'insertion : la cliente garde
      // son rendez-vous. C'est le troisième critère de #39, et il n'est tenu par
      // aucun code applicatif.
      const kept = await prismaUnscoped.appointment.findUnique({
        where: { id: previous.id },
        select: { status: true, cancelledAt: true },
      });
      expect(kept).toEqual({ status: 'PENDING', cancelledAt: null });
      const successors = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, rescheduledFromId: previous.id },
      });
      expect(successors).toBe(0);
    });

    it('ne laisse aboutir qu’un seul de plusieurs reports concurrents du même rendez-vous', async () => {
      // Chacun vise un praticien et un créneau libres : rien ne les départage
      // sinon l'écriture conditionnelle sur le statut de la ligne de départ.
      // Deux succès donneraient deux rendez-vous à une cliente qui n'en a
      // demandé qu'un, et deux successeurs à un seul prédécesseur.
      const start = new Date('2026-12-04T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      const base = Date.UTC(2026, 11, 4, 14, 0, 0);
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.reschedule(
              move(
                previous.id,
                new Date(base + index * ONE_HOUR),
                new Date(base + index * ONE_HOUR + ONE_HOUR),
                index % 2 === 0 ? salon.staffId : salon.secondStaffId,
              ),
            ),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const successors = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, rescheduledFromId: previous.id },
      });
      expect(successors).toBe(1);
    });

    it('refuse de reporter un rendez-vous qui n’occupe plus son créneau', async () => {
      const start = new Date('2026-12-05T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      await setStatus(previous.id, 'COMPLETED');
      const target = new Date('2026-12-05T14:00:00.000Z');

      await expect(
        inTenant(salon.tenantId, () =>
          repository.reschedule(
            move(previous.id, target, new Date(target.getTime() + ONE_HOUR), salon.staffId),
          ),
        ),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it('ne laisse pas le voisin reporter le rendez-vous du salon', async () => {
      const start = new Date('2026-12-06T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      const target = new Date('2026-12-06T14:00:00.000Z');

      // 404 et non 403 : la ligne est invisible depuis l'autre portée, et le
      // report est une **écriture** — un 403 aurait confirmé son existence à qui
      // vient d'essayer de l'annuler.
      await expect(
        inTenant(voisin.tenantId, () =>
          repository.reschedule(
            move(previous.id, target, new Date(target.getTime() + ONE_HOUR), voisin.staffId),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      const kept = await prismaUnscoped.appointment.findUnique({
        where: { id: previous.id },
        select: { status: true },
      });
      expect(kept).toEqual({ status: 'PENDING' });
    });

    it('refuse en base un lien de report vers le rendez-vous d’un autre établissement', async () => {
      // La garantie ne vient pas du code : la clé composite
      // `(tenant_id, rescheduled_from_id) → (tenant_id, id)` la tient quelle que
      // soit l'origine de l'écriture — API, script, psql.
      const start = new Date('2026-12-07T09:00:00.000Z');
      const chezSalon = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      await expect(
        prismaUnscoped.appointment.create({
          data: {
            tenantId: voisin.tenantId,
            clientId: voisin.clientId,
            staffId: voisin.staffId,
            serviceId: voisin.serviceId,
            startsAt: new Date('2026-12-07T15:00:00.000Z'),
            endsAt: new Date('2026-12-07T16:00:00.000Z'),
            priceAmountMinor: 3500,
            priceCurrency: 'EUR',
            rescheduledFromId: chezSalon.id,
          },
        }),
      ).rejects.toThrow();
    });
  });

  /**
   * L'annulation contre un vrai moteur (#40).
   *
   * Trois choses ne se prouvent qu'ici :
   *
   * 1. **le créneau est réservable dès le `COMMIT`.** Aucune purge, aucune
   *    invalidation : la ligne quitte le filtre partiel de la contrainte, et
   *    c'est tout. Le double en mémoire reproduit cet effet ; seul PostgreSQL
   *    prouve que l'index le fait vraiment ;
   * 2. **la trace est bien écrite en base**, sur les trois colonnes que le
   *    deuxième critère du ticket nomme — et sur le bon type d'énumération, ce
   *    qu'aucun test unitaire ne peut vérifier ;
   * 3. **deux annulations concurrentes n'en réussissent qu'une.** C'est
   *    l'`UPDATE` conditionnel qui les départage, et c'est le seul moyen de
   *    savoir laquelle des deux a inscrit son auteur et son motif.
   */
  describe('l’annulation — trace écrite et créneau rendu', () => {
    /** Une demande d'annulation sur ce rendez-vous. */
    function cancellation(
      appointmentId: string,
      overrides: Partial<Omit<CancelDraft, 'appointmentId'>> = {},
    ): CancelDraft {
      return {
        appointmentId,
        cancelledAt: new Date('2026-08-31T09:15:00.000Z'),
        cancelledBy: 'CLIENT',
        reason: null,
        ...overrides,
      };
    }

    it('a posé la colonne `cancelled_by`, nullable et sur son propre type', async () => {
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- catalogue système : `pg_attribute` décrit le schéma, pas des lignes d'établissement.
      const rows = await prismaUnscoped.$queryRaw<{ type: string; notnull: boolean }[]>`
        SELECT atttypid::regtype::text AS type, attnotnull AS notnull
        FROM pg_attribute
        WHERE attrelid = 'appointments'::regclass AND attname = 'cancelled_by'
      `;

      // Nullable : le report annule la ligne d'origine sans auteur à nommer.
      expect(rows[0]).toEqual({ type: '"AppointmentCancelledBy"', notnull: false });
    });

    it('inscrit statut, horodatage, auteur et motif d’un seul geste', async () => {
      const start = new Date('2027-01-05T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      await inTenant(salon.tenantId, () =>
        repository.cancel(
          cancellation(created.id, { cancelledBy: 'STAFF', reason: 'Praticien souffrant' }),
        ),
      );

      const row = await prismaUnscoped.appointment.findUnique({
        where: { id: created.id },
        select: {
          status: true,
          cancelledAt: true,
          cancelledBy: true,
          cancellationReason: true,
        },
      });

      expect(row).toEqual({
        status: 'CANCELLED',
        cancelledAt: new Date('2026-08-31T09:15:00.000Z'),
        cancelledBy: 'STAFF',
        cancellationReason: 'Praticien souffrant',
      });
    });

    it('rend le créneau réservable immédiatement, sans rien relâcher d’autre', async () => {
      const start = new Date('2027-01-06T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end)),
      );

      // Tant qu'il occupe, le créneau est refusé…
      await expect(
        inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

      await inTenant(salon.tenantId, () => repository.cancel(cancellation(created.id)));

      // …et dès l'annulation validée, il est repris. Troisième critère de #40,
      // tenu par le `WHERE status IN ('PENDING','CONFIRMED')` de la contrainte.
      const reprise = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end)),
      );
      expect(reprise.id).not.toBe(created.id);

      // Et le créneau n'est pas devenu libre pour tout le monde : la contrainte
      // juge la reprise comme elle jugeait la réservation d'origine.
      await expect(
        inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);
    });

    it('ne laisse aboutir qu’une seule de plusieurs annulations concurrentes', async () => {
      // Deux succès inscriraient deux auteurs et deux motifs sur la même ligne,
      // dont un seul survivrait — sans que personne sache lequel.
      const start = new Date('2027-01-07T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.cancel(cancellation(created.id, { reason: `essai ${index}` })),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // 409 ou 422 selon que la perdante a relu la ligne avant ou après la
          // validation de la gagnante — jamais un 500, et jamais un succès.
          expect(
            outcome.reason instanceof ConflictError ||
              outcome.reason instanceof InvalidStateTransitionError,
          ).toBe(true);
        }
      }

      // Un seul motif inscrit, celui de la gagnante.
      const row = await prismaUnscoped.appointment.findUnique({
        where: { id: created.id },
        select: { status: true, cancellationReason: true },
      });
      expect(row?.status).toBe('CANCELLED');
      expect(row?.cancellationReason).toMatch(/^essai \d$/);
    });

    it('refuse d’annuler un rendez-vous qui n’occupe plus son créneau', async () => {
      const start = new Date('2027-01-08T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );
      await setStatus(created.id, 'COMPLETED');

      await expect(
        inTenant(salon.tenantId, () => repository.cancel(cancellation(created.id))),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    });

    it('ne laisse pas le voisin annuler le rendez-vous du salon', async () => {
      const start = new Date('2027-01-09T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      // 404 et non 403 : l'annulation est une **écriture**, et un 403 aurait
      // confirmé l'existence de la ligne à qui vient d'essayer de l'effacer de
      // l'agenda (tenant-isolation §4).
      await expect(
        inTenant(voisin.tenantId, () => repository.cancel(cancellation(created.id))),
      ).rejects.toBeInstanceOf(NotFoundError);

      const kept = await prismaUnscoped.appointment.findUnique({
        where: { id: created.id },
        select: { status: true, cancelledAt: true, cancelledBy: true },
      });
      expect(kept).toEqual({ status: 'PENDING', cancelledAt: null, cancelledBy: null });
    });
  });

  describe('ce que le repository ne traduit pas', () => {
    it('laisse remonter une erreur qui n’est pas un conflit de créneau', async () => {
      // Une clé étrangère violée n'est pas « ce créneau est pris » : la traduire
      // ferait réessayer le client indéfiniment sur un créneau pourtant libre.
      const orphan = draft(salon, new Date('2026-11-01T09:00:00.000Z'), new Date('2026-11-01T10:00:00.000Z'));
      const withUnknownStaff: AppointmentDraft = {
        ...orphan,
        staffId: '99999999-9999-4999-8999-999999999999',
      };

      await expect(
        inTenant(salon.tenantId, () => repository.create(withUnknownStaff)),
      ).rejects.not.toBeInstanceOf(SlotNoLongerAvailableError);
    });
  });
});
