import { JwtService } from '@nestjs/jwt';

import { BusinessRuleError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { EmailAlreadyRegisteredError, InvitationAlreadyAcceptedError } from '../identity.errors';
import type { AuthenticatedUser } from '../identity.types';
import { TokenService } from '../token.service';
import { UsersService } from '../users.service';
import { fakeConfig, FakeIdentityRepository, rejectionOf } from './identity.doubles';

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
  /** Le **vrai** service de jetons — c'est lui qui signe les invitations. */
  tokens: TokenService;
  adminA: string;
  staffA: string;
  clientA: string;
  adminB: string;
  /** Un compte du personnel invité et jamais activé — `password_hash` nul. */
  inviteeA: string;
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
  // Le **vrai** service de jetons : c'est lui qui signe les invitations, et les
  // vérifier avec le même service est ce qui prouve que la revendication de
  // tenant y voyage réellement.
  const tokens = new TokenService(new JwtService(), fakeConfig());

  return {
    service: new UsersService(repository.asRepository(), tokens),
    repository,
    tokens,
    adminA: adminA.id,
    staffA: staffA.id,
    clientA: clientA.id,
    adminB: adminB.id,
    // Les quatre comptes de la fixture naissent sans empreinte : `staffA` est
    // donc, tel quel, un compte **invité et jamais activé** (#55). Les cas
    // « déjà activé » posent explicitement une empreinte sur lui.
    inviteeA: staffA.id,
  };
}

