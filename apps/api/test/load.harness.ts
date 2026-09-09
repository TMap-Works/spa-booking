import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { TenantContextService } from '../src/common/tenant/tenant-context.service';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import { ServicesService } from '../src/modules/catalog/services.service';
import { AvailabilityCacheService } from '../src/modules/availability/availability-cache';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { AvailabilityService } from '../src/modules/availability/availability.service';
import { StaffScheduleService } from '../src/modules/availability/staff-schedule.service';
import { StaffTimeOffRepository } from '../src/modules/availability/staff-time-off.repository';
import { StaffTimeOffService } from '../src/modules/availability/staff-time-off.service';
import { TenantClockService } from '../src/modules/availability/tenant-clock.service';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import type { AppointmentDraft } from '../src/modules/appointments/appointments.types';
import { ClientDirectoryService } from '../src/modules/crm/client-directory.service';
import { CrmRepository } from '../src/modules/crm/crm.repository';
import { MemoryAvailabilityCacheStore } from './availability-endpoint.harness';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';
import { inTenant } from './utils/tenant-scope';

/**
 * Le décor des **tests de charge** du moteur de disponibilité et du tunnel de
 * réservation — troisième critère de #83, et la mesure du risque n°1 du projet
 * (CDC §6, contrainte non négociable n°4 du CLAUDE.md).
 *
 * ## Ce que ces suites ajoutent à `test:concurrency`
 *
 * `appointments-exclusion.concurrency-spec.ts` prouve une **propriété** : huit
 * écritures parallèles sur un créneau produisent exactement un rendez-vous. Elle
 * ne dit rien de ce que cela **coûte**, ni de ce qui se passe quand la charge
 * n'est plus huit tentatives mais deux cents. Un moteur qui rendrait le bon
 * résultat en huit secondes tiendrait cette suite et ne tiendrait pas un samedi
 * matin.
 *
 * Les suites de charge mesurent donc, et rapportent des chiffres : débit,
 * latences p50/p95/p99, taux de conflit **attendu** confronté au taux observé.
 * L'invariant anti-double-réservation y est revérifié à chaque scénario, non
 * parce qu'il serait douteux — la contrainte d'exclusion le tient — mais parce
 * qu'une mesure de débit qui l'aurait perdu en route ne mesurerait plus rien.
 *
 * ## Pourquoi pas un outil de charge externe
 *
 * Ni k6, ni Artillery, ni JMeter : ils tirent sur une **application servie**,
 * donc sur un environnement déployé, et ce dépôt n'en a aucun à sa disposition
 * (#588). Ce qu'ils mesureraient en local serait surtout le coût de la boucle
 * HTTP de la machine de développement.
 *
 * Le montage retenu est celui qui existe déjà et qui a le mérite d'être
 * reproductible : une base PostgreSQL **jetable** démarrée par la suite
 * (Testcontainers), les vrais repositories, le vrai moteur, et la charge
 * appliquée là où le risque vit — la transaction d'insertion et les six lectures
 * du calcul de créneaux. Ce que la mesure ignore est explicite : le coût du
 * réseau, celui de l'ALB, celui de la sérialisation HTTP. Une campagne de tirs
 * de bout en bout reste à jouer sur staging, et c'est l'objet de la recette
 * décrite dans `docs/recette/cahier-de-recette-mvp.md`.
 *
 * ## Les chiffres dépendent de la machine, les invariants non
 *
 * C'est la raison pour laquelle les assertions de ces suites portent sur les
 * **invariants** — un succès par créneau, zéro chevauchement en base, zéro
 * erreur de lecture — et sur des plafonds de latence délibérément larges, qui ne
 * se déclenchent que sur une régression d'ordre de grandeur. Le poste d'un
 * développeur, un agent de jalon qui partage sa machine avec deux autres et un
 * exécuteur GitHub n'ont pas le même débit : un seuil serré y serait un
 * générateur d'échecs sans rapport avec le code.
 *
 * Les chiffres, eux, sont **imprimés** (`renderMeasureTable`) : c'est le relevé
 * qu'une campagne consigne, et ce qui rend une dérive visible d'un run à
 * l'autre.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre — même régime que le harnais
 * d'exclusion voisin. `DATABASE_URL` n'est pas lue.
 */

