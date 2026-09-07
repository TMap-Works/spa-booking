import type { INestApplication } from '@nestjs/common';

import type { UserRole } from '../src/modules/identity/roles';
import { NotificationTemplatesRepository } from '../src/modules/notifications/notification-templates.repository';
import {
  FakeNotificationTemplates,
  type StoredTemplateRow,
} from '../src/modules/notifications/__tests__/notifications.doubles';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage des routes de modèles de messages, pour leurs suites d'intégration et
 * d'isolation (#69).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27) :
 * deux établissements, l'application réellement câblée par `configureApp`, des
 * jetons signés par le vrai `TokenService`. Il ne reste ici que la substitution
 * de `NotificationTemplatesRepository` par le magasin en mémoire.
 *
 * Ce double filtre sur le **vrai** contexte de tenant — celui que l'extension
 * Prisma consulte — et refuse de lire hors portée. Une garde qui n'ouvrirait pas
 * la portée, ou qui l'ouvrirait sur le mauvais établissement, fait donc rougir
 * les suites plutôt que de passer.
 *
 * Il ne substitue **pas** `NotificationsRepository` : ces routes ne lisent ni
 * envois ni rendez-vous, et une substitution de plus aurait laissé croire le
 * contraire.
 */

export interface NotificationTemplatesHarness {
  app: INestApplication;
  templates: FakeNotificationTemplates;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Sème une personnalisation chez l'un des deux établissements. */
  seed(row: StoredTemplateRow): void;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createNotificationTemplatesHarness(): Promise<NotificationTemplatesHarness> {
  const templates = new FakeNotificationTemplates();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: NotificationTemplatesRepository, useValue: templates }],
  });

  return {
    app: harness.app,
    templates,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    seed: (row) => {
      templates.seed(row);
    },
    tokenFor: (role, tenantId) => harness.tokenFor(role, tenantId),
    bearer: (role, tenantId) => harness.bearer(role, tenantId),
    close: () => harness.close(),
  };
}
