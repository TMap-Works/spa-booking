import {
  AppointmentCancelledBy as PrismaAppointmentCancelledBy,
  AppointmentStatus as PrismaAppointmentStatus,
} from '@prisma/client';

// Le SQL de migration est lu par un module unique, partagé avec
// `prisma-schema.spec.ts` (#217). L'import traverse les dossiers, mais il ne
// franchit aucune frontière de module métier au sens d'api-module §3 :
// `infrastructure/database` est le seul endroit du dépôt qui connaisse le
// schéma, et ce lecteur n'existe que pour les suites de test.
import { readMigrationSql } from '../../../infrastructure/database/__tests__/migration-sql';
import {
  APPOINTMENT_STATUSES,
  CANCELLATION_AUTHORS,
  isAppointmentStatus,
  OCCUPYING_STATUSES,
  occupiesSlot,
} from '../appointment-status';

/**
 * Vocabulaire du cycle de vie — et le **témoin** qui l'attache à deux vérités
 * qu'il ne contrôle pas : l'énumération PostgreSQL et le filtre partiel de la
 * contrainte d'exclusion.
 *
 * Les deux divergences que cette suite existe pour interdire sont silencieuses,
 * et c'est ce qui les rend coûteuses :
 *
 * - un statut ajouté ici sans sa migration ferait échouer toute requête qui le
 *   cite, sur tous les établissements à la fois — `invalid input value for enum
 *   "AppointmentStatus"` ;
 * - un statut ajouté à `OCCUPYING_STATUSES` sans son pendant dans le `WHERE` de
 *   `appointments_no_overlap` ferait croire au code qu'un créneau est occupé là
 *   où la base laisserait passer une seconde réservation. C'est exactement la
 *   double réservation que le ticket supprime, réintroduite par le haut.
 */

/** L'énumération telle que Prisma la génère — le témoin de la colonne. */
const PRISMA_STATUS_VALUES: readonly string[] = Object.values(PrismaAppointmentStatus);

const migrationSql = readMigrationSql();

/**
 * Les libellés cités par le filtre partiel de la contrainte d'exclusion.
 *
 * Extraits du SQL réellement appliqué, et non d'une constante recopiée : c'est
 * le texte qui s'exécute sur PostgreSQL qui fait foi.
 */
function statusesInExclusionPredicate(): string[] {
  const constraint = /ADD CONSTRAINT "appointments_no_overlap"[\s\S]*?WHERE \(([^;]*)\);/.exec(
    migrationSql,
  );
  if (constraint === null) {
    throw new Error(
      'la migration ne pose aucune contrainte « appointments_no_overlap » avec un filtre `WHERE` : ' +
        'sans filtre partiel, un rendez-vous annulé bloquerait son créneau à jamais',
    );
  }
  const predicate = constraint[1];
  if (predicate === undefined) {
    throw new Error('filtre `WHERE` de « appointments_no_overlap » illisible');
  }
  return [...predicate.matchAll(/'([A-Z_]+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('appointment-status — vocabulaire du cycle de vie', () => {
  it('énumère les cinq statuts du CDC §2.4, dans l’ordre de la colonne', () => {
    expect(APPOINTMENT_STATUSES).toEqual([
      'PENDING',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
  });

  it('dit exactement ce que dit `enum AppointmentStatus`', () => {
    expect([...APPOINTMENT_STATUSES]).toEqual([...PRISMA_STATUS_VALUES]);
  });

  it('reconnaît un statut connu et rejette tout le reste', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(isAppointmentStatus(status)).toBe(true);
    }
    for (const candidate of ['pending', 'CONFIRMÉ', '', null, undefined, 42, {}]) {
      expect(isAppointmentStatus(candidate)).toBe(false);
    }
  });
});

describe('appointment-status — statuts qui occupent le créneau', () => {
  it('ne compte que `PENDING` et `CONFIRMED`', () => {
    expect(OCCUPYING_STATUSES).toEqual(['PENDING', 'CONFIRMED']);
  });

  it('libère le créneau d’un rendez-vous annulé, no-show ou honoré', () => {
    // Le critère d'acceptation de #31 : une annulation rend le créneau
    // réservable. `COMPLETED` aussi — le soin est passé, l'intervalle est de
    // l'histoire, et rien ne justifie qu'il interdise une écriture future.
    expect(occupiesSlot('CANCELLED')).toBe(false);
    expect(occupiesSlot('NO_SHOW')).toBe(false);
    expect(occupiesSlot('COMPLETED')).toBe(false);
    expect(occupiesSlot('PENDING')).toBe(true);
    expect(occupiesSlot('CONFIRMED')).toBe(true);
  });

  it('dit exactement ce que dit le filtre partiel de `appointments_no_overlap`', () => {
    // Le seul test de cette suite qui protège d'une double réservation : deux
    // listes qui divergent d'un statut, et la base cesse de garantir ce que le
    // code croit garanti.
    expect(statusesInExclusionPredicate().sort()).toEqual([...OCCUPYING_STATUSES].sort());
  });
});

describe('appointment-status — auteurs d’annulation', () => {
  it('nomme les trois côtés du comptoir, dans l’ordre de la colonne', () => {
    expect(CANCELLATION_AUTHORS).toEqual(['CLIENT', 'STAFF', 'SYSTEM']);
  });

  it('dit exactement ce que dit `enum AppointmentCancelledBy`', () => {
    // Même témoin, même mode de défaillance que pour les statuts : une valeur
    // ajoutée ici sans sa migration ferait échouer toute écriture qui la cite —
    // `invalid input value for enum "AppointmentCancelledBy"` —, et sur toutes
    // les annulations à la fois.
    expect([...CANCELLATION_AUTHORS]).toEqual([...Object.values(PrismaAppointmentCancelledBy)]);
  });

  it('déclare la colonne dans une migration, nullable et sans défaut', () => {
    // Nullable : le report (#39) annule la ligne d'origine sans auteur à nommer.
    // Sans défaut : une valeur par défaut rangerait ces annulations-là sous un
    // auteur qu'elles n'ont pas, et fausserait le taux d'annulation du CDC §1.4.
    const added = /ALTER TABLE "appointments" ADD COLUMN "cancelled_by"([^;]*);/.exec(migrationSql);

    expect(added).not.toBeNull();
    expect(added?.[1]).toContain('"AppointmentCancelledBy"');
    expect(added?.[1]).not.toMatch(/NOT NULL/i);
    expect(added?.[1]).not.toMatch(/DEFAULT/i);
  });
});
