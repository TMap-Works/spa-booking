import { randomUUID } from 'node:crypto';

import { staffMemberSchema } from '@spa/shared';

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

  // -------------------------------------------------------------------------
  // La présentation — #771
  // -------------------------------------------------------------------------
  //
  // Ce que ces cas protègent n'est pas un champ de plus : c'est le fait que
  // l'écran de la fiche puisse **relire** ce qui est publié sous le nom de la
  // praticienne. Sans cela, le champ s'ouvrait vide au-dessus d'un texte en
  // ligne, et la gérante le réécrivait de mémoire.
  //
  // La forme compte autant que la présence. Le contrat partagé déclare `bio`
  // facultatif et **non** nullable : une fiche sans présentation doit rendre une
  // charge utile *sans la clé*, faute de quoi le front — qui parse cette réponse
  // avec ce schéma — échouerait à la lire.

  it('rend la présentation publiée, celle que l’écran vient corriger', async () => {
    const camille = repository.seedStaff({
      tenantId: TENANT_A,
      displayName: 'Claire F.',
      bio: 'Quinze ans de massage suédois.',
    });

    const liste = await inTenantA(async () => staff.list(false));

    expect(liste).toEqual([
      { id: camille.id, displayName: 'Claire F.', bio: 'Quinze ans de massage suédois.', isActive: true },
    ]);
  });

  it('omet la clé plutôt que de rendre null quand il n’y a pas de présentation', async () => {
    repository.seedStaff({ tenantId: TENANT_A, bio: null });

    const [membre] = await inTenantA(async () => staff.list(false));

    // `toEqual` ignore les clés à `undefined` : seul `hasOwn` distingue « absente »
    // de « présente et vide », et c'est exactement la distinction qui décide si
    // le front sait relire la réponse.
    expect(Object.hasOwn(membre!, 'bio')).toBe(false);
  });

  it('rend une fiche que le contrat partagé sait relire, avec ou sans présentation', async () => {
    // Le front parse cette réponse avec `staffMemberSchema` : un `bio: null` y
    // échouerait, et l'assertion de compilation de `dto/staff.dto.ts` ne juge
    // que les types, pas la valeur que le service compose à l'exécution.
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Avec', bio: 'Un texte.' });
    repository.seedStaff({ tenantId: TENANT_A, displayName: 'Sans', bio: null });

    const liste = await inTenantA(async () => staff.list(false));

    expect(liste).toHaveLength(2);
    for (const membre of liste) {
      expect(staffMemberSchema.safeParse(membre).success).toBe(true);
    }
  });

  it('rend la présentation posée à la création', async () => {
    const compte = users.seedAccount({ tenantId: TENANT_A });

    const creee = await inTenantA(async () =>
      staff.create({ userId: compte.id, displayName: 'Léa', bio: 'Coloriste.' }),
    );

    expect(creee.bio).toBe('Coloriste.');
  });

  it('rend la présentation corrigée, et la retire quand elle est effacée', async () => {
    // Les deux gestes que l'écran offre désormais sans manœuvre : on lit ce qui
    // est publié, on le remplace, ou on vide le champ pour ne plus rien publier.
    const membre = repository.seedStaff({ tenantId: TENANT_A, bio: 'Ancienne.' });

    const corrigee = await inTenantA(async () => staff.update(membre.id, { bio: 'Nouvelle.' }));
    expect(corrigee.bio).toBe('Nouvelle.');

    const effacee = await inTenantA(async () => staff.update(membre.id, { bio: null }));
    expect(Object.hasOwn(effacee, 'bio')).toBe(false);
    expect(repository.staff[0]!.bio).toBeNull();
  });

  it('écrit `NULL` et non une chaîne vide, quelle que soit la forme reçue', async () => {
    // Le second constat de la revue de #694. `longTextSchema` rogne sans
    // minimum : `"   "` arrive donc en `""`, et l'écrire tel quel rendrait la
    // ligne inatteignable depuis l'écran — champ vide, rien de changé, bouton
    // éteint, et plus rien pour ramener la colonne à `NULL`.
    const compte = users.seedAccount({ tenantId: TENANT_A });

    const creee = await inTenantA(async () =>
      staff.create({ userId: compte.id, displayName: 'Léa', bio: '' }),
    );
    expect(Object.hasOwn(creee, 'bio')).toBe(false);
    expect(repository.staff[0]!.bio).toBeNull();

    await inTenantA(async () => staff.update(creee.id, { bio: 'Un texte.' }));
    const videe = await inTenantA(async () => staff.update(creee.id, { bio: '' }));

    expect(Object.hasOwn(videe, 'bio')).toBe(false);
    expect(repository.staff[0]!.bio).toBeNull();
  });

  it('ne touche pas à la présentation quand seul le nom change', async () => {
    // La garde qui remplace le drapeau « ce champ a été touché » du panneau :
    // un corps sans `bio` laisse la présentation en place, et c'est ce qui
    // permet à l'écran de tout renvoyer sans rien effacer par mégarde.
    const membre = repository.seedStaff({ tenantId: TENANT_A, bio: 'Intacte.' });

    const modifiee = await inTenantA(async () => staff.update(membre.id, { displayName: 'Léa' }));

    expect(modifiee).toEqual({ id: membre.id, displayName: 'Léa', bio: 'Intacte.', isActive: true });
  });
});
