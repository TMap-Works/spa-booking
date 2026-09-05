import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { runWithTenant } from '../src/common/tenant/tenant-context';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import type {
  AppointmentDraft,
  CancelDraft,
  RescheduleDraft,
} from '../src/modules/appointments/appointments.types';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Amorçage commun des deux suites qui exercent la contrainte d'exclusion
 * anti-double-réservation contre un **vrai** PostgreSQL (#31, ADR 0002) :
 *
 * - `appointments-exclusion.integration-spec.ts` — ce que la migration a posé,
 *   les chevauchements, la libération du créneau, le report, l'annulation ;
 * - `appointments-exclusion.concurrency-spec.ts` — les **courses**, jouées par
 *   la cible `test:concurrency` et par elle seule (#326).
 *
 * ## Pourquoi les deux suites sont séparées
 *
 * La cible `test:concurrency` était un fan-out `--if-present` que **plus aucun
 * workspace ne servait** : l'étape « Tests de concurrence » du job `test`
 * verdissait sans rien exercer, alors qu'elle annonce le garde-fou du risque
 * n°1 du projet (CDC §6). Les cas de course tournaient bien, mais par la porte
 * de `test:integration:api` — une garantie tenue par un fichier dont le nom ne
 * la promettait pas, et qui se serait perdue en silence le jour où ces cas
 * auraient déménagé.
 *
 * Le suffixe `*.concurrency-spec.ts` leur donne une cible à eux. Chaque suite
 * n'est alors jouée qu'une fois — `jest.integration.config.js` ne connaît que
 * `*.integration-spec.ts` et `*.isolation-spec.ts` — et la ligne rouge de la CI
 * nomme la nature du problème.
 *
 * ## Pourquoi un harnais plutôt que deux amorçages
 *
 * Les deux suites ont besoin du même décor : une base jetable migrée, un client
 * non scopé pour semer et observer, le dépôt branché sur le client scopé, et un
 * établissement complet. Recopié, ce décor dériverait — et une course jouée sur
 * un décor qui n'est plus celui des cas nominaux ne prouve plus la même chose.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre (#27, #274). Chaque suite se crée
 * une **base jetable**, migrée puis détruite, dans un PostgreSQL 16 qu'elle
 * démarre elle-même (`utils/disposable-database.ts`). Rien n'est partagé avec
 * les suites voisines, pas même le serveur — ce qui compte doublement ici,
 * puisque plusieurs agents de jalon peuvent les exercer de front sur la même
 * machine. `DATABASE_URL` n'est plus lue depuis #274 : rien de ce que la machine
 * héberge n'entre dans le résultat.
 *
 * L'absence de démon fait échouer les suites, délibérément : une garantie
 * anti-double-réservation qui se désactiverait toute seule quand le moteur
 * manque serait pire qu'absente.
 */

/**
 * Le nombre d'écritures parallèles des tests de concurrence.
 *
 * Huit, et non deux : deux requêtes peuvent se sérialiser par hasard sur un pool
 * de connexions, et un test qui passe par chance ne prouve rien. Huit dépasse le
 * parallélisme d'un pool par défaut sans allonger la suite de façon sensible.
 */
export const CONCURRENT_ATTEMPTS = 8;

/** Une heure, en millisecondes — la durée de toutes les prestations des suites. */
export const ONE_HOUR = 3_600_000;

/** Un établissement complet : un client, deux praticiens, une prestation. */
export interface Fixture {
  readonly tenantId: string;
  readonly clientId: string;
  readonly staffId: string;
  readonly secondStaffId: string;
  readonly serviceId: string;
}

/** Le décor rendu à une suite : la base, le dépôt, de quoi semer et ranger. */
export interface ExclusionHarness {
  /**
   * La racine non scopée : elle sert ici à ce pour quoi elle existe — créer les
   * établissements, qui n'ont par définition aucun tenant courant, et
   * **observer** la base sans le filtre qu'on ne teste pas ici.
   */
  readonly prismaUnscoped: PrismaClient;
  /** Le dépôt sous test, branché sur le client **scopé**. */
  readonly repository: AppointmentsRepository;
  /**
   * La **lecture** que le moteur de disponibilité fait de cette même table.
   *
   * Elle est ici, et non dans un harnais à elle, parce qu'elle porte sur les
   * lignes que celui-ci sème : depuis #316, `listBookedRanges` sait écarter un
   * rendez-vous nommé, et ce que cela fait — ou ne fait pas — de la frontière du
   * tenant ne se prouve que contre un vrai `where` scopé. Un second harnais
   * aurait démarré un second PostgreSQL pour observer la même table.
   */
  readonly availability: AvailabilityRepository;
  /** Sème un établissement complet et rend de quoi y réserver. */
  seed(label: string): Promise<Fixture>;
  /** Déconnecte Prisma puis détruit la base jetable — et son conteneur. */
  close(): Promise<void>;
}

/** Le tenant, tel que ces suites le créent — le strict nécessaire du schéma. */
function tenantSeed(label: string): Prisma.TenantCreateInput {
  return {
    slug: `i31-${label}-${randomUUID()}`,
    name: `Établissement ${label}`,
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
  };
}

/** Sème un établissement complet dans la base ouverte par le harnais. */
async function seedTenant(prismaUnscoped: PrismaClient, label: string): Promise<Fixture> {
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

/**
 * Ouvre une base jetable, y branche le dépôt, et rend de quoi la semer.
 *
 * Le premier échec — conteneur indisponible, schéma absent — détruit ce qui a
 * déjà été créé avant de remonter : un `beforeAll` qui rougit ne doit pas
 * laisser un conteneur PostgreSQL derrière lui sur la machine d'un agent.
 */
export async function createExclusionHarness(): Promise<ExclusionHarness> {
  const database: DisposableDatabase = await createDisposableDatabase();
  const prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

  try {
    await prismaUnscoped.$connect();
    // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
    // que le schéma est en place. Une base joignable mais vide produirait sinon
    // une erreur bien plus loin, où elle se lirait comme un défaut du repository.
    await prismaUnscoped.tenant.count();
  } catch (error: unknown) {
    // La déconnexion est sous filet, la destruction ne l'est pas : c'est
    // l'erreur d'origine qui doit remonter, et un `$disconnect()` qui échoue —
    // moteur Prisma déjà mort, connexion coupée — ne doit pas emporter avec lui
    // le `drop()` qui arrête le conteneur. Sans ce `catch`, l'échec du ménage
    // masquerait la cause **et** laisserait un PostgreSQL debout sur la machine.
    await prismaUnscoped.$disconnect().catch(() => undefined);
    await database.drop();
    throw error;
  }

  return {
    prismaUnscoped,
    repository: new AppointmentsRepository(createScopedPrismaClient(prismaUnscoped)),
    availability: new AvailabilityRepository(createScopedPrismaClient(prismaUnscoped)),
    seed: (label: string) => seedTenant(prismaUnscoped, label),
    close: async () => {
      // Le ménage tient en une ligne : la base entière disparaît. La déconnexion
      // d'abord, pour ne pas laisser Prisma journaliser une rupture de connexion
      // qui se lirait comme un incident — mais sous `finally`, sans quoi une
      // déconnexion qui échoue sauterait le `drop()` et laisserait le conteneur
      // vivant après l'`afterAll`.
      try {
        await prismaUnscoped.$disconnect();
      } finally {
        await database.drop();
      }
    },
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
export async function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, async () => {
    const result = await fn();
    return result;
  });
}

/** Un brouillon de rendez-vous pour cet établissement, sur ces bornes. */
export function draft(
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

/** Un report de ce rendez-vous vers ces bornes, chez le praticien indiqué. */
export function move(
  previousId: string,
  startsAt: Date,
  endsAt: Date,
  staffId: string,
): RescheduleDraft {
  return { previousId, staffId, startsAt, endsAt };
}

/** Une demande d'annulation sur ce rendez-vous. */
export function cancellation(
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