/** Une heure, en millisecondes. */
export const ONE_HOUR = 3_600_000;

/** Une minute, en millisecondes. */
export const ONE_MINUTE = 60_000;

/**
 * Le dimensionnement d'un scénario, réglable par l'environnement.
 *
 * Les valeurs par défaut tiennent en quelques dizaines de secondes sur un poste
 * ordinaire — c'est ce qui permet à `npm run test:load` d'être joué avant une
 * mise en production sans immobiliser personne. Une **campagne** relève les
 * dials sans toucher au code :
 *
 * ```bash
 * SPA_LOAD_FACTOR=5 npm run test:load --workspace @spa/api
 * ```
 *
 * Le facteur multiplie les volumes, jamais la concurrence : celle-ci est bornée
 * par le pool de connexions Prisma, et la pousser au-delà mesurerait l'attente
 * dans le pool plutôt que le moteur.
 */
export function loadFactor(): number {
  const raw = process.env.SPA_LOAD_FACTOR;

  if (raw === undefined || raw.trim() === '') {
    return 1;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Le nombre d'opérations menées de front.
 *
 * Seize, et non deux cents : le pool de connexions par défaut de Prisma vaut
 * `2 × cœurs + 1`, et l'URL de la base jetable le porte à vingt ci-dessous. Une
 * concurrence supérieure au pool ne charge plus PostgreSQL — elle fait la queue
 * dans le pool, et la latence mesurée devient celle de cette file. Ce que l'on
 * veut mesurer est le moteur, pas le client.
 */
export const CONCURRENCY = 16;

/** Le décor rendu à une suite de charge. */
export interface LoadHarness {
  /** La racine non scopée : elle sème et **observe**, sans le filtre du tenant. */
  readonly prismaUnscoped: PrismaClient;
  /** Le moteur de disponibilité, réellement câblé sur la base. */
  readonly engine: AvailabilityService;
  /** Le dépôt du tunnel de réservation, branché sur le client scopé. */
  readonly appointments: AppointmentsRepository;
  /** Sème un établissement gréé pour la charge. */
  seed(options?: Partial<SalonShape>): Promise<Salon>;
  /** Déconnecte Prisma puis détruit la base jetable — et son conteneur. */
  close(): Promise<void>;
}

/** Le gabarit de l'établissement semé. */
export interface SalonShape {
  /** Nombre de praticiens, tous affectés à la prestation. */
  readonly staffCount: number;
  /** Première journée civile ouvrable de l'agenda (`YYYY-MM-DD`). */
  readonly firstDay: string;
  /** Nombre de journées civiles consécutives couvertes par les horaires. */
  readonly days: number;
  /** Minute d'ouverture, depuis minuit local. */
  readonly openMinute: number;
  /** Minute de fermeture, depuis minuit local. */
  readonly closeMinute: number;
  /** Durée de la prestation, en minutes. */
  readonly durationMinutes: number;
  /**
   * Rendez-vous déjà posés au moment de la mesure, par praticien.
   *
   * Ils ne sont pas décoratifs : sans agenda garni, `listBookedRanges` rend zéro
   * ligne et la soustraction des occupations ne coûte rien. Un moteur mesuré sur
   * un salon vide est mesuré sur le cas qui n'arrive jamais.
   */
  readonly bookedPerStaff: number;
}

/** L'établissement semé, et de quoi y réserver. */
export interface Salon {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientEmail: string;
  readonly serviceId: string;
  readonly staffIds: readonly string[];
  readonly shape: SalonShape;
}

const DEFAULT_SHAPE: SalonShape = {
  staffCount: 4,
  // Un lundi, délibérément : les horaires sont posés du lundi au samedi, et
  // partir un dimanche donnerait une première journée vide qui fausserait la
  // lecture des relevés.
  firstDay: '2027-03-01',
  days: 7,
  openMinute: 9 * 60,
  closeMinute: 19 * 60,
  durationMinutes: 60,
  bookedPerStaff: 12,
};

/**
 * Ouvre une base jetable, y câble le moteur et le tunnel, et rend de quoi semer.
 *
 * Le pool de connexions est porté à vingt sur l'URL : la valeur par défaut de
 * Prisma dépend du nombre de cœurs, ce qui ferait dépendre le **relevé** de la
 * machine bien plus que le moteur ne le fait. Vingt dépasse la concurrence de
 * mesure de quatre, marge suffisante pour que le pool ne soit jamais la
 * contrainte.
 */
export async function createLoadHarness(): Promise<LoadHarness> {
  const database: DisposableDatabase = await createDisposableDatabase();
  const url = new URL(database.url);
  url.searchParams.set('connection_limit', '20');
  url.searchParams.set('pool_timeout', '30');

  const prismaUnscoped = new PrismaClient({ datasourceUrl: url.toString(), errorFormat: 'minimal' });

  try {
    await prismaUnscoped.$connect();
    // Une requête réelle, et non seulement `$connect` : c'est elle qui prouve
    // que le schéma est en place. Même précaution que le harnais d'exclusion.
    await prismaUnscoped.tenant.count();
  } catch (error: unknown) {
    await prismaUnscoped.$disconnect().catch(() => undefined);
    await database.drop();
    throw error;
  }

  // Le cache de disponibilité est **en mémoire** ici, et il n'entre dans aucune
  // mesure : `slotsFor` ne le lit ni ne l'écrit — c'est `AvailabilityQueryService`
  // qui l'enveloppe, et lui n'est pas sous test. Il est câblé parce que les deux
  // services d'horaires l'exigent à la construction pour leurs **écritures**, que
  // ces suites ne font pas. Le monter en Redis n'apprendrait donc rien et
  // ouvrirait une connexion pour rien.
  const cache = new AvailabilityCacheService(
    new MemoryAvailabilityCacheStore(),
    new TenantContextService(),
  );
  const clock = new TenantClockService();
  const availabilityRepository = new AvailabilityRepository(createScopedPrismaClient(prismaUnscoped));
  const schedules = new StaffScheduleService(availabilityRepository, clock, cache);
  const timeOff = new StaffTimeOffService(
    new StaffTimeOffRepository(createScopedPrismaClient(prismaUnscoped)),
    cache,
  );
  const services = new ServicesService(new CatalogRepository(createScopedPrismaClient(prismaUnscoped)));
  const clients = new ClientDirectoryService(
    new CrmRepository(createScopedPrismaClient(prismaUnscoped)),
  );

  return {
    prismaUnscoped,
    engine: new AvailabilityService(availabilityRepository, schedules, timeOff, services, clock),
    appointments: new AppointmentsRepository(createScopedPrismaClient(prismaUnscoped), clients),
    seed: (options: Partial<SalonShape> = {}) =>
      seedSalon(prismaUnscoped, { ...DEFAULT_SHAPE, ...options }),
    close: async () => {
      try {
        await prismaUnscoped.$disconnect();
      } finally {
        await database.drop();
      }
    },
  };
}

/** Sème un établissement gréé pour la charge, et rend de quoi y réserver. */
async function seedSalon(prismaUnscoped: PrismaClient, shape: SalonShape): Promise<Salon> {
  const tenant = await prismaUnscoped.tenant.create({
    data: {
      slug: `load-${randomUUID()}`,
      name: 'Salon de charge',
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
      slotIntervalMinutes: 15,
      // Zéro préavis : les scénarios visent des dates de 2027, le préavis
      // n'écarterait donc rien — mais le poser à zéro rend le relevé
      // indépendant du réglage par défaut, qui peut changer.
      minBookingNoticeMinutes: 0,
    },
  });

  const clientEmail = `cliente-${randomUUID()}@example.test`;
  const client = await prismaUnscoped.user.create({
    data: {
      tenantId: tenant.id,
      email: clientEmail,
      role: 'CLIENT',
      firstName: 'Alice',
      lastName: 'Martin',
    },
  });

  const service = await prismaUnscoped.service.create({
    data: {
      tenantId: tenant.id,
      slug: `soin-${randomUUID().slice(0, 8)}`,
      name: `Soin ${shape.durationMinutes} min`,
      durationMinutes: shape.durationMinutes,
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    },
  });

  const staffIds: string[] = [];

  for (let index = 0; index < shape.staffCount; index += 1) {
    const account = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `praticien-${randomUUID()}@example.test`,
        role: 'STAFF',
        firstName: `Praticien${index}`,
        lastName: 'Charge',
      },
    });
    const profile = await prismaUnscoped.staff.create({
      data: { tenantId: tenant.id, userId: account.id, displayName: `Praticien ${index}` },
    });

    // Du lundi au samedi — `weekday` est en numérotation ISO 8601, 1 lundi à
    // 7 dimanche. Le dimanche reste fermé : un salon qui ouvrirait sept jours
    // sur sept rendrait le relevé moins lisible sans rien prouver de plus.
    await prismaUnscoped.staffSchedule.createMany({
      data: [1, 2, 3, 4, 5, 6].map((weekday) => ({
        tenantId: tenant.id,
        staffId: profile.id,
        weekday,
        startMinute: shape.openMinute,
        endMinute: shape.closeMinute,
      })),
    });

    await prismaUnscoped.serviceStaff.create({
      data: { tenantId: tenant.id, serviceId: service.id, staffId: profile.id },
    });

    staffIds.push(profile.id);
  }

  await fillAgenda(prismaUnscoped, tenant.id, {
    clientId: client.id,
    serviceId: service.id,
    staffIds,
    shape,
  });

  return {
    tenantId: tenant.id,
    clientId: client.id,
    clientEmail,
    serviceId: service.id,
    staffIds,
    shape,
  };
}

