import type { INestApplication } from '@nestjs/common';

import type { UserRole } from '../src/modules/identity/roles';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import {
  FakeNotificationsJournal,
  type StoredNotification,
} from '../src/modules/notifications/__tests__/notifications.doubles';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `notifications` pour ses suites d'intégration et
 * d'isolation (#70).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que la substitution
 * de `NotificationsRepository` par le journal en mémoire.
 *
 * Ce double filtre sur le **vrai** contexte de tenant — celui que l'extension
 * Prisma consulte — et refuse de lire hors portée. Une garde qui n'ouvrirait
 * pas la portée, ou qui l'ouvrirait sur le mauvais établissement, fait donc
 * rougir les suites plutôt que de passer.
 *
 * ## Le module n'a aucune surface publique
 *
 * D'où l'absence de `tenantSlug` ici, comme chez `crm.harness.ts` et
 * `reporting.harness.ts` : l'unique route se désigne par un jeton. Un journal
 * d'envois n'a pas de surface anonyme.
 */

export interface NotificationsHarness {
  app: INestApplication;
  journal: FakeNotificationsJournal;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Sème une trace d'envoi chez l'un des deux établissements. */
  seed(notification: StoredNotification): void;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createNotificationsHarness(): Promise<NotificationsHarness> {
  const journal = new FakeNotificationsJournal();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: NotificationsRepository, useValue: journal }],
  });

  return {
    app: harness.app,
    journal,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    seed: (notification) => {
      journal.seed(notification);
    },
    tokenFor: (role, tenantId) => harness.tokenFor(role, tenantId),
    bearer: (role, tenantId) => harness.bearer(role, tenantId),
    close: () => harness.close(),
  };
}
