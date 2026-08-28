import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import { ClosingDaysService } from '../closing-days.service';
import { FakeAvailabilityRepository } from './availability.doubles';
import { SpyAvailabilityCache } from './staff-time-off.doubles';

/**
 * Jours de fermeture récurrents de l'établissement — sans HTTP, sans base.
 *
 * La propriété qui compte ici n'est pas le CRUD, elle est l'**étanchéité** : la
 * fermeture d'un salon ne se lit ni ne s'écrit depuis un autre.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

describe('ClosingDaysService', () => {
  let repository: FakeAvailabilityRepository;
  let cache: SpyAvailabilityCache;
  let closingDays: ClosingDaysService;

  beforeEach(() => {
    repository = new FakeAvailabilityRepository();
    cache = new SpyAvailabilityCache();
    repository.seedTenant({ id: TENANT_A });
    repository.seedTenant({ id: TENANT_B });
    closingDays = new ClosingDaysService(repository.asRepository(), cache.asService());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  it('rend une liste vide pour un salon ouvert toute la semaine', async () => {
    expect(await inTenantA(async () => closingDays.list())).toEqual({ weekdays: [] });
  });

  it('rend les jours fermés croissants', async () => {
    repository.seedClosingDay({ tenantId: TENANT_A, weekday: 7 });
    repository.seedClosingDay({ tenantId: TENANT_A, weekday: 1 });

    expect(await inTenantA(async () => closingDays.list())).toEqual({ weekdays: [1, 7] });
  });

  it('remplace intégralement la liste', async () => {
    await inTenantA(async () => closingDays.replace([1, 7]));

    const reopened = await inTenantA(async () => closingDays.replace([7]));

    // Rouvrir un jour, c'est renvoyer la liste sans lui : aucun `DELETE`
    // unitaire n'a de sens.
    expect(reopened).toEqual({ weekdays: [7] });
  });

  it('chasse le cache de disponibilité à chaque écriture (#35)', async () => {
    // Une fermeture s'applique à tous les praticiens : c'est l'écriture qui
    // change le plus de créneaux d'un seul geste, et celle dont un cache
    // périmé coûte le plus cher — des rendez-vous que personne n'honorera.
    await inTenantA(async () => closingDays.replace([1]));
    await inTenantA(async () => closingDays.replace([]));

    expect(cache.calls).toBe(2);
  });

  it('n’invalide rien sur une simple lecture', async () => {
    await inTenantA(async () => closingDays.list());

    expect(cache.calls).toBe(0);
  });

  it('rouvre toute la semaine sur une liste vide', async () => {
    await inTenantA(async () => closingDays.replace([1, 7]));

    expect(await inTenantA(async () => closingDays.replace([]))).toEqual({ weekdays: [] });
  });

  it('ne laisse voir aucune fermeture du voisin', async () => {
    repository.seedClosingDay({ tenantId: TENANT_B, weekday: 3 });

    expect(await inTenantA(async () => closingDays.list())).toEqual({ weekdays: [] });
  });

  it('ne touche pas aux fermetures du voisin en écrivant les siennes', async () => {
    repository.seedClosingDay({ tenantId: TENANT_B, weekday: 3 });

    await inTenantA(async () => closingDays.replace([1]));

    expect(await inTenantB(async () => closingDays.list())).toEqual({ weekdays: [3] });
  });

  it('refuse toute opération hors portée de tenant', async () => {
    // Défaut fermé : sans contexte, l'extension Prisma lève plutôt que de
    // retomber sur « toutes les lignes ».
    await expect(closingDays.list()).rejects.toThrow();
  });
});
