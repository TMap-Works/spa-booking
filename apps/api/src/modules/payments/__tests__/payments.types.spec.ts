import {
  PaymentMethod as PrismaPaymentMethod,
  PaymentStatus as PrismaPaymentStatus,
} from '@prisma/client';

import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../payments.types';

/**
 * Le **témoin** du vocabulaire d'encaissement : les listes que le service et le
 * contrôleur manipulent disent-elles la même chose que les colonnes ?
 *
 * `payments.types.ts` déclare ces libellés à la main plutôt que de les importer
 * du client généré, pour la raison qui vaut dans `appointment-status.ts` et
 * `identity/roles.ts` : ce fichier est lu par des couches auxquelles api-module
 * §2 interdit de connaître Prisma, et une machine sans `prisma generate`
 * verrait sinon échouer des suites qui ne parlent pas du schéma.
 *
 * Le prix de ce choix est la dérive possible, et c'est cette suite qui la
 * rattrape : un sixième statut ajouté à l'énumération PostgreSQL sans être
 * inscrit ici y rougit immédiatement — avant qu'une lecture ne le découvre en
 * production, où il arriverait comme une valeur que le typage jure impossible.
 *
 * L'import de `@prisma/client` est ici et **seulement ici**, comme dans
 * `roles.spec.ts`.
 */
describe('payments — vocabulaire et colonnes', () => {
  it('énumère les deux moyens d’encaissement du CDC §1.4', () => {
    expect(PAYMENT_METHODS).toEqual(['CARD', 'CASH']);
  });

  it('reprend `enum PaymentMethod` du schéma, dans l’ordre de déclaration', () => {
    expect([...PAYMENT_METHODS]).toEqual(Object.values(PrismaPaymentMethod));
  });

  it('reprend `enum PaymentStatus` du schéma, dans l’ordre de déclaration', () => {
    // L'ordre compte : PostgreSQL ordonne un `enum` par sa déclaration, et un
    // `orderBy: { status: 'asc' }` sur un futur historique des ventes suivrait
    // celui-là.
    expect([...PAYMENT_STATUSES]).toEqual(Object.values(PrismaPaymentStatus));
  });

  it('distingue les deux statuts de remboursement — total et partiel', () => {
    // Le cumul des remboursements ne peut jamais dépasser le montant capturé
    // (payments-stripe §6) : les deux statuts sont ce qui rend la distinction
    // lisible en base avant même que #63 ne l'exploite.
    expect(PAYMENT_STATUSES).toContain('REFUNDED');
    expect(PAYMENT_STATUSES).toContain('PARTIALLY_REFUNDED');
  });
});
