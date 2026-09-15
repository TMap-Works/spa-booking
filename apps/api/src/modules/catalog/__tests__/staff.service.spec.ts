import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { StaffProfileAlreadyExistsError } from '../catalog.errors';
import { FakeCatalogRepository, FakeUsersService } from './catalog.doubles';
import { StaffService } from '../staff.service';

/**
 * L'annuaire des fiches praticien (#421) et leur cycle de vie (#694) — sans
 * HTTP, sans base.
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
  let users: FakeUsersService;
  let staff: StaffService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    users = new FakeUsersService();
    staff = new StaffService(repository.asRepository(), users.asService());
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

  // -------------------------------------------------------------------------
  // Création — #694
  // -------------------------------------------------------------------------

  it('crée une fiche réservable pour un compte du personnel, et la liste la rend', async () => {
    // Le cas qui motive le ticket : avant lui, aucune route n'écrivait `staff`,
    // et un salon jamais semé restait à « Praticiens — 0 » pour toujours.
    const compte = users.seedAccount({ tenantId: TENANT_A });

    const creee = await inTenantA(async () =>
      staff.create({ userId: compte.id, displayName: 'Léa Praticienne' }),
    );
    const liste = await inTenantA(async () => staff.list(false));

    expect(creee).toEqual({ id: creee.id, displayName: 'Léa Praticienne', isActive: true });
    expect(liste).toEqual([creee]);
  });

  it('rend un identifiant de fiche, et non celui du compte', async () => {
    // La confusion que #421 corrigeait en lecture se rejouerait en écriture si
    // la création renvoyait `userId` : l'affectation le refuserait par un 404.
    const compte = users.seedAccount({ tenantId: TENANT_A });

    const creee = await inTenantA(async () =>
      staff.create({ userId: compte.id, displayName: 'Léa' }),
    );
    const retrouvee = await inTenantA(async () => repository.findStaffById(creee.id));

    expect(creee.id).not.toBe(compte.id);
    expect(retrouvee).not.toBeNull();
  });

  it('refuse un compte inconnu, celui du voisin et une fiche cliente par le même 404', async () => {
    // Les trois refus se confondent délibérément : les distinguer ferait de
    // cette route un oracle sur l'annuaire du voisin (tenant-isolation §4).
    const chezLeVoisin = users.seedAccount({ tenantId: TENANT_B });
    const cliente = users.seedAccount({ tenantId: TENANT_A, isClient: true });

    await expect(
      inTenantA(async () => staff.create({ userId: randomUUID(), displayName: 'Inconnue' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenantA(async () => staff.create({ userId: chezLeVoisin.id, displayName: 'Ailleurs' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenantA(async () => staff.create({ userId: cliente.id, displayName: 'Cliente' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(repository.staff).toHaveLength(0);
  });

  it('refuse une seconde fiche pour le même compte', async () => {
    // L'unicité `(tenant_id, user_id)` : deux fiches se disputeraient l'agenda
    // de la même personne. C'est la base qui tranche, d'où le 409.
    const compte = users.seedAccount({ tenantId: TENANT_A });

    await inTenantA(async () => staff.create({ userId: compte.id, displayName: 'Léa' }));

    await expect(
      inTenantA(async () => staff.create({ userId: compte.id, displayName: 'Léa bis' })),
    ).rejects.toBeInstanceOf(StaffProfileAlreadyExistsError);
    expect(repository.staff).toHaveLength(1);
  });

  it('laisse le même compte porter une fiche dans chaque établissement', async () => {
    // L'unicité est **par tenant**. Une gérante qui tient deux salons y est
    // praticienne deux fois, et chaque agenda est le sien.
    const identifiantPartage = randomUUID();
    users.accounts.push({ tenantId: TENANT_A, id: identifiantPartage, isClient: false });
    users.accounts.push({ tenantId: TENANT_B, id: identifiantPartage, isClient: false });

    const chezA = await inTenantA(async () =>
      staff.create({ userId: identifiantPartage, displayName: 'Chez A' }),
    );
    const chezB = await inTenantB(async () =>
      staff.create({ userId: identifiantPartage, displayName: 'Chez B' }),
    );

    expect(chezA.id).not.toBe(chezB.id);
    expect(await inTenantA(async () => staff.list(false))).toEqual([chezA]);
    expect(await inTenantB(async () => staff.list(false))).toEqual([chezB]);
  });

  // -------------------------------------------------------------------------
  // Modification — #694
  // -------------------------------------------------------------------------

  it('désactive une fiche sans la supprimer, et la liste filtrée la retire', async () => {
    // La désactivation **est** le retrait : les rendez-vous passés citent la
    // fiche, et le reporting doit continuer à savoir qui a tenu la cabine.
    const membre = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Léa' });

    const modifiee = await inTenantA(async () => staff.update(membre.id, { isActive: false }));

    expect(modifiee).toEqual({ id: membre.id, displayName: 'Léa', isActive: false });
    expect(await inTenantA(async () => staff.list(true))).toEqual([]);
    expect(repository.staff).toHaveLength(1);
  });

  it('accepte un corps vide sans rien changer', async () => {
    const membre = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Léa' });

    const modifiee = await inTenantA(async () => staff.update(membre.id, {}));

    expect(modifiee).toEqual({ id: membre.id, displayName: 'Léa', isActive: true });
  });

  it('ne modifie pas la fiche du voisin — 404, et la fiche intacte', async () => {
    const chezB = repository.seedStaff({ tenantId: TENANT_B, displayName: 'Chez B' });

    await expect(
      inTenantA(async () => staff.update(chezB.id, { displayName: 'Détournée' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(chezB.displayName).toBe('Chez B');
  });

  it('refuse d’écrire sans portée de tenant', async () => {
    // Même défaut fermé qu'en lecture : sans portée, aucune écriture. Une
    // création qui retomberait sur un tenant par défaut poserait la fiche dans
    // le salon de quelqu'un d'autre.
    const compte = users.seedAccount({ tenantId: TENANT_A });

    await expect(staff.create({ userId: compte.id, displayName: 'Léa' })).rejects.toThrow(/tenant/i);
    expect(repository.staff).toHaveLength(0);
  });
});
