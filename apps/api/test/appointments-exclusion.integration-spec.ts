import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { InvalidStateTransitionError, NotFoundError } from '../src/common/errors';
import { SLOT_EXCLUSION_CONSTRAINT } from '../src/modules/appointments/appointments.conflicts';
import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import type { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import type { AppointmentDraft } from '../src/modules/appointments/appointments.types';
import type { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import {
  ONE_HOUR,
  cancellation,
  createExclusionHarness,
  deskDraft,
  draft,
  inTenant,
  move,
  type ExclusionHarness,
  type Fixture,
} from './appointments-exclusion.harness';

/**
 * Contrainte d'exclusion anti-double-réservation — **contre un vrai
 * PostgreSQL** (#31, ADR 0002).
 *
 * ## Pourquoi cette suite ne peut pas être un test unitaire
 *
 * Ce qui est en cause est le moteur lui-même : sa contrainte, son filtre
 * partiel, ses clés. Un test qui remplacerait Prisma par un faux prouverait que
 * le code traduit bien une erreur qu'il aurait lui-même fabriquée —
 * c'est-à-dire rien du tout.
 *
 * Ce qui est prouvé ici, et qui n'est prouvable nulle part ailleurs :
 *
 * 1. la contrainte **existe** en base, avec son extension et sa colonne générée ;
 * 2. deux rendez-vous qui se chevauchent sur le même praticien sont refusés, et
 *    le refus arrive au code sous la forme d'un `SlotNoLongerAvailableError` —
 *    jamais d'une erreur brute ;
 * 3. un rendez-vous annulé ou marqué no-show **libère** son créneau ;
 * 4. deux établissements réservent le même instant sans se gêner — la frontière
 *    du tenant est dans l'index, pas seulement dans les intentions ;
 * 5. deux rendez-vous **adjacents** restent légaux : la borne `[)` ne perd pas
 *    un créneau sur deux ;
 * 6. le report et l'annulation écrivent en base ce que #39 et #40 décrivent ;
 * 7. la lecture qui **propose** sait écarter un rendez-vous nommé — celui qu'un
 *    report déplace (#316) — et un identifiant de l'établissement voisin n'y
 *    écarte rien, le `where` étant scopé ;
 * 8. la **fiche cliente** résolue par `crm` vit dans la même transaction que le
 *    rendez-vous (#313) : un créneau refusé n'en laisse aucune derrière lui, et
 *    c'est le `ROLLBACK` qui le garantit — rien qu'un double en mémoire ne
 *    saurait prouver ;
 * 9. la fiche **désignée** par le comptoir est jugée sur son **rôle** dans cette
 *    même transaction (#465). Les clés étrangères prouvent l'existence et
 *    l'établissement de la ligne, jamais qu'elle est au fichier client : c'est
 *    la porte de `crm` qui lit `users.role`, et il faut une vraie base pour
 *    l'exercer sur les quatre rôles.
 *
 * ## Ce qui n'est plus ici
 *
 * Les **courses** — N écritures parallèles sur le même créneau, le repli de
 * « premier disponible », les reports et annulations concurrents — ont
 * déménagé vers `appointments-exclusion.concurrency-spec.ts`, jouée par la
 * cible `npm run test:concurrency` (#326). Elles partagent le décor de cette
 * suite via `appointments-exclusion.harness.ts`, et ne sont jouées qu'une fois :
 * `jest.integration.config.js` ne connaît que `*.integration-spec.ts` et
 * `*.isolation-spec.ts`.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre (#27, #274) — voir le harnais.
 */

const NINE = new Date('2026-09-01T09:00:00.000Z');
const TEN = new Date('2026-09-01T10:00:00.000Z');
const HALF_PAST_NINE = new Date('2026-09-01T09:30:00.000Z');
const HALF_PAST_TEN = new Date('2026-09-01T10:30:00.000Z');

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
  let harness: ExclusionHarness | undefined;
  /**
   * La racine non scopée : elle sert ici à ce pour quoi elle existe — créer les
   * établissements, qui n'ont par définition aucun tenant courant, et
   * **observer** la base sans le filtre qu'on ne teste pas ici.
   */
  let prismaUnscoped: PrismaClient;
  let repository: AppointmentsRepository;
  /** La lecture que le moteur de disponibilité fait de cette table (#316). */
  let availability: AvailabilityRepository;

  let salon: Fixture;
  let voisin: Fixture;

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
    harness = await createExclusionHarness();
    ({ prismaUnscoped, repository, availability } = harness);

    salon = await harness.seed('salon');
    voisin = await harness.seed('voisin');
  });

  afterAll(async () => {
    await harness?.close();
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
   *
   * Le cas concurrent — plusieurs reports du même rendez-vous — est dans
   * `appointments-exclusion.concurrency-spec.ts`.
   */
  describe('le report — annulation et création liées', () => {
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
   * Deux choses ne se prouvent qu'ici :
   *
   * 1. **le créneau est réservable dès le `COMMIT`.** Aucune purge, aucune
   *    invalidation : la ligne quitte le filtre partiel de la contrainte, et
   *    c'est tout. Le double en mémoire reproduit cet effet ; seul PostgreSQL
   *    prouve que l'index le fait vraiment ;
   * 2. **la trace est bien écrite en base**, sur les trois colonnes que le
   *    deuxième critère du ticket nomme — et sur le bon type d'énumération, ce
   *    qu'aucun test unitaire ne peut vérifier.
   *
   * Le cas concurrent — plusieurs annulations du même rendez-vous — est dans
   * `appointments-exclusion.concurrency-spec.ts`.
   */
  describe('l’annulation — trace écrite et créneau rendu', () => {
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

  /**
   * L'exclusion d'un rendez-vous nommé de la lecture qui **propose** (#316).
   *
   * Le paramètre vit dans `AvailabilityRepository.listBookedRanges`, mais ce
   * qu'il faut prouver porte sur cette table-ci et sur son `where` scopé : que
   * l'identifiant retire bien la ligne visée, et qu'un identifiant de
   * l'établissement voisin n'en retire aucune. Un double en mémoire ne prouverait
   * ici que sa propre complaisance.
   *
   * Ce que cette lecture ne décide pas, et qui est le point du ticket :
   * l'unicité. Elle sert à proposer ; `appointments_no_overlap` tranche —
   * `appointments-exclusion.concurrency-spec.ts` le vérifie sous course.
   */
  describe('l’exclusion d’un rendez-vous nommé de la lecture qui propose', () => {
    /** Une journée à elle, pour que les cas ne se marchent pas dessus. */
    const MORNING = new Date('2027-03-08T09:00:00.000Z');
    const NOON = new Date('2027-03-08T12:00:00.000Z');
    const DAY = { from: new Date('2027-03-08T00:00:00.000Z'), to: new Date('2027-03-09T00:00:00.000Z') };

    it('retire la ligne nommée, et ne retire qu’elle', async () => {
      const first = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, MORNING, new Date(MORNING.getTime() + ONE_HOUR))),
      );
      const second = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, NOON, new Date(NOON.getTime() + ONE_HOUR))),
      );

      const withoutExclusion = await inTenant(salon.tenantId, () =>
        availability.listBookedRanges([salon.staffId], DAY),
      );
      expect(withoutExclusion.map((range) => range.startsAt.toISOString())).toEqual([
        MORNING.toISOString(),
        NOON.toISOString(),
      ]);

      const excluded = await inTenant(salon.tenantId, () =>
        availability.listBookedRanges([salon.staffId], DAY, first.id),
      );
      // Le créneau du matin redevient proposable ; celui de midi reste pris.
      expect(excluded.map((range) => range.startsAt.toISOString())).toEqual([NOON.toISOString()]);
      expect(second.id).not.toBe(first.id);
    });

    it('ne retire rien avec l’identifiant d’un rendez-vous de l’établissement voisin', async () => {
      // Le protocole de tenant-isolation §6 appliqué au paramètre : la ligne
      // existe, chez le voisin, et son identifiant est vrai. Le `where` scopé
      // fait qu'il ne désigne rien ici — ni retrait, ni lecture, ni différence
      // observable qui ferait de ce paramètre une sonde d'existence (§4).
      const start = new Date('2027-03-09T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const window = {
        from: new Date('2027-03-09T00:00:00.000Z'),
        to: new Date('2027-03-10T00:00:00.000Z'),
      };

      await inTenant(salon.tenantId, () => repository.create(draft(salon, start, end)));
      const neighbour = await inTenant(voisin.tenantId, () =>
        repository.create(draft(voisin, start, end)),
      );

      const ranges = await inTenant(salon.tenantId, () =>
        availability.listBookedRanges([salon.staffId], window, neighbour.id),
      );

      expect(ranges.map((range) => range.startsAt.toISOString())).toEqual([start.toISOString()]);
      expect(ranges.every((range) => range.staffId === salon.staffId)).toBe(true);
    });
  });

  /**
   * La fiche cliente, écrite par `crm` **dans la transaction du rendez-vous**
   * (#313).
   *
   * Quatre choses ne se prouvent qu'ici, contre un vrai moteur :
   *
   * 1. le `ROLLBACK` d'un créneau refusé **emporte la fiche**. C'est le deuxième
   *    critère du ticket, et il n'est tenu par aucun code applicatif : il est tenu
   *    par la transaction ;
   * 2. une adresse portée par un compte du personnel est refusée par un 409
   *    choisi, jamais par le `P2002` nu que `@@unique([tenantId, email])`
   *    produirait — donc jamais par un 500 ;
   * 3. la frontière du tenant tient sur cette écriture aussi : deux salons qui
   *    reçoivent la **même** adresse obtiennent deux fiches distinctes, et aucun
   *    ne voit celle de l'autre ;
   * 4. le rôle jugé est celui de l'instant de l'insertion, et non celui d'un
   *    instantané antérieur (#468) — la lecture est descendue au SQL brut, sous
   *    `FOR SHARE` et sous son propre filtre `tenant_id`, et un double en mémoire
   *    ne dit que ce que la requête *demande*, jamais ce que le moteur en fait.
   */
  describe('la fiche cliente et la transaction du rendez-vous (#313)', () => {
    /** Les lignes `users` de cet établissement portant cette adresse. */
    async function filesFor(fixture: Fixture, email: string): Promise<{ id: string }[]> {
      return prismaUnscoped.user.findMany({
        where: { tenantId: fixture.tenantId, email },
        select: { id: true },
      });
    }

    it('écrit la fiche et le rendez-vous d’un même `COMMIT`', async () => {
      const start = new Date('2027-01-11T09:00:00.000Z');
      const email = `nouvelle-${start.getTime()}@example.test`;

      const created = await inTenant(salon.tenantId, () =>
        repository.create(
          draft(salon, start, new Date(start.getTime() + ONE_HOUR), salon.staffId, email),
        ),
      );

      const [file] = await filesFor(salon, email);
      expect(file).toBeDefined();
      expect(created.clientId).toBe(file?.id);
    });

    it('n’en laisse aucune derrière un créneau refusé — le `ROLLBACK` l’emporte', async () => {
      // Le scénario exact du ticket : la course est perdue **après** que la fiche
      // a été écrite, puisque c'est l'insertion du rendez-vous que la contrainte
      // refuse. Avant #313, la fiche était validée dans une transaction à part et
      // survivait au refus — une écriture publique laissée au fichier du salon.
      const start = new Date('2027-01-12T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const email = `perdante-${start.getTime()}@example.test`;

      await inTenant(salon.tenantId, () => repository.create(draft(salon, start, end)));

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(draft(salon, start, end, salon.staffId, email)),
        ),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

      expect(await filesFor(salon, email)).toEqual([]);
    });

    it('laisse intacte une fiche préexistante quand le créneau est refusé', async () => {
      // Le `ROLLBACK` ne défait que ce que **cette** transaction a écrit : une
      // cliente déjà fichée ne perd pas son historique parce qu'elle vient de
      // perdre une course.
      const start = new Date('2027-01-13T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);

      await inTenant(salon.tenantId, () => repository.create(draft(salon, start, end)));

      await expect(
        inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
      ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

      expect(await filesFor(salon, salon.clientEmail)).toHaveLength(1);
    });

    it('refuse une adresse portée par un compte du personnel, et sans 500', async () => {
      // `@@unique([tenantId, email])` interdit une seconde ligne sous cette
      // adresse : sans la décision explicite de #313, cette réservation sortait en
      // `P2002` nu. Elle sort en 409 nommé, et rien n'est écrit.
      const start = new Date('2027-01-14T09:00:00.000Z');

      const refused = await inTenant(salon.tenantId, () =>
        repository
          .create(
            draft(
              salon,
              start,
              new Date(start.getTime() + ONE_HOUR),
              salon.staffId,
              salon.managerEmail,
            ),
          )
          .catch((error: unknown) => error),
      );

      expect(refused).toMatchObject({ code: 'CLIENT_EMAIL_NOT_BOOKABLE', status: 409 });
      expect(
        await prismaUnscoped.appointment.count({
          where: { tenantId: salon.tenantId, startsAt: start },
        }),
      ).toBe(0);
      // Le compte de la gérante est resté seul, et son rôle n'a pas bougé.
      expect(
        await prismaUnscoped.user.findMany({
          where: { tenantId: salon.tenantId, email: salon.managerEmail },
          select: { role: true },
        }),
      ).toEqual([{ role: 'MANAGER' }]);
    });

    it('juge le rôle **au moment de l’insertion**, pas celui d’avant (#468)', async () => {
      // Le pendant, côté tunnel public, du cas que #465 a écrit pour le comptoir
      // — et ce que #468 est venu tenir. La résolution relit le rôle **dans** la
      // transaction, sous `FOR SHARE`, et ne s'appuie sur rien qui ait été lu
      // ailleurs : une fiche promue au personnel entre deux réservations ne passe
      // plus, alors que les deux clés étrangères de `appointments.client_id` —
      // existence et établissement — resteraient parfaitement satisfaites.
      //
      // Un double en mémoire ne prouverait rien ici : il ne dirait que ce que la
      // requête *demande*, jamais ce que le moteur en fait.
      const première = new Date('2027-01-18T09:00:00.000Z');
      const seconde = new Date('2027-01-18T14:00:00.000Z');
      const email = `promue-${première.getTime()}@example.test`;

      const booked = await inTenant(salon.tenantId, () =>
        repository.create(
          draft(salon, première, new Date(première.getTime() + ONE_HOUR), salon.staffId, email),
        ),
      );

      await prismaUnscoped.user.update({
        where: { id: booked.clientId },
        data: { role: 'STAFF' },
      });

      const refused = await inTenant(salon.tenantId, () =>
        repository
          .create(
            draft(salon, seconde, new Date(seconde.getTime() + ONE_HOUR), salon.staffId, email),
          )
          .catch((error: unknown) => error),
      );

      expect(refused).toMatchObject({ code: 'CLIENT_EMAIL_NOT_BOOKABLE', status: 409 });
      // Le refus est prononcé **dans** la transaction : il n'y a rien à défaire.
      expect(
        await prismaUnscoped.appointment.count({
          where: { tenantId: salon.tenantId, startsAt: seconde },
        }),
      ).toBe(0);
    });

    it('ne partage jamais une fiche entre deux établissements', async () => {
      // Le cinquième critère du ticket. L'unicité de l'adresse est
      // `(tenant_id, email)` : la même personne cliente de deux salons a deux
      // fiches, et un historique par salon. Depuis #468 la résolution lit en SQL
      // brut, sous `FOR SHARE` : ce n'est donc plus l'extension de scoping qui
      // borne cette lecture — elle ne couvre pas le SQL brut (ADR 0006) — mais le
      // `tenant_id = …` que `resolveClientWithin` écrit lui-même depuis le
      // contexte de requête. C'est ce filtre-là qu'on exerce ici.
      const start = new Date('2027-01-15T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const email = `partagee-${start.getTime()}@example.test`;

      const chezSalon = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end, salon.staffId, email)),
      );
      const chezVoisin = await inTenant(voisin.tenantId, () =>
        repository.create(draft(voisin, start, end, voisin.staffId, email)),
      );

      expect(chezSalon.clientId).not.toBe(chezVoisin.clientId);
      expect(await filesFor(salon, email)).toEqual([{ id: chezSalon.clientId }]);
      expect(await filesFor(voisin, email)).toEqual([{ id: chezVoisin.clientId }]);
    });

    it('ne réutilise pas la fiche du voisin, même adresse et même instant', async () => {
      // Le pendant écrit du cas précédent : semée **chez le voisin uniquement**,
      // l'adresse doit rester introuvable depuis le salon — donc donner lieu à une
      // création, jamais à une réutilisation par-dessus la frontière.
      const start = new Date('2027-01-16T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const email = `voisine-${start.getTime()}@example.test`;

      const chezVoisin = await inTenant(voisin.tenantId, () =>
        repository.create(draft(voisin, start, end, voisin.staffId, email)),
      );
      const chezSalon = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, end, salon.staffId, email)),
      );

      expect(chezSalon.clientId).not.toBe(chezVoisin.clientId);
    });

    it('un report ne résout aucune fiche : il recopie celle du rendez-vous d’origine', async () => {
      // Reporter ne change pas la cliente (#39). Un report qui repasserait par la
      // porte `crm` créerait une fiche depuis des coordonnées que la demande ne
      // porte même pas.
      const start = new Date('2027-01-17T09:00:00.000Z');
      const target = new Date('2027-01-17T14:00:00.000Z');
      const email = `reportee-${start.getTime()}@example.test`;

      const booked = await inTenant(salon.tenantId, () =>
        repository.create(
          draft(salon, start, new Date(start.getTime() + ONE_HOUR), salon.staffId, email),
        ),
      );

      const outcome = await inTenant(salon.tenantId, () =>
        repository.reschedule(
          move(booked.id, target, new Date(target.getTime() + ONE_HOUR), salon.staffId),
        ),
      );

      expect(outcome.created.clientId).toBe(booked.clientId);
      expect(await filesFor(salon, email)).toHaveLength(1);
    });
  });

  /**
   * La fiche **désignée** du comptoir, et la frontière du tenant (#461, #465).
   *
   * Ce que seule une vraie base peut établir : que `{ clientId }` n'ouvre aucun
   * chemin autour de la frontière du tenant. Aucune comparaison n'est écrite
   * dans `AppointmentsRepository` : depuis #465, c'est la porte de `crm`
   * (`assertBookableWithin`) qui refuse la ligne, sous son propre filtre
   * `tenant_id`, et `appointments_client_id_fkey` /
   * `appointments_tenant_id_client_id_fkey` restent le filet en dessous — le
   * repository traduisant les deux refus dans le même 404.
   *
   * Un double en mémoire ne prouverait rien ici : il reproduirait la conclusion
   * qu'on cherche à vérifier.
   */
  describe('la fiche cliente désignée par le comptoir', () => {
    it('pose le rendez-vous sans créer aucune fiche quand elle est du salon', async () => {
      const start = new Date('2027-02-03T09:00:00.000Z');
      const avant = await prismaUnscoped.user.count({ where: { tenantId: salon.tenantId } });

      const created = await inTenant(salon.tenantId, () =>
        repository.create(deskDraft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      expect(created.clientId).toBe(salon.clientId);
      // Le comptoir désigne, il ne crée pas : la porte `crm` ne fait que
      // confirmer la fiche (#465), et l'annuaire du salon ne bouge pas d'une
      // ligne.
      expect(await prismaUnscoped.user.count({ where: { tenantId: salon.tenantId } })).toBe(avant);
    });

    it('rend 404 pour une fiche qui n’existe nulle part', async () => {
      const start = new Date('2027-02-04T09:00:00.000Z');

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(
            deskDraft(
              salon,
              start,
              new Date(start.getTime() + ONE_HOUR),
              salon.staffId,
              '99999999-9999-4999-8999-999999999999',
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rend le même 404 pour la fiche du salon voisin, et n’écrit rien', async () => {
      const start = new Date('2027-02-05T09:00:00.000Z');

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(
            deskDraft(
              salon,
              start,
              new Date(start.getTime() + ONE_HOUR),
              salon.staffId,
              // Tout est du salon, sauf la cliente : c'est le seul champ qui
              // tente la traversée, et le `tenant_id` du contrôle de `crm` le
              // refuse — la clé étrangère composite restant le filet dessous.
              voisin.clientId,
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 404 et non 403 : les deux refus doivent être indiscernables, faute de
      // quoi la différence sert de sonde d'annuaire (tenant-isolation §4). Et
      // rien n'a été écrit — un `ROLLBACK`, pas une ligne orpheline.
      const posées = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, startsAt: start },
      });
      expect(posées).toBe(0);
    });
  });

  /**
   * Le **rôle** de la fiche désignée, que les clés étrangères ne savent pas
   * juger (#465).
   *
   * `appointments.client_id` référence `users`, où vivent aussi les comptes
   * `STAFF`, `MANAGER` et `ADMIN` : les deux clés composites prouvent que la
   * ligne existe et qu'elle est du bon établissement, jamais qu'elle est au
   * **fichier client**. Un membre du personnel qui posait l'identifiant d'un
   * collègue obtenait donc un rendez-vous parfaitement valide, invisible dans
   * l'annuaire CRM — qui filtre sur `role = CLIENT` — et pourtant compté comme
   * cliente par le reporting.
   *
   * Ce que seule une vraie base peut établir ici : que la porte de `crm` lit bien
   * la colonne `role` de la ligne visée, sous le filtre `tenant_id` qu'elle écrit
   * elle-même — le SQL brut ne repassant pas par l'extension de scoping —, et que
   * son refus s'inscrit dans la transaction d'insertion : un `ROLLBACK`, pas une
   * ligne à défaire.
   */
  describe('le rôle de la fiche désignée par le comptoir', () => {
    /** Un compte de ce rôle dans le salon, et son identifiant `users`. */
    async function accountOf(role: 'CLIENT' | 'STAFF' | 'MANAGER' | 'ADMIN'): Promise<string> {
      const account = await prismaUnscoped.user.create({
        data: {
          tenantId: salon.tenantId,
          email: `role-${role.toLowerCase()}-${randomUUID()}@example.test`,
          role,
          firstName: 'Alix',
          lastName: role,
        },
      });
      return account.id;
    }

    /**
     * Un instant libre, propre à chaque cas — les créneaux ne se marchent pas
     * dessus.
     *
     * Juin 2027 parce que le reste de la suite s'étale sur janvier, février et
     * mars : un compteur qui empiéterait sur une journée déjà réservée par un
     * autre cas rendrait un 409 de créneau là où on attend un refus de fiche,
     * c'est-à-dire un échec qui ne parle pas de ce qu'il teste.
     */
    let next = new Date('2027-06-01T09:00:00.000Z').getTime();
    function freeSlot(): { startsAt: Date; endsAt: Date } {
      next += 24 * 60 * 60 * 1000;
      return { startsAt: new Date(next), endsAt: new Date(next + ONE_HOUR) };
    }

    it('accepte une fiche de rôle CLIENT', async () => {
      const clientId = await accountOf('CLIENT');
      const { startsAt, endsAt } = freeSlot();

      const created = await inTenant(salon.tenantId, () =>
        repository.create(deskDraft(salon, startsAt, endsAt, salon.staffId, clientId)),
      );

      expect(created.clientId).toBe(clientId);
    });

    it.each(['STAFF', 'MANAGER', 'ADMIN'] as const)(
      'refuse en 404 un compte %s de l’établissement, et n’écrit rien',
      async (role) => {
        const compte = await accountOf(role);
        const { startsAt, endsAt } = freeSlot();

        await expect(
          inTenant(salon.tenantId, () =>
            repository.create(deskDraft(salon, startsAt, endsAt, salon.staffId, compte)),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);

        // Le refus est prononcé **dans** la transaction : il n'y a rien à
        // défaire, et surtout rien à oublier de défaire.
        const posées = await prismaUnscoped.appointment.count({
          where: { tenantId: salon.tenantId, startsAt },
        });
        expect(posées).toBe(0);
      },
    );

    it('rend le même refus qu’une fiche inconnue — même classe, même message', async () => {
      // L'arbitrage du ticket : « inconnu ici », « du salon voisin » et « compte
      // du personnel » sont indistinctement 404. Un code dédié aurait fait de
      // cette route une sonde de l'annuaire du personnel, interrogeable
      // identifiant par identifiant par n'importe quel porteur de jeton `STAFF`.
      const compte = await accountOf('MANAGER');

      const refusDuRôle = await inTenant(salon.tenantId, () => {
        const { startsAt, endsAt } = freeSlot();
        return repository.create(deskDraft(salon, startsAt, endsAt, salon.staffId, compte));
      }).catch((error: unknown) => error);

      const refusInconnu = await inTenant(salon.tenantId, () => {
        const { startsAt, endsAt } = freeSlot();
        return repository.create(
          deskDraft(
            salon,
            startsAt,
            endsAt,
            salon.staffId,
            '99999999-9999-4999-8999-999999999999',
          ),
        );
      }).catch((error: unknown) => error);

      expect(refusDuRôle).toBeInstanceOf(NotFoundError);
      expect(refusInconnu).toBeInstanceOf(NotFoundError);
      expect((refusDuRôle as NotFoundError).message).toBe((refusInconnu as NotFoundError).message);
    });

    it('ne laisse pas le compte du personnel **du voisin** franchir la frontière', async () => {
      // Deux raisons de refuser cumulées — mauvais établissement, mauvais rôle —
      // et un seul refus : le `where` du contrôle porte `tenant_id`, la ligne ne
      // remonte donc pas du tout, et le rôle n'a même pas à être jugé.
      const compteVoisin = await prismaUnscoped.user.create({
        data: {
          tenantId: voisin.tenantId,
          email: `manager-voisin-${randomUUID()}@example.test`,
          role: 'MANAGER',
          firstName: 'Manon',
          lastName: 'Voisine',
        },
      });
      const { startsAt, endsAt } = freeSlot();

      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(deskDraft(salon, startsAt, endsAt, salon.staffId, compteVoisin.id)),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('juge le rôle **au moment de l’insertion**, pas celui d’avant', async () => {
      // Le second critère du ticket. Une fiche cliente promue au personnel avant
      // l'appel ne doit plus passer, même si elle était parfaitement réservable
      // la seconde d'avant : le contrôle relit la ligne dans la transaction, il
      // ne s'appuie sur rien qui ait été lu ailleurs.
      const fiche = await accountOf('CLIENT');
      const première = freeSlot();

      await inTenant(salon.tenantId, () =>
        repository.create(
          deskDraft(salon, première.startsAt, première.endsAt, salon.staffId, fiche),
        ),
      );

      await prismaUnscoped.user.update({ where: { id: fiche }, data: { role: 'STAFF' } });

      const seconde = freeSlot();
      await expect(
        inTenant(salon.tenantId, () =>
          repository.create(
            deskDraft(salon, seconde.startsAt, seconde.endsAt, salon.staffId, fiche),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
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