/** Pose une empreinte sur un compte — il cesse d'être « invité ». */
function activate(repository: FakeIdentityRepository, userId: string): void {
  const user = repository.users.find((candidate) => candidate.id === userId);
  if (user === undefined) {
    throw new Error(`compte ${userId} absent de la fixture`);
  }
  user.passwordHash = '$2a$04$empreinte-de-test-sans-valeur';
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

  describe('updateOwnContactDetails — #47', () => {
    it('n’écrit que les champs présents, et laisse les autres tels quels', async () => {
      const f = fixture();
      const updated = await runWithTenant(TENANT_A, () =>
        f.service.updateOwnContactDetails({
          userId: f.clientA,
          changes: { firstName: 'Camille' },
        }),
      );

      expect(updated).toMatchObject({ id: f.clientA, firstName: 'Camille', lastName: 'Durand' });
      const written = f.repository.users.find((user) => user.id === f.clientA);
      expect(written?.firstName).toBe('Camille');
      // Le champ omis n'est pas effacé : `partial` veut dire « ce qui est
      // envoyé », pas « ce qui reste ».
      expect(written?.lastName).toBe('Durand');
    });

    it('efface le numéro sur un `phone` à `null`, et n’y touche pas s’il est absent', async () => {
      const f = fixture();
      const seeded = f.repository.users.find((user) => user.id === f.clientA);
      expect(seeded).toBeDefined();
      if (seeded !== undefined) {
        seeded.phone = '+261340000000';
      }

      await runWithTenant(TENANT_A, () =>
        f.service.updateOwnContactDetails({ userId: f.clientA, changes: { firstName: 'Camille' } }),
      );
      expect(f.repository.users.find((user) => user.id === f.clientA)?.phone).toBe(
        '+261340000000',
      );

      const cleared = await runWithTenant(TENANT_A, () =>
        f.service.updateOwnContactDetails({ userId: f.clientA, changes: { phone: null } }),
      );
      expect(cleared.phone).toBeNull();
      expect(f.repository.users.find((user) => user.id === f.clientA)?.phone).toBeNull();
    });

    it('accepte une demande vide sans rien changer', async () => {
      // Un formulaire renvoyé sans modification n'est pas une erreur ; l'écrire
      // quand même ferait tourner `updated_at` pour rien.
      const f = fixture();
      const unchanged = await runWithTenant(TENANT_A, () =>
        f.service.updateOwnContactDetails({ userId: f.clientA, changes: {} }),
      );

      expect(unchanged).toMatchObject({ firstName: 'Alice', lastName: 'Durand' });
    });

    it('ne rend ni empreinte de mot de passe ni établissement', async () => {
      const f = fixture();
      const updated = await runWithTenant(TENANT_A, () =>
        f.service.updateOwnContactDetails({ userId: f.clientA, changes: { lastName: 'Rakoto' } }),
      );

      expect(Object.keys(updated).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
    });

    it('lève `NotFoundError` pour un compte d’un autre établissement, et n’écrit rien', async () => {
      const f = fixture();
      const failure = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.updateOwnContactDetails({
            userId: f.adminB,
            changes: { firstName: 'Intruse' },
          }),
        ),
      );

      expect(failure).toBeInstanceOf(NotFoundError);
      // La ressource du tenant B est intacte — tenant-isolation §6, point 4.
      expect(f.repository.users.find((user) => user.id === f.adminB)?.firstName).toBe('Alice');
    });

    it('rend le même refus pour « inconnu partout » et « connu ailleurs »', async () => {
      // La différence entre les deux est précisément l'information à ne pas
      // donner (tenant-isolation §4).
      const f = fixture();
      const inconnu = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.updateOwnContactDetails({
            userId: '99999999-9999-4999-8999-999999999999',
            changes: { firstName: 'Camille' },
          }),
        ),
      );
      const ailleurs = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.updateOwnContactDetails({ userId: f.adminB, changes: { firstName: 'Camille' } }),
        ),
      );

      expect((inconnu as NotFoundError).message).toBe((ailleurs as NotFoundError).message);
      expect((inconnu as NotFoundError).status).toBe((ailleurs as NotFoundError).status);
    });
  });


  describe('inviteStaffMember — #55', () => {
    const INVITATION = {
      email: 'nouvelle@lilas.test',
      role: 'STAFF' as const,
      firstName: 'Camille',
      lastName: 'Rakoto',
      phone: null,
    };

    it('crée un compte **sans mot de passe** et rend son invitation', async () => {
      const f = fixture();
      const invitation = await runWithTenant(TENANT_A, () =>
        f.service.inviteStaffMember({ tenantId: TENANT_A, ...INVITATION }),
      );

      expect(invitation.user.email).toBe('nouvelle@lilas.test');
      expect(invitation.user.role).toBe('STAFF');
      expect(invitation.expiresIn).toBe(7 * 24 * 3600);

      // L'empreinte absente **est** l'état « invité » : aucune colonne ne le dit,
      // et c'est ce qui permet de livrer l'invitation sans migration.
      const stored = f.repository.users.find((user) => user.id === invitation.user.id);
      expect(stored?.passwordHash).toBeNull();
      expect(stored?.tenantId).toBe(TENANT_A);
      expect(stored?.isActive).toBe(true);
    });

    it('n’expose ni l’empreinte ni le tenant dans ce qu’il rend', async () => {
      const f = fixture();
      const invitation = await runWithTenant(TENANT_A, () =>
        f.service.inviteStaffMember({ tenantId: TENANT_A, ...INVITATION }),
      );

      // `tenantId` n'apparaît jamais dans une charge utile d'API
      // (tenant-isolation §4) — pas même dans le profil rendu à un administrateur.
      expect(Object.keys(invitation.user).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
    });

    it('signe une invitation qui désigne le compte créé et son établissement', async () => {
      const f = fixture();
      const invitation = await runWithTenant(TENANT_A, () =>
        f.service.inviteStaffMember({ tenantId: TENANT_A, ...INVITATION }),
      );

      const claims = await f.tokens.verifyInvitationToken(invitation.invitationToken);
      expect(claims.sub).toBe(invitation.user.id);
      expect(claims.tenantId).toBe(TENANT_A);
      // Pas de `role` dans le jeton : le rang est relu sur le compte à
      // l'acceptation, sans quoi une rétrogradation décidée entre-temps resterait
      // sans effet.
      expect(Object.keys(claims).sort()).toEqual(['sub', 'tenantId', 'typ']);
    });

    it('normalise l’adresse — sans quoi le compte serait inconnectable', async () => {
      const f = fixture();
      const invitation = await runWithTenant(TENANT_A, () =>
        f.service.inviteStaffMember({
          tenantId: TENANT_A,
          ...INVITATION,
          email: '  Nouvelle@Lilas.TEST ',
        }),
      );

      // `/auth/login` normalise ; l'unique du schéma porte sur les octets. Une
      // ligne écrite en capitales serait prise et pourtant introuvable.
      expect(invitation.user.email).toBe('nouvelle@lilas.test');
    });

    it('refuse une adresse déjà prise dans l’établissement, fût-ce par une cliente', async () => {
      const f = fixture();
      const rejet = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.inviteStaffMember({
            tenantId: TENANT_A,
            ...INVITATION,
            email: 'cliente@lilas.test',
          }),
        ),
      );

      // La faire passer au personnel est un changement de rôle, pas une création.
      expect(rejet).toBeInstanceOf(EmailAlreadyRegisteredError);
      expect((rejet as EmailAlreadyRegisteredError).status).toBe(409);
    });

    it('laisse la même adresse libre dans l’établissement voisin', async () => {
      const f = fixture();
      // L'unicité est `(tenant_id, email)` : la même personne peut travailler
      // dans deux salons, et l'un ne doit pas pouvoir en déduire l'autre.
      const invitation = await runWithTenant(TENANT_B, () =>
        f.service.inviteStaffMember({
          tenantId: TENANT_B,
          ...INVITATION,
          email: 'cliente@lilas.test',
        }),
      );

      expect(invitation.user.email).toBe('cliente@lilas.test');
      expect(f.repository.users.find((user) => user.id === invitation.user.id)?.tenantId).toBe(
        TENANT_B,
      );
    });
  });

  describe('reissueInvitation — #55', () => {
    it('réémet une invitation valide pour un compte jamais activé', async () => {
      const f = fixture();
      const invitation = await runWithTenant(TENANT_A, () =>
        f.service.reissueInvitation({ tenantId: TENANT_A, userId: f.inviteeA }),
      );

      const claims = await f.tokens.verifyInvitationToken(invitation.invitationToken);
      expect(claims.sub).toBe(f.inviteeA);
      expect(claims.tenantId).toBe(TENANT_A);
    });

    it('refuse en 409 un compte déjà activé', async () => {
      const f = fixture();
      activate(f.repository, f.inviteeA);

      const rejet = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.reissueInvitation({ tenantId: TENANT_A, userId: f.inviteeA }),
        ),
      );

      // Dit franchement : l'appelant est un administrateur de l'établissement,
      // il a déjà le droit de lire ce compte.
      expect(rejet).toBeInstanceOf(InvitationAlreadyAcceptedError);
      expect((rejet as InvitationAlreadyAcceptedError).status).toBe(409);
    });

    it('refuse en 422 un compte désactivé — le lien ne pourrait qu’échouer', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.inviteeA,
          isActive: false,
        }),
      );

      const rejet = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.reissueInvitation({ tenantId: TENANT_A, userId: f.inviteeA }),
        ),
      );

      // `acceptInvitation` refuserait ce compte par un 401 muet, et l'échec
      // tomberait chez la personne invitée plutôt que chez l'administrateur.
      expect(rejet).toBeInstanceOf(BusinessRuleError);
      expect((rejet as BusinessRuleError).status).toBe(422);
    });

    it('rend 404 pour une fiche cliente comme pour un compte d’ailleurs', async () => {
      const f = fixture();
      const cliente = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.reissueInvitation({ tenantId: TENANT_A, userId: f.clientA }),
        ),
      );
      const ailleurs = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.reissueInvitation({ tenantId: TENANT_A, userId: f.adminB }),
        ),
      );

      expect(cliente).toBeInstanceOf(NotFoundError);
      expect(ailleurs).toBeInstanceOf(NotFoundError);
      expect((cliente as NotFoundError).message).toBe((ailleurs as NotFoundError).message);
    });
  });

  describe('updateStaffContactDetails — #55', () => {
    it('modifie les coordonnées d’un membre du personnel', async () => {
      const f = fixture();
      const profile = await runWithTenant(TENANT_A, () =>
        f.service.updateStaffContactDetails({
          userId: f.staffA,
          changes: { firstName: 'Camille', phone: '+261340000000' },
        }),
      );

      expect(profile.firstName).toBe('Camille');
      expect(profile.phone).toBe('+261340000000');
      expect(f.repository.users.find((user) => user.id === f.staffA)?.lastName).toBe('Durand');
    });

    it('ne touche ni au rôle, ni à l’activation, ni à l’adresse', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.service.updateStaffContactDetails({ userId: f.staffA, changes: { firstName: 'Camille' } }),
      );

      // Une route qui écrirait le rôle serait une seconde porte vers
      // l'attribution des droits, ouverte au rang `MANAGER`.
      const stored = f.repository.users.find((user) => user.id === f.staffA);
      expect(stored?.role).toBe('STAFF');
      expect(stored?.isActive).toBe(true);
      expect(stored?.email).toBe('praticienne@lilas.test');
    });

    it('rend 404 pour une fiche cliente comme pour un compte d’ailleurs, sans rien écrire', async () => {
      const f = fixture();
      const cliente = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.updateStaffContactDetails({
            userId: f.clientA,
            changes: { firstName: 'Camille' },
          }),
        ),
      );
      const ailleurs = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.updateStaffContactDetails({
            userId: f.adminB,
            changes: { firstName: 'Camille' },
          }),
        ),
      );

      expect(cliente).toBeInstanceOf(NotFoundError);
      expect(ailleurs).toBeInstanceOf(NotFoundError);
      // Pas 4 du protocole : la ressource visée est intacte (tenant-isolation §6).
      expect(f.repository.users.find((user) => user.id === f.adminB)?.firstName).toBe('Alice');
      expect(f.repository.users.find((user) => user.id === f.clientA)?.firstName).toBe('Alice');
    });
  });

  describe('setStaffAccountActive — #55', () => {
    it('désactive **sans supprimer** la ligne du compte', async () => {
      const f = fixture();
      const state = await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: false,
        }),
      );

      expect(state.isActive).toBe(false);
      // Le critère est « désactivation sans suppression des rendez-vous passés » :
      // la ligne survit, donc tout ce qui la référence aussi.
      const stored = f.repository.users.find((user) => user.id === f.staffA);
      expect(stored).toBeDefined();
      expect(stored?.isActive).toBe(false);
      expect(stored?.email).toBe('praticienne@lilas.test');
    });

    it('révoque les sessions vivantes du compte désactivé', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.repository.createSession({
          userId: f.staffA,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );

      await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: false,
        }),
      );

      // Sans cela, la chaîne de rafraîchissement continuerait de rendre des
      // jetons d'accès à un compte qu'on vient de fermer.
      expect(f.repository.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('ne révoque rien à la réactivation', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: false,
        }),
      );
      await runWithTenant(TENANT_A, () =>
        f.repository.createSession({
          userId: f.staffA,
          tokenHash: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );

      const state = await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: true,
        }),
      );

      expect(state.isActive).toBe(true);
      // Déconnecter un compte qu'on vient de rouvrir n'aurait aucun sens.
      expect(f.repository.sessions.every((session) => session.revokedAt === null)).toBe(true);
    });

    it('est idempotent — rejouer la même demande ne révoque pas une seconde fois', async () => {
      const f = fixture();
      await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: false,
        }),
      );
      await runWithTenant(TENANT_A, () =>
        f.repository.createSession({
          userId: f.staffA,
          tokenHash: 'c'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );

      const state = await runWithTenant(TENANT_A, () =>
        f.service.setStaffAccountActive({
          actor: actor(f.adminA),
          userId: f.staffA,
          isActive: false,
        }),
      );

      expect(state.isActive).toBe(false);
      // La session ouverte après coup n'est pas coupée : rien n'a changé d'état,
      // donc il n'y a rien à propager. La réponse dit quand même l'état demandé.
      expect(f.repository.sessions.every((session) => session.revokedAt === null)).toBe(true);
    });

    it('refuse en 422 qu’un compte se désactive lui-même', async () => {
      const f = fixture();
      const rejet = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.setStaffAccountActive({
            actor: actor(f.adminA),
            userId: f.adminA,
            isActive: false,
          }),
        ),
      );

      // L'unique administrateur d'un salon qui se désactive ferme la porte de
      // l'intérieur : plus personne pour réactiver quoi que ce soit.
      expect(rejet).toBeInstanceOf(BusinessRuleError);
      expect((rejet as BusinessRuleError).status).toBe(422);
      expect(f.repository.users.find((user) => user.id === f.adminA)?.isActive).toBe(true);
    });

    it('rend 404 pour une fiche cliente comme pour un compte d’ailleurs, sans rien écrire', async () => {
      const f = fixture();
      const cliente = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.setStaffAccountActive({
            actor: actor(f.adminA),
            userId: f.clientA,
            isActive: false,
          }),
        ),
      );
      const ailleurs = await rejectionOf(
        runWithTenant(TENANT_A, () =>
          f.service.setStaffAccountActive({
            actor: actor(f.adminA),
            userId: f.adminB,
            isActive: false,
          }),
        ),
      );

      expect(cliente).toBeInstanceOf(NotFoundError);
      expect(ailleurs).toBeInstanceOf(NotFoundError);
      expect((cliente as NotFoundError).message).toBe((ailleurs as NotFoundError).message);
      // Le compte du voisin n'a pas bougé — pas 4 du protocole.
      expect(f.repository.users.find((user) => user.id === f.adminB)?.isActive).toBe(true);
      expect(f.repository.users.find((user) => user.id === f.clientA)?.isActive).toBe(true);
    });
  });

  describe('défaut fermé', () => {
    it('refuse de lire hors de toute portée de tenant', async () => {
      // Sans contexte, aucune donnée. Le mode ouvert par défaut est ce qui
      // produit les fuites (tenant-isolation §3).
      const f = fixture();
      await expect(f.service.byId(f.staffA)).rejects.toThrow(/tenant/i);
      await expect(f.service.listStaffAccounts()).rejects.toThrow(/tenant/i);
      await expect(
        f.service.updateOwnContactDetails({ userId: f.clientA, changes: { firstName: 'X' } }),
      ).rejects.toThrow(/tenant/i);
    });
  });
});
