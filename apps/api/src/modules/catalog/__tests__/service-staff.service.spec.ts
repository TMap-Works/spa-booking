import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { ServiceStaffAlreadyAssignedError } from '../catalog.errors';
import { ServiceStaffService } from '../service-staff.service';
import { FakeCatalogRepository } from './catalog.doubles';

/**
 * Affectation « ce praticien pratique cette prestation » — sans HTTP, sans base.
 *
 * Le service est exercé **dans une portée de tenant**, celle-là même que
 * `JwtAuthGuard` renseigne en vrai et que l'extension Prisma consulte : un test
 * qui l'ouvrirait autrement ne prouverait rien du chemin réel.
 *
 * Les cas inter-tenants sont ici et non seulement en test d'intégration : ils
 * n'ont besoin ni de base ni de serveur, et les exécuter à chaque `test:unit`
 * les rend impossibles à oublier.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

/** L'erreur rejetée par une promesse, pour les assertions sur son contenu. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

describe('ServiceStaffService', () => {
  let repository: FakeCatalogRepository;
  let assignments: ServiceStaffService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    assignments = new ServiceStaffService(repository.asRepository());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  describe('affectation', () => {
    it('rend le praticien affecté, et le fait apparaître dans la liste', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Camille' });

      const affecte = await inTenantA(async () => assignments.assign(service.id, member.id));
      const liste = await inTenantA(async () => assignments.list(service.id));

      expect(affecte).toEqual({ id: member.id, displayName: 'Camille', isActive: true });
      expect(liste).toEqual([affecte]);
    });

    it('refuse en 409 la seconde affectation du même praticien', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A });

      await inTenantA(async () => assignments.assign(service.id, member.id));
      const error = await rejectionOf(
        inTenantA(async () => assignments.assign(service.id, member.id)),
      );

      expect(error).toBeInstanceOf(ServiceStaffAlreadyAssignedError);
      expect(repository.assignments).toHaveLength(1);
    });

    it('trie les praticiens par nom d’affichage', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const zoe = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Zoé' });
      const alix = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Alix' });

      await inTenantA(async () => assignments.assign(service.id, zoe.id));
      await inTenantA(async () => assignments.assign(service.id, alix.id));
      const liste = await inTenantA(async () => assignments.list(service.id));

      expect(liste.map((member) => member.displayName)).toEqual(['Alix', 'Zoé']);
    });

    it('garde le praticien désactivé dans la liste — l’affectation lui survit', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A, isActive: false });

      await inTenantA(async () => assignments.assign(service.id, member.id));
      const liste = await inTenantA(async () => assignments.list(service.id));

      expect(liste).toEqual([
        { id: member.id, displayName: member.displayName, isActive: false },
      ]);
    });
  });

  describe('retrait', () => {
    it('retire l’affectation, et le second retrait est un 404', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A });
      await inTenantA(async () => assignments.assign(service.id, member.id));

      await inTenantA(async () => assignments.remove(service.id, member.id));
      const error = await rejectionOf(
        inTenantA(async () => assignments.remove(service.id, member.id)),
      );

      expect(await inTenantA(async () => assignments.list(service.id))).toEqual([]);
      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('ne retire rien quand le praticien n’était pas affecté à cette prestation', async () => {
      const massage = repository.seedService({ tenantId: TENANT_A, slug: 'massage' });
      const coupe = repository.seedService({ tenantId: TENANT_A, slug: 'coupe' });
      const member = repository.seedStaff({ tenantId: TENANT_A });
      await inTenantA(async () => assignments.assign(massage.id, member.id));

      const error = await rejectionOf(
        inTenantA(async () => assignments.remove(coupe.id, member.id)),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(await inTenantA(async () => assignments.list(massage.id))).toHaveLength(1);
    });
  });

  /**
   * Le cœur du troisième critère de #25 : « un praticien ne peut être affecté
   * qu'à un service de son tenant ».
   *
   * Ce que ces cas prouvent est un cran en deçà de la garantie réelle — celle-ci
   * tient aux clés étrangères composites `(tenant_id, service_id)` et
   * `(tenant_id, staff_id)`, qui vivent en base et qu'un test unitaire ne peut
   * pas exercer. Ils prouvent que **le service ne s'y heurte jamais** : il refuse
   * en 404 avant d'écrire, plutôt que de laisser remonter une violation de
   * contrainte en 500.
   */
  describe('isolation inter-tenant', () => {
    it('refuse en 404 d’affecter un praticien d’un autre établissement', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const etranger = repository.seedStaff({ tenantId: TENANT_B });

      const error = await rejectionOf(
        inTenantA(async () => assignments.assign(service.id, etranger.id)),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.assignments).toHaveLength(0);
    });

    it('refuse en 404 d’affecter à une prestation d’un autre établissement', async () => {
      const etrangere = repository.seedService({ tenantId: TENANT_B });
      const member = repository.seedStaff({ tenantId: TENANT_A });

      const error = await rejectionOf(
        inTenantA(async () => assignments.assign(etrangere.id, member.id)),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.assignments).toHaveLength(0);
    });

    it('rend 404 — et non une liste vide — sur la prestation d’un autre établissement', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A });
      await inTenantA(async () => assignments.assign(service.id, member.id));

      const error = await rejectionOf(inTenantB(async () => assignments.list(service.id)));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('ne laisse pas le voisin retirer une affectation, et la laisse intacte', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const member = repository.seedStaff({ tenantId: TENANT_A });
      await inTenantA(async () => assignments.assign(service.id, member.id));

      const error = await rejectionOf(
        inTenantB(async () => assignments.remove(service.id, member.id)),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(await inTenantA(async () => assignments.list(service.id))).toHaveLength(1);
    });

    it('ne montre pas une affectation croisée que la base refuserait', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const etranger = repository.seedStaff({ tenantId: TENANT_B });
      // Ligne que les clés étrangères composites rendent impossible en base.
      // Posée ici de force : si une couche au-dessus la rendait visible, ce test
      // le dirait.
      repository.seedAssignment({
        tenantId: TENANT_B,
        serviceId: service.id,
        staffId: etranger.id,
      });

      expect(await inTenantA(async () => assignments.list(service.id))).toEqual([]);
    });

    it('refuse toute opération hors portée de tenant', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });

      await expect(assignments.list(service.id)).rejects.toThrow(/aucun tenant courant/);
    });
  });
});
