import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { runWithTenant } from '../src/common/tenant/tenant-context';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { SLOT_EXCLUSION_CONSTRAINT } from '../src/modules/appointments/appointments.conflicts';
import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import type { AppointmentDraft } from '../src/modules/appointments/appointments.types';
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
 * Un serveur PostgreSQL joignable sur `DATABASE_URL`. La suite n'y travaille
 * pas : elle s'y crée une **base jetable**, migrée puis détruite
 * (`utils/disposable-database.ts`, #27). Rien n'est partagé avec les suites
 * voisines — ce qui compte doublement ici, puisque plusieurs agents de jalon
 * partagent le même conteneur local.
 *
 * La CI garantit le serveur (services du job `test` de `ci.yml`) ; en local,
 * `docker compose up -d` suffit. L'absence de serveur fait échouer la suite,
 * délibérément : une garantie anti-double-réservation qui se désactiverait toute
 * seule quand la base manque serait pire qu'absente.
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
   * Change le statut d'un rendez-vous — ce que fera le service d'annulation
   * (#40), qui n'existe pas encore. Écrit par le client non scopé parce que la
   * suite observe la base, elle n'exerce pas le scoping ici.
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
        'clientNote',
        'clientId',
        'endsAt',
        'id',
        'price',
        'serviceId',
        'staffId',
        'startsAt',
        'status',
      ].sort());
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