/**
 * Garnit l'agenda de rendez-vous déjà pris, en écriture directe.
 *
 * Directe, et non par le tunnel : ce qui est semé n'est pas ce qui est mesuré,
 * et faire passer douze rendez-vous par praticien dans la transaction verrouillée
 * du tunnel allongerait l'amorçage sans rien apprendre. La contrainte
 * d'exclusion juge malgré tout chacune de ces lignes — un amorçage qui se
 * chevaucherait lui-même échouerait ici, avant la première mesure.
 */
async function fillAgenda(
  prismaUnscoped: PrismaClient,
  tenantId: string,
  fixture: {
    readonly clientId: string;
    readonly serviceId: string;
    readonly staffIds: readonly string[];
    readonly shape: SalonShape;
  },
): Promise<void> {
  const { shape } = fixture;

  if (shape.bookedPerStaff === 0) {
    return;
  }

  const rows: {
    tenantId: string;
    clientId: string;
    staffId: string;
    serviceId: string;
    startsAt: Date;
    endsAt: Date;
    priceAmountMinor: number;
    priceCurrency: string;
  }[] = [];

  // Une cadence par rendez-vous, jamais inférieure à la durée de la prestation :
  // un pas d'une heure sur un soin de quatre-vingt-dix minutes ferait se
  // chevaucher deux lignes voisines, et `appointments_no_overlap` abattrait
  // l'amorçage avant la première mesure. `durationMinutes` est réglable par
  // `SalonShape` — le pas doit la suivre.
  const stepMinutes = Math.max(shape.durationMinutes, 60);
  // Deux heures de marge : une à l'ouverture, une avant la fermeture. `Math.max`
  // borne à un pour qu'une fenêtre d'ouverture trop courte rende un agenda
  // maigre plutôt qu'une division par zéro et des dates `Invalid Date`.
  const slotsPerDay = Math.max(
    1,
    Math.floor((shape.closeMinute - shape.openMinute - 120) / stepMinutes),
  );

  for (const staffId of fixture.staffIds) {
    for (let index = 0; index < shape.bookedPerStaff; index += 1) {
      // Un rendez-vous par pas, en repartant à l'ouverture chaque fois que la
      // journée est pleine. Les bornes sont produites en UTC à partir de la
      // journée civile : le salon est à `Europe/Paris`, l'offset de mars 2027
      // vaut +01:00 avant le changement d'heure, et l'amorçage n'a pas besoin
      // d'être à la minute — il a besoin d'être **dans** les fenêtres de
      // travail, ce que la marge de deux heures ci-dessus garantit.
      const day = Math.floor(index / slotsPerDay) % shape.days;
      const offset = index % slotsPerDay;
      const startsAt = new Date(
        Date.parse(`${addDays(shape.firstDay, day)}T00:00:00.000Z`) +
          (shape.openMinute + 60) * ONE_MINUTE +
          offset * stepMinutes * ONE_MINUTE,
      );

      rows.push({
        tenantId,
        clientId: fixture.clientId,
        staffId,
        serviceId: fixture.serviceId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + shape.durationMinutes * ONE_MINUTE),
        priceAmountMinor: 3500,
        priceCurrency: 'EUR',
      });
    }
  }

  await prismaUnscoped.appointment.createMany({ data: rows });
}

