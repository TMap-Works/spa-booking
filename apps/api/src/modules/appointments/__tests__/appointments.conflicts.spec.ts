import { Prisma } from '@prisma/client';

// Voir `appointment-status.spec.ts` : lecteur unique du SQL de migration (#217).
import { readMigrationSql } from '../../../infrastructure/database/__tests__/migration-sql';
import {
  isSlotExclusionViolation,
  isTransientWriteConflict,
  SLOT_EXCLUSION_CONSTRAINT,
} from '../appointments.conflicts';

/**
 * Reconnaissance du refus de `appointments_no_overlap`.
 *
 * Ce prédicat est le seul point du parcours où un 500 se transforme en 409. Le
 * tester compte doublement, parce que ses deux modes de défaillance sont
 * asymétriques et tous deux silencieux :
 *
 * - **trop strict** — il ne reconnaît plus la violation : chaque collision de
 *   créneau devient un 500. Le cas nominal continue de passer, aucune suite
 *   fonctionnelle ne rougit, et le défaut ne se voit qu'en production, sous
 *   charge, c'est-à-dire au pire moment ;
 * - **trop laxiste** — il reconnaît autre chose : une panne de base, une clé
 *   étrangère violée ou un futur refus de plage bloquée seraient annoncés au
 *   client comme « ce créneau vient d'être pris », qui réessaierait indéfiniment
 *   sur un créneau pourtant libre.
 */

/**
 * L'erreur telle que Prisma la lève réellement.
 *
 * Relevé contre PostgreSQL 16 et `@prisma/client` 6.12 : ni `code` ni `meta`,
 * tout est dans le message. Le reproduire à l'identique — plutôt que d'écrire
 * « un message qui contient le nom » — est ce qui donne sa valeur au test : si
 * Prisma changeait la forme de ce texte, c'est ici que cela se verrait.
 */
function realExclusionViolation(): Error {
  return new Prisma.PrismaClientUnknownRequestError(
    '\nInvalid `prisma.appointment.create()` invocation:\n\n\n' +
      'Error occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ' +
      '{ code: "23P01", message: "conflicting key value violates exclusion constraint ' +
      `\\"${SLOT_EXCLUSION_CONSTRAINT}\\"", severity: "ERROR", detail: Some("Key (tenant_id, ` +
      'staff_id, time_range)=(…) conflicts with existing key (…)."), column: None, hint: None }), ' +
      'transient: false })',
    { clientVersion: '6.12.0' },
  );
}

describe('isSlotExclusionViolation', () => {
  it('reconnaît l’erreur que Prisma lève réellement sur la contrainte', () => {
    expect(isSlotExclusionViolation(realExclusionViolation())).toBe(true);
  });

  it('reconnaît la forme que Prisma prendrait s’il mappait un jour `23P01`', () => {
    // Défensif, et assumé : le jour où le connecteur classe l'exclusion comme il
    // classe déjà l'unicité, `meta` portera le nom de la contrainte et le
    // message pourra cesser de le citer. Le prédicat ne doit pas se mettre à
    // rendre 500 ce jour-là.
    const mapped = new Prisma.PrismaClientKnownRequestError('Constraint failed on the database.', {
      code: 'P2004',
      clientVersion: '6.12.0',
      meta: { constraint: SLOT_EXCLUSION_CONSTRAINT },
    });

    expect(isSlotExclusionViolation(mapped)).toBe(true);
  });

  it.each([
    {
      what: 'une violation d’unicité',
      error: new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
        code: 'P2002',
        clientVersion: '6.12.0',
        meta: { target: ['tenant_id', 'slug'] },
      }),
    },
    {
      what: 'une clé étrangère violée',
      error: new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed.', {
        code: 'P2003',
        clientVersion: '6.12.0',
        meta: { field_name: 'appointments_staff_id_fkey' },
      }),
    },
    {
      what: 'une autre contrainte d’exclusion (même SQLSTATE, autre invariant)',
      error: new Prisma.PrismaClientUnknownRequestError(
        'PostgresError { code: "23P01", message: "conflicting key value violates exclusion ' +
          'constraint \\"staff_time_off_no_overlap\\"" }',
        { clientVersion: '6.12.0' },
      ),
    },
    { what: 'une base injoignable', error: new Error('Connection refused') },
  ])('ne reconnaît pas $what', ({ error }) => {
    expect(isSlotExclusionViolation(error)).toBe(false);
  });

  it.each([undefined, null, 'appointments_no_overlap', 42, { message: 'appointments_no_overlap' }])(
    'ne reconnaît rien qui ne soit pas une `Error` (%p)',
    (candidate) => {
      // Une chaîne qui contient le nom de la contrainte n'est pas une violation :
      // c'est ce qui empêche une donnée d'entrée de se faire passer pour une.
      expect(isSlotExclusionViolation(candidate)).toBe(false);
    },
  );
});

/**
 * L'interblocage tel que PostgreSQL le rend à Prisma.
 *
 * Relevé sur ce schéma : huit réservations concurrentes aux intervalles décalés
 * d'une minute produisent un succès et **sept `40P01`**. Ce n'est pas un cas de
 * laboratoire — c'est ce que produit n'importe quelle grille de créneaux au
 * quart d'heure pour un soin d'une heure.
 */
function realDeadlock(): Error {
  return new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.appointment.create()` invocation: Error occurred during query execution: ' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ' +
      '{ code: "40P01", message: "deadlock detected", severity: "ERROR", detail: Some("Process ' +
      '123 waits for ShareLock on transaction 456."), column: None, hint: None }), transient: false })',
    { clientVersion: '6.12.0' },
  );
}

describe('isTransientWriteConflict', () => {
  it('reconnaît l’interblocage que la concurrence réelle produit', () => {
    expect(isTransientWriteConflict(realDeadlock())).toBe(true);
  });

  it('reconnaît un échec de sérialisation', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "40001", message: "could not serialize access" }',
      { clientVersion: '6.12.0' },
    );

    expect(isTransientWriteConflict(error)).toBe(true);
  });

  it('reconnaît le code Prisma `P2034` si le connecteur venait à mapper l’interblocage', () => {
    const mapped = new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock.',
      { code: 'P2034', clientVersion: '6.12.0' },
    );

    expect(isTransientWriteConflict(mapped)).toBe(true);
  });

  it('ne confond jamais un créneau pris avec un interblocage', () => {
    // Les deux prédicats sont exclusifs, et ils doivent le rester : réessayer un
    // créneau pris boucle sur un refus définitif, et refuser une victime
    // d'interblocage perd une réservation sur un créneau libre.
    expect(isTransientWriteConflict(realExclusionViolation())).toBe(false);
    expect(isSlotExclusionViolation(realDeadlock())).toBe(false);
  });

  it.each([
    { what: 'une base injoignable', error: new Error('Connection refused') },
    { what: 'une valeur qui n’est pas une `Error`', error: 'code: "40P01"' },
  ])('ne reconnaît pas $what', ({ error }) => {
    expect(isTransientWriteConflict(error)).toBe(false);
  });
});

describe('SLOT_EXCLUSION_CONSTRAINT', () => {
  it('porte le nom que la migration déclare', () => {
    // Le couplage entre ce fichier et le SQL est réel : le vérifier ici est ce
    // qui fait qu'un renommage côté migration ne peut pas passer inaperçu.
    expect(readMigrationSql()).toContain(`ADD CONSTRAINT "${SLOT_EXCLUSION_CONSTRAINT}"`);
  });
});
