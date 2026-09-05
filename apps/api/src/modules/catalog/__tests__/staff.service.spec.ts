import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import { FakeCatalogRepository } from './catalog.doubles';
import { StaffService } from '../staff.service';

/**
 * L'annuaire des fiches praticien (#421) — sans HTTP, sans base.
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

describe('StaffService', () => {
  let repository: FakeCatalogRepository;
  let staff: StaffService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    staff = new StaffService(repository.asRepository());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  it('rend les fiches de l’établissement, sans aucune affectation préalable', async () => {
    // Le cas d'amorçage, celui qui motive tout le ticket : aucune ligne de
    // `service_staff` nulle part, et pourtant une liste de candidats.
    const camille = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Camille' });

    const liste = await inTenantA(async () => staff.list(false));

    expect(repository.assignments).toHaveLength(0);
    expect(liste).toEqual([{ id: camille.id, displayName: 'Camille', isActive: true }]);
  });

  it('rend l’identifiant de la fiche, celui qu’attend l’affectation', async () => {
    // Ce que la liste rend doit partir tel quel dans `POST …/staff`. Le vérifier
    // en passant l'identifiant à `findStaffById` — la lecture même que
    // `ServiceStaffService.requireStaff` fait avant d'écrire — est la seule
    // façon de prouver qu'on ne rend pas l'identifiant du compte.
    const camille = repository.seedStaff({ tenantId: TENANT_A });

    const [membre] = await inTenantA(async () => staff.list(false));
    const retrouve = await inTenantA(async () => repository.findStaffById(membre!.id));

    expect(membre!.id).toBe(camille.id);
    expect(retrouve).not.toBeNull();
  });

  it('trie par nom d’affichage', async () => {
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Zoé' });
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Alix' });

    const liste = await inTenantA(async () => staff.list(false));

    expect(liste.map((member) => member.displayName)).toEqual(['Alix', 'Zoé']);
  });

  it('rend les fiches désactivées par défaut, et les retire sur demande', async () => {
    // Les masquer d'office ferait recréer la fiche, pour se heurter à l'unicité
    // `(tenant_id, user_id)`. C'est donc l'écran qui choisit, pas l'API.
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Active' });
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Partie', isActive: false });

    const toutes = await inTenantA(async () => staff.list(false));
    const actives = await inTenantA(async () => staff.list(true));

    expect(toutes.map((member) => member.displayName)).toEqual(['Active', 'Partie']);
    expect(actives.map((member) => member.displayName)).toEqual(['Active']);
  });

  it('ne laisse voir aucune fiche du voisin', async () => {
    const chezA = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Chez A' });
    const chezB = repository.seedStaff({ tenantId: TENANT_B, displayName: 'Chez B' });

    const vuDeA = await inTenantA(async () => staff.list(false));
    const vuDeB = await inTenantB(async () => staff.list(false));

    expect(vuDeA.map((member) => member.id)).toEqual([chezA.id]);
    expect(vuDeB.map((member) => member.id)).toEqual([chezB.id]);
  });

  it('refuse de lire sans portée de tenant plutôt que de tout rendre', async () => {
    // Le défaut fermé de tenant-isolation §3 : hors portée, l'extension lève.
    // Un service qui retomberait sur « toutes les fiches » serait la fuite même.
    repository.seedStaff({ tenantId: TENANT_A });

    await expect(staff.list(false)).rejects.toThrow(/tenant/i);
  });
});
