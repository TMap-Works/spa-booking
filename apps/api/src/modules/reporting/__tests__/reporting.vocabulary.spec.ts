import {
  AppointmentStatus as PrismaAppointmentStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentStatus as PrismaPaymentStatus,
} from '@prisma/client';

// Le SQL de migration est lu par un module unique, partagé avec
// `prisma-schema.spec.ts` (#217). L'import traverse les dossiers, mais il ne
// franchit aucune frontière de module métier au sens d'api-module §3 :
// `infrastructure/database` est le seul endroit du dépôt qui connaisse le
// schéma, et ce lecteur n'existe que pour les suites de test.
import { readMigrationSql } from '../../../infrastructure/database/__tests__/migration-sql';
import {
  APPOINTMENT_GROUPINGS,
  APPOINTMENT_STATUSES,
  PAYMENT_METHODS,
  REVENUE_PAYMENT_STATUSES,
} from '../reporting.types';

/**
 * Le **témoin** du module `reporting` : il attache trois listes locales à des
 * vérités que le module ne contrôle pas.
 *
 * `reporting.types.ts` recopie le vocabulaire de `payments` et
 * d'`appointments` plutôt que de l'importer, parce qu'un module n'importe pas un
 * fichier profond d'un autre (api-module §3). La recopie a un prix, et cette
 * suite est ce prix : sans elle, un sixième statut de rendez-vous ou un
 * troisième moyen de paiement ajouté au schéma serait **ignoré en silence** par
 * les trois rapports — un chiffre d'affaires qui oublie une colonne ne lève
 * aucune erreur, il est simplement faux.
 *
 * Elle garde aussi les deux index de la migration. Les retirer ne casserait
 * aucun test fonctionnel : les requêtes rendraient les mêmes chiffres, plus
 * lentement, et le cinquième critère de #74 mourrait sans bruit.
 */

const migrationSql = readMigrationSql();

describe('reporting — vocabulaire', () => {
  it('dit exactement ce que dit `enum PaymentMethod`', () => {
    expect([...PAYMENT_METHODS]).toEqual([...Object.values(PrismaPaymentMethod)]);
  });

  it('dit exactement ce que dit `enum AppointmentStatus`, dans l’ordre de la colonne', () => {
    expect([...APPOINTMENT_STATUSES]).toEqual([...Object.values(PrismaAppointmentStatus)]);
  });

  it('ne retient comme recette que des statuts d’encaissement qui existent', () => {
    const known: readonly string[] = Object.values(PrismaPaymentStatus);

    expect(REVENUE_PAYMENT_STATUSES.every((status) => known.includes(status))).toBe(true);
  });

  it('écarte de la recette l’intention ouverte et la carte refusée', () => {
    expect(REVENUE_PAYMENT_STATUSES).not.toContain('PENDING');
    expect(REVENUE_PAYMENT_STATUSES).not.toContain('FAILED');
  });

  it('retient les encaissements remboursés — ils restent au relevé', () => {
    expect(REVENUE_PAYMENT_STATUSES).toContain('REFUNDED');
    expect(REVENUE_PAYMENT_STATUSES).toContain('PARTIALLY_REFUNDED');
  });

  it('compte exactement trois statuts de recette — le dépôt en lie trois, pas plus', () => {
    // `ReportingRepository` développe la liste en trois `${…}` liés, faute de
    // pouvoir passer un tableau à un `IN`. Une quatrième valeur ajoutée ici
    // resterait hors de la requête, sans rien casser d'apparent.
    expect(REVENUE_PAYMENT_STATUSES).toHaveLength(3);
  });

  it('offre les trois axes que demande le deuxième critère de #74', () => {
    expect([...APPOINTMENT_GROUPINGS]).toEqual(['day', 'staff', 'service']);
  });
});

describe('reporting — index de la migration', () => {
  it('pose l’index du volume par prestation', () => {
    expect(migrationSql).toContain(
      'CREATE INDEX "appointments_tenant_id_service_id_starts_at_idx"',
    );
  });

  it('pose l’index du revenu, daté de `captured_at` et non de `created_at`', () => {
    expect(migrationSql).toContain('CREATE INDEX "payments_tenant_id_status_captured_at_idx"');
    expect(migrationSql).toContain('"payments"("tenant_id", "status", "captured_at")');
  });

  it('ne retire aucun des index que les deux autres axes empruntent', () => {
    expect(migrationSql).toContain('CREATE INDEX "appointments_tenant_id_starts_at_idx"');
    expect(migrationSql).toContain('CREATE INDEX "appointments_tenant_id_staff_id_starts_at_idx"');
  });
});