/** La journée civile `base` décalée de `days` jours — arithmétique de calendrier. */
export function addDays(base: string, days: number): string {
  const instant = new Date(`${base}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);

  return instant.toISOString().slice(0, 10);
}

/** Un brouillon de réservation du **tunnel public** : la fiche est à résoudre. */
export function bookingDraft(
  salon: Salon,
  staffId: string,
  startsAt: Date,
  email: string = salon.clientEmail,
): AppointmentDraft {
  return {
    client: { contact: { firstName: 'Alice', lastName: 'Martin', email, phone: null } },
    staffId,
    serviceId: salon.serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + salon.shape.durationMinutes * ONE_MINUTE),
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
  };
}

/** Un créneau tel que le moteur le rend — le strict nécessaire pour y réserver. */
export interface LoadSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly staffId: string;
}

/**
 * Les créneaux **deux à deux disjoints** d'une liste, praticien par praticien.
 *
 * Le moteur propose un départ tous les quarts d'heure pour un soin d'une heure :
 * trois créneaux consécutifs d'un même praticien se chevauchent donc. Réserver la
 * liste brute ferait échouer trois tentatives sur quatre pour la bonne raison, et
 * un scénario de débit nominal ne mesurerait plus le débit nominal. Ce filtre
 * glouton rend la plus grande famille sur laquelle une réservation en masse doit
 * **toutes** aboutir.
 *
 * Écrit ici, et non dans chacune des deux suites : elles en dépendent toutes deux
 * pour désigner ce qu'elles réservent, et deux copies, c'est deux occasions d'en
 * corriger une seule.
 */
export function disjointPerStaff(slots: readonly LoadSlot[]): LoadSlot[] {
  const lastEnd = new Map<string, number>();
  const kept: LoadSlot[] = [];

  for (const slot of [...slots].sort((left, right) => left.startsAt.localeCompare(right.startsAt))) {
    if (Date.parse(slot.startsAt) >= (lastEnd.get(slot.staffId) ?? Number.NEGATIVE_INFINITY)) {
      kept.push(slot);
      lastEnd.set(slot.staffId, Date.parse(slot.endsAt));
    }
  }

  return kept;
}

/** Le relevé d'un scénario de charge. */
export interface Measure {
  readonly label: string;
  /** Opérations tentées. */
  readonly attempts: number;
  /** Opérations abouties. */
  readonly succeeded: number;
  /** Opérations refusées — un refus attendu n'est pas une erreur. */
  readonly rejected: number;
  /** Concurrence appliquée. */
  readonly concurrency: number;
  /** Durée totale du scénario, en millisecondes. */
  readonly wallMs: number;
  /** Débit, en opérations abouties par seconde. */
  readonly throughput: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Part des tentatives refusées, en pourcentage. */
  readonly conflictRate: number;
  /** Les rejets, dans l'ordre où ils sont tombés — pour les asserter. */
  readonly errors: readonly unknown[];
}

/**
 * Exécute `tasks` avec au plus `concurrency` opérations en vol, en chronométrant
 * chacune, et rend le relevé.
 *
 * Une file bornée, et non `Promise.all` sur le tout : c'est ce qui distingue une
 * mesure de charge d'une rafale. Deux cents promesses lancées ensemble mesurent
 * l'attente dans le pool de connexions ; seize en vol continu mesurent le débit
 * que le moteur soutient.
 *
 * Un rejet n'interrompt rien et n'est pas une erreur de la mesure : dans ces
 * suites, la plupart des rejets sont le refus **attendu** d'un créneau déjà pris.
 * C'est à la suite appelante de dire lesquels sont légitimes.
 */
export async function measure<T>(
  label: string,
  tasks: readonly (() => Promise<T>)[],
  options: { readonly concurrency?: number } = {},
): Promise<Measure> {
  const concurrency = options.concurrency ?? CONCURRENCY;
  const latencies: number[] = [];
  const errors: unknown[] = [];
  let succeeded = 0;
  let next = 0;

  const startedAt = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;

      const task = tasks[index];

      if (task === undefined) {
        return;
      }

      const began = performance.now();

      try {
        await task();
        succeeded += 1;
      } catch (error: unknown) {
        errors.push(error);
      } finally {
        latencies.push(performance.now() - began);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  const wallMs = performance.now() - startedAt;
  const sorted = [...latencies].sort((left, right) => left - right);

  return {
    label,
    attempts: tasks.length,
    succeeded,
    rejected: errors.length,
    concurrency,
    wallMs: round(wallMs),
    throughput: round((succeeded / wallMs) * 1000),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    conflictRate: round((errors.length / Math.max(tasks.length, 1)) * 100),
    errors,
  };
}

/** Le `p`-ième centile d'une série **déjà triée**, en millisecondes. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);

  return round(sorted[Math.max(rank, 0)] ?? 0);
}

/** Deux décimales — au-delà, on donnerait à un relevé une précision qu'il n'a pas. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Imprime les relevés sous forme de tableau markdown, sur la sortie standard.
 *
 * Sur `process.stdout` et non `console.log`, que le lint interdit — et le
 * tableau se recopie tel quel dans le journal d'une campagne ou dans le corps
 * d'une pull request, ce qui est tout l'intérêt de le rendre en markdown.
 */
export function renderMeasureTable(title: string, measures: readonly Measure[]): void {
  const lines = [
    '',
    `### ${title}`,
    '',
    '| Scénario | Tentatives | Abouties | Refusées | Concurrence | Durée (ms) | Débit (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Taux de conflit |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...measures.map(
      (m) =>
        `| ${m.label} | ${m.attempts} | ${m.succeeded} | ${m.rejected} | ${m.concurrency} | ${m.wallMs} | ${m.throughput} | ${m.p50Ms} | ${m.p95Ms} | ${m.p99Ms} | ${m.maxMs} | ${m.conflictRate} % |`,
    ),
    '',
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Le nombre de paires de rendez-vous **actifs** qui se chevauchent chez un même
 * praticien — l'invariant anti-double-réservation, relu directement en base.
 *
 * C'est la vérification qui compte, et la seule qui ne dépende pas de ce que les
 * promesses ont bien voulu dire : elle interroge la table après coup, sans passer
 * par le code qui vient d'écrire. Elle doit valoir zéro à la fin de **chaque**
 * scénario ; toute autre valeur est une double réservation, c'est-à-dire deux
 * clientes dans la même cabine.
 *
 * Le `tenant_id` est porté explicitement dans le `WHERE` — la requête passe par
 * le client non scopé, à qui l'extension n'ajoute rien (tenant-isolation §3).
 */
export async function overlappingPairs(
  prismaUnscoped: PrismaClient,
  tenantId: string,
): Promise<number> {
  const rows = await prismaUnscoped.$queryRaw<{ pairs: bigint }[]>`
    SELECT count(*)::bigint AS pairs
    FROM appointments a
    JOIN appointments b
      ON b.tenant_id = a.tenant_id
     AND b.staff_id = a.staff_id
     AND b.id > a.id
     AND b.time_range && a.time_range
    WHERE a.tenant_id = ${tenantId}::uuid
      AND a.status IN ('PENDING', 'CONFIRMED')
      AND b.status IN ('PENDING', 'CONFIRMED')
  `;

  return Number(rows[0]?.pairs ?? 0n);
}

/**
 * Réexporté pour les suites qui n'importent que ce harnais — même arbitrage que
 * dans `appointments-exclusion.harness.ts`.
 */
export { inTenant };
