import { BusinessRuleError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { AuthenticatedUser } from '../identity.types';
import { UsersService } from '../users.service';
import { FakeIdentityRepository, rejectionOf } from './identity.doubles';

/**
 * Administration des comptes — règles métier, sans HTTP ni base.
 *
 * Le dépôt en mémoire filtre sur le **vrai** contexte de tenant, celui que
 * l'extension Prisma consulte : les cas « compte d'un autre établissement »
 * empruntent donc exactement le chemin de la production — la lecture ne trouve
 * rien, et c'est ce rien qui devient le 404.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

interface Fixture {
  service: UsersService;
  repository: FakeIdentityRepository;
  adminA: string;
  staffA: string;
  clientA: string;
  adminB: string;
}

function fixture(): Fixture {
  const repository = new FakeIdentityRepository();
  const adminA = repository.addUser({
    tenantId: TENANT_A,
    email: 'admin@lilas.test',
    passwordHash: null,
    role: 'ADMIN',
  });
  const staffA = repository.addUser({
    tenantId: TENANT_A,
    email: 'praticienne@lilas.test',
    passwordHash: null,
    role: 'STAFF',
  });
  const clientA = repository.addUser({
    tenantId: TENANT_A,
    email: 'cliente@lilas.test',
    passwordHash: null,
    role: 'CLIENT',
  });
  const adminB = repository.addUser({
    tenantId: TENANT_B,
    email: 'admin@port.test',
    passwordHash: null,
    role: 'ADMIN',
  });

  return {
    service: new UsersService(repository.asRepository()),
    repository,
    adminA: adminA.id,
    staffA: staffA.id,
    clientA: clientA.id,
    adminB: adminB.id,
  };
}

const actor = (userId: string, tenantId = TENANT_A): AuthenticatedUser => ({
  userId,
  tenantId,
  role: 'ADMIN',
});

describe('UsersService', () => {
  describe('listStaffAccounts', () => {
    it('rend les comptes internes de l’établissement courant, jamais la clientèle', async () => {
      const f = fixture();
      const list = await runWithTenant(TENANT_A, () => f.service.listStaffAccounts());

      // Ordre `(role, email)` — le rang d'abord, et le rang d'un `enum`
      // PostgreSQL est son ordre de déclaration : `STAFF` avant `ADMIN`.
      expect(list.map((user) => user.id)).toEqual([f.staffA, f.adminA]);
      expect(list.map((user) => user.role)).toEqual(['STAFF', 'ADMIN']);
      expect(list.map((user) => user.id)).not.toContain(f.clientA);
    });

    it('ne laisse filtrer aucun compte d’un autre établissement', async () => {
      const f = fixture();
      const list = await runWithTenant(TENANT_A, () => f.service.listStaffAccounts());

      expect(list.map((user) => user.id)).not.toContain(f.adminB);
      expect(JSON.stringify(list)).not.toContain('port.test');
    });

    it('n’expose ni empreinte ni tenant', async () => {
      const f = fixture();
      const list = await runWithTenant(TENANT_A, () => f.service.listStaffAccounts());

      expect(Object.keys(list[0] ?? {}).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
    });
  });

  describe('byId', () => {
    it('rend le compte interne de l’établissement courant', async () => {
      const f = fixture();
      const user = await runWithTenant(TENANT_A, () => f.service.byId(f.staffA));
      expect(user.id).toBe(f.staffA);
    });

    it('rend 404 sur une fiche cliente du même établissement', async () => {
      // La route sert l'administration des droits, pas la consultation de la
      // clientèle : celle-ci relève de `crm` et de ses propres permissions
      // (CDC §5.1). Le point d'entrée rend ce que la liste rend, ni plus.
      const f = fixture();
      const failure = await rejectionOf(runWithTenant(TENANT_A, () => f.service.byId(f.clientA)));

      expect(failure).toBeInstanceOf(NotFoundError);
      expect((failure as NotFoundError).details).toEqual({});
    });

    it('lève `NotFoundError` pour un identifiant inconnu', async () => {
      const f = fixture();
      await expect(
        runWithTenant(TENANT_A, () => f.service.byId('33333333-3333-4333-8333-333333333333')),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lève `NotFoundError` — et non `ForbiddenError` — pour un compte d’un autre établissement', async () => {
      // Le cœur du critère de #22 : distinguer les deux confirmerait l'existence
      // du second (tenant-isolation §4). Le service n'a même pas l'information.
      const f = fixture();
      const failure = await rejectionOf(runWithTenant(TENANT_A, () => f.service.byId(f.adminB)));

      expect(failure).toBeInstanceOf(NotFoundError);
      expect((failure as NotFoundError).code).toBe('NOT_FOUND');
      expect((failure as NotFoundError).details).toEqual({});
    });

    it('rend le même refus pour « inconnu partout » et « connu ailleurs »', async () => {
      const f = fixture();
      const inconnu = (await rejectionOf(
        runWithTenant(TENANT_A, () => f.service.byId('44444444-4444-4444-8444-444444444444')),
      )) as NotFoundError;
      const ailleurs = (await rejectionOf(
        runWithTenant(TENANT_A, () => f.service.byId(f.adminB)),
      )) as NotFoundError;

      expect(inconnu.message).toBe(ailleurs.message);
      expect(inconnu.code).toBe(ailleurs.code);
      expect(inconnu.details).toEqual(ailleurs.details);
    });
  });

  describe('changeRole', () => {
    it('attribue le rôle demandé et le rend dans la réponse', async () => {
      const f = fixture();
      const updated = await runWithTenant(TENANT_A, () =>
        f.service.changeRole({ actor: actor(f.adminA), userId: f.staffA, role: 'ADMIN' }),
      );

      expect(updated.role).toBe('ADMIN');
      expect(await runWithTenant(TENANT_A, () => f.service.byId(f.staffA))).toMatchObject({
        role: 'ADMIN',
      });
    });

    it('révoque les sessions du compte dont le rang change', async () => {
      // Le rang voyage dans un jeton déjà signé : sans cette révocation, une
      // rétrogradation resterait sans effet pendant les sept jours du jeton de
      // renouvellement, le porteur se réémettant un jeton d'accès à volonté.
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.repository.createSession({
          userId: f.staffA,
          tokenHash: 'empreinte-de-session',
          expiresAt: new Date(Date.now() + 604_800_000),
        }),
      );

      await runWithTenant(TENANT_A, () =>
        f.service.changeRole({ actor: actor(f.adminA), userId: f.staffA, role: 'CLIENT' }),
      );

      expect(f.repository.sessions.filter((session) => session.revokedAt === null)).toHaveLength(0);
    });

    it('ne révoque rien quand le rôle ne change pas', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.repository.createSession({
          userId: f.staffA,
          tokenHash: 'empreinte-de-session',
          expiresAt: new Date(Date.now() + 604_800_000),
        }),
      );

      await runWithTenant(TENANT_A, () =>
        f.service.changeRole({ actor: actor(f.adminA), userId: f.staffA, role: 'STAFF' }),
      );

      expect(f.repository.sessions.filter((session) => session.revokedAt === null)).toHaveLength(1);
    });

    it('promeut une cliente en membre du personnel', async () => {
      // La lecture d'une fiche cliente est refusée par `byId` ; sa promotion ne
      // l'est pas — c'est ainsi qu'un salon embauche une cliente fidèle.
      const f = fixture();
      const updated = await runWithTenant(TENANT_A, () =>
        f.service.changeRole({ actor: actor(f.adminA), userId: f.clientA, role: 'STAFF' }),
      );

      expect(updated).toMatchObject({ id: f.clientA, role: 'STAFF' });
    });

    it('accepte la réattribution du rôle déjà porté, sans 404', async () => {
      // `updateUserRole` rendrait `false` faute de ligne modifiée : la relecture
      // préalable est ce qui distingue « inconnu ici » d'une non-modification.
      const f = fixture();
      const updated = await runWithTenant(TENANT_A, () =>
        f.service.changeRole({ actor: actor(f.adminA), userId: f.staffA, role: 'STAFF' }),
      );

      expect(updated.role).toBe('STAFF');
    });

    it('refuse qu’un compte modifie son propre rôle — 422, pas 403', async () => {
      // L'appelant *a* le droit ; c'est l'opération qui n'a pas de sens. Sans
      // cette règle, l'unique administrateur d'un salon peut se rétrograder et
      // laisser l'établissement sans personne pour attribuer des droits.
      const f = fixture();
      const failure = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.changeRole({ actor: actor(f.adminA), userId: f.adminA, role: 'STAFF' }),
        ),
      );

      expect(failure).toBeInstanceOf(BusinessRuleError);
      expect((failure as BusinessRuleError).status).toBe(422);
      // Rien n'a bougé.
      expect(await runWithTenant(TENANT_A, () => f.service.byId(f.adminA))).toMatchObject({
        role: 'ADMIN',
      });
    });

    it('lève `NotFoundError` pour un compte d’un autre établissement, et n’écrit rien', async () => {
      const f = fixture();
      await expect(
        runWithTenant(TENANT_A, () =>
          f.service.changeRole({ actor: actor(f.adminA), userId: f.adminB, role: 'STAFF' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      // La ressource du tenant B est intacte — tenant-isolation §6, point 4.
      const intact = f.repository.users.find((user) => user.id === f.adminB);
      expect(intact?.role).toBe('ADMIN');
    });
  });

  describe('défaut fermé', () => {
    it('refuse de lire hors de toute portée de tenant', async () => {
      // Sans contexte, aucune donnée. Le mode ouvert par défaut est ce qui
      // produit les fuites (tenant-isolation §3).
      const f = fixture();
      await expect(f.service.byId(f.staffA)).rejects.toThrow(/tenant/i);
      await expect(f.service.listStaffAccounts()).rejects.toThrow(/tenant/i);
    });
  });
});
