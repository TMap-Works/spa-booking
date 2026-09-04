import { JwtService } from '@nestjs/jwt';

import { ConflictError, NotFoundError } from '../../../common/errors';
import { getTenantId, runInTenantScope, runWithTenant } from '../../../common/tenant';
import { AuthService } from '../auth.service';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInvitationError,
  InvalidRefreshTokenError,
} from '../identity.errors';
import { PasswordHasher } from '../password.hasher';
import { hashJti, TokenService } from '../token.service';
import { FakeIdentityRepository, fakeConfig, rejectionOf, silentLogger } from './identity.doubles';

/**
 * Règles d'authentification, exercées sans HTTP et sans base.
 *
 * Ce qui est vérifié ici n'est pas « ça marche » mais « ça refuse » : la valeur
 * d'un module d'authentification tient à ce qu'il rejette, et à ce qu'il ne
 * *dit* pas en rejetant.
 */
describe('AuthService', () => {
  const SLUG = 'salon-des-lilas';
  const PASSWORD = 'correct-horse-battery';

  let repository: FakeIdentityRepository;
  let service: AuthService;
  let tokens: TokenService;
  let tenantId: string;

  beforeEach(() => {
    const config = fakeConfig();
    repository = new FakeIdentityRepository();
    tenantId = repository.addTenant(SLUG);
    tokens = new TokenService(new JwtService(), config);
    service = new AuthService(
      repository.asRepository(),
      new PasswordHasher(config),
      tokens,
      silentLogger(),
    );
  });

  /** Chaque appel se fait dans une portée de requête, comme derrière le middleware. */
  const inRequest = async <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope(async () => fn());

  describe('inscription', () => {
    it('ouvre une session et ne rend jamais l’empreinte du mot de passe', async () => {
      const result = await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
        }),
      );

      expect(result.accessToken).not.toBe('');
      expect(result.refreshToken).not.toBe('');
      expect(result.user.email).toBe('alice@example.test');
      // Le profil est clos : ni `tenantId`, ni `passwordHash`, ni `isActive`.
      expect(Object.keys(result.user).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
      expect(JSON.stringify(result.user)).not.toContain(PASSWORD);
      expect(JSON.stringify(result.user)).not.toContain(tenantId);
    });

    it('stocke une empreinte, jamais le mot de passe en clair', async () => {
      await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
        }),
      );

      const stored = repository.users[0];
      expect(stored).toBeDefined();
      expect(stored?.passwordHash).not.toBe(PASSWORD);
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('force le rôle CLIENT — une inscription publique ne fabrique pas d’administrateur', async () => {
      await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
        }),
      );

      expect(repository.users[0]?.role).toBe('CLIENT');
    });

    it('normalise l’adresse — deux casses ne font pas deux comptes', async () => {
      await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: '  Alice@Example.Test ',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
        }),
      );

      expect(repository.users[0]?.email).toBe('alice@example.test');

      await expect(
        inRequest(() =>
          service.register({
            tenantSlug: SLUG,
            email: 'ALICE@EXAMPLE.TEST',
            password: PASSWORD,
            firstName: 'Alice',
            lastName: 'Durand',
          }),
        ),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    });

    it('refuse un établissement inconnu par un 404, jamais un 403', async () => {
      const error = await inRequest(() =>
        service
          .register({
            tenantSlug: 'salon-inexistant',
            email: 'alice@example.test',
            password: PASSWORD,
            firstName: 'Alice',
            lastName: 'Durand',
          })
          .catch((caught: unknown) => caught),
      );

      // Un 403 confirmerait qu'un établissement porte ce slug.
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).status).toBe(404);
    });

    it('laisse la même adresse s’inscrire dans deux établissements distincts', async () => {
      const autreSlug = 'barbier-du-port';
      repository.addTenant(autreSlug);

      await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
        }),
      );

      // L'unicité est par tenant : l'un ne doit pas pouvoir déduire l'autre.
      await expect(
        inRequest(() =>
          service.register({
            tenantSlug: autreSlug,
            email: 'alice@example.test',
            password: PASSWORD,
            firstName: 'Alice',
            lastName: 'Durand',
          }),
        ),
      ).resolves.toBeDefined();

      expect(repository.users).toHaveLength(2);
    });
  });

  describe('connexion', () => {
    beforeEach(async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
    });

    it('pose le tenant dans le contexte depuis le slug résolu, pas depuis l’entrée', async () => {
      const seen = await runInTenantScope(async () => {
        await service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD });
        return getTenantId();
      });

      expect(seen).toBe(tenantId);
    });

    it('émet un jeton d’accès portant le tenant et le rôle', async () => {
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );

      const claims = await tokens.verifyAccessToken(result.accessToken);
      expect(claims).not.toBeNull();
      expect(claims?.tenantId).toBe(tenantId);
      expect(claims?.role).toBe('CLIENT');
    });

    it.each([
      ['un mot de passe faux', 'alice@example.test', 'mauvais-mot-de-passe'],
      ['une adresse inconnue', 'inconnue@example.test', PASSWORD],
    ])('refuse %s par le même message, sans rien distinguer', async (_cas, email, password) => {
      // Distinguer « adresse inconnue » de « mot de passe faux » transformerait le
      // formulaire en oracle d'énumération : on découvrirait qui est client de
      // quel salon sans jamais réussir à se connecter.
      const error = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email, password }).catch((caught: unknown) => caught),
      );

      expect(error).toBeInstanceOf(InvalidCredentialsError);
      expect((error as InvalidCredentialsError).status).toBe(401);
      expect((error as InvalidCredentialsError).message).toBe('Identifiants invalides.');
      expect((error as InvalidCredentialsError).details).toEqual({});
    });

    it('refuse un compte désactivé sans le distinguer d’un mot de passe faux', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'ancien@example.test',
        passwordHash: await hasher.hash(PASSWORD),
        isActive: false,
      });

      await expect(
        inRequest(() =>
          service.login({ tenantSlug: SLUG, email: 'ancien@example.test', password: PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('refuse un compte sans mot de passe — créé au comptoir, jamais activé', async () => {
      repository.addUser({ tenantId, email: 'comptoir@example.test', passwordHash: null });

      await expect(
        inRequest(() =>
          service.login({ tenantSlug: SLUG, email: 'comptoir@example.test', password: PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('ne laisse pas se connecter avec les identifiants d’un autre établissement', async () => {
      const autreSlug = 'barbier-du-port';
      repository.addTenant(autreSlug);

      // Les identifiants sont bons — mais pas dans ce salon-là.
      await expect(
        inRequest(() =>
          service.login({ tenantSlug: autreSlug, email: 'alice@example.test', password: PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });

  describe('rafraîchissement', () => {
    const openSession = async (): Promise<string> => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );
      return result.refreshToken;
    };

    it('fait tourner le jeton — l’ancien ne resservira pas', async () => {
      const first = await openSession();
      const rotated = await inRequest(() => service.refresh(first));

      expect(rotated.refreshToken).not.toBe(first);
      expect(rotated.accessToken).not.toBe('');
    });

    it('révoque toute la session au réemploi d’un jeton déjà consommé', async () => {
      const first = await openSession();
      await inRequest(() => service.refresh(first));

      // Le jeton d'origine ressort : soit un vol, soit un rejeu. On ne sait pas
      // lequel des deux porteurs est légitime, donc aucun ne garde la main.
      await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );

      expect(repository.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('refuse un jeton dont la session a été révoquée', async () => {
      const token = await openSession();
      await inRequest(() => service.logout(token));

      await expect(inRequest(() => service.refresh(token))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse une session expirée en base, même si le jeton n’a pas expiré', async () => {
      const token = await openSession();
      const session = repository.sessions[0];
      expect(session).toBeDefined();
      // C'est la base qui tranche, pas l'`exp` du porteur.
      if (session !== undefined) {
        session.expiresAt = new Date(Date.now() - 1000);
      }

      await expect(inRequest(() => service.refresh(token))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse un jeton d’accès présenté comme jeton de rafraîchissement', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );

      // Les deux clés sont distinctes : la vérification échoue avant même `typ`.
      await expect(inRequest(() => service.refresh(result.accessToken))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse un jeton forgé', async () => {
      await expect(inRequest(() => service.refresh('pas.un.jeton'))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it('refuse un jeton dont la session appartient à un autre compte', async () => {
      const token = await openSession();
      const session = repository.sessions[0];
      expect(session).toBeDefined();
      if (session !== undefined) {
        session.userId = 'un-autre-compte';
      }

      await expect(inRequest(() => service.refresh(token))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });
  });

  describe('déconnexion', () => {
    it('éteint la ligne en base — ce n’est pas qu’un cookie effacé', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );

      await inRequest(() => service.logout(result.refreshToken));

      expect(repository.sessions[0]?.revokedAt).toBeInstanceOf(Date);
      expect(hashJti('peu-importe')).toHaveLength(64);
    });

    it('ne lève jamais — ni sans cookie, ni sur un jeton illisible', async () => {
      await expect(inRequest(() => service.logout(null))).resolves.toBeUndefined();
      await expect(inRequest(() => service.logout('pas.un.jeton'))).resolves.toBeUndefined();
    });
  });

  describe('ouverture de session', () => {
    it('ne rend aucun jeton si la ligne n’a pas pu être estampillée', async () => {
      // La ligne est créée avec une empreinte de remplissage, puis estampillée
      // avec la vraie. Si l'estampillage échoue — une révocation globale du
      // compte, déclenchée depuis un autre appareil, passe exactement là —,
      // rendre le jeton donnerait au porteur une empreinte qui ne correspond à
      // rien : son premier rafraîchissement serait pris pour un réemploi et
      // éteindrait toutes ses sessions.
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      jest.spyOn(repository, 'rotateSession').mockResolvedValue(false);

      await expect(
        inRequest(() =>
          service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('portée de tenant déjà résolue', () => {
    it('refuse une connexion dont le slug désigne un autre établissement', async () => {
      // Un second résolveur (la résolution publique par slug de #23) peut avoir
      // rempli la portée avant d'arriver ici. Poursuivre lirait et écrirait dans
      // l'établissement de la portée tout en signant des jetons pour l'autre.
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const autre = repository.addTenant('barbier-du-port');

      await expect(
        runWithTenant(autre, async () =>
          service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuse un rafraîchissement dont le jeton vise un autre établissement', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );
      const autre = repository.addTenant('barbier-du-port');

      await expect(
        runWithTenant(autre, async () => service.refresh(result.refreshToken)),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('ne révoque rien à la déconnexion quand la portée vise ailleurs', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      repository.addUser({
        tenantId,
        email: 'alice@example.test',
        passwordHash: await hasher.hash(PASSWORD),
      });
      const result = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );
      const autre = repository.addTenant('barbier-du-port');

      await expect(
        runWithTenant(autre, async () => service.logout(result.refreshToken)),
      ).resolves.toBeUndefined();
      expect(repository.sessions[0]?.revokedAt).toBeNull();
    });
  });

  /**
   * Première connexion d'un membre du personnel invité — #55.
   *
   * Ce qui se prouve ici n'est pas seulement « la session s'ouvre », mais que
   * l'invitation **cesse d'ouvrir quoi que ce soit** dès qu'elle a servi, sans
   * qu'aucune colonne ne la gage. L'usage unique vient de `password_hash IS NULL`
   * dans le `where` de l'écriture, et c'est cette propriété-là que les cas de
   * rejeu exercent.
   */
  describe('acceptation d’une invitation — #55', () => {
    const NEW_PASSWORD = 'invitation-mot-de-passe';

    /** Un compte du personnel invité : rôle interne, aucune empreinte. */
    const seedInvitee = (tenant = tenantId): string =>
      repository.addUser({ tenantId: tenant, email: 'praticienne@lilas.test', passwordHash: null, role: 'STAFF' }).id;

    it('pose le premier mot de passe et ouvre la session', async () => {
      const userId = seedInvitee();
      const { token } = await tokens.signInvitationToken({ userId, tenantId });

      const result = await inRequest(() =>
        service.acceptInvitation({ token, password: NEW_PASSWORD }),
      );

      expect(result.accessToken).not.toBe('');
      expect(result.user.id).toBe(userId);
      expect(result.user.role).toBe('STAFF');
      // Le profil reste clos : ni empreinte, ni tenant (tenant-isolation §4).
      expect(JSON.stringify(result.user)).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(result.user)).not.toContain(tenantId);
    });

    it('stocke une empreinte, jamais le mot de passe en clair', async () => {
      const userId = seedInvitee();
      const { token } = await tokens.signInvitationToken({ userId, tenantId });

      await inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD }));

      const stored = repository.users.find((user) => user.id === userId);
      expect(stored?.passwordHash).not.toBeNull();
      expect(stored?.passwordHash).not.toBe(NEW_PASSWORD);
    });

    it('rend le compte connectable — c’est tout l’objet de la première connexion', async () => {
      const userId = seedInvitee();
      const { token } = await tokens.signInvitationToken({ userId, tenantId });
      await inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD }));

      const session = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'praticienne@lilas.test', password: NEW_PASSWORD }),
      );
      expect(session.user.id).toBe(userId);
    });

    it('n’ouvre rien deux fois — le rejeu du même jeton est refusé', async () => {
      const userId = seedInvitee();
      const { token } = await tokens.signInvitationToken({ userId, tenantId });
      await inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD }));

      // Le jeton reste cryptographiquement valide : c'est l'état du compte qui
      // le périme. C'est ce qui rend l'invitation à usage unique sans migration.
      await expect(
        inRequest(() => service.acceptInvitation({ token, password: 'un-autre-mot-de-passe' })),
      ).rejects.toBeInstanceOf(InvalidInvitationError);

      const stored = repository.users.find((user) => user.id === userId);
      expect(await new PasswordHasher(fakeConfig()).verify(NEW_PASSWORD, stored?.passwordHash ?? null)).toBe(
        true,
      );
    });

    it('refuse un compte déjà doté d’un mot de passe', async () => {
      const hasher = new PasswordHasher(fakeConfig());
      const userId = repository.addUser({
        tenantId,
        email: 'deja@lilas.test',
        passwordHash: await hasher.hash(PASSWORD),
        role: 'STAFF',
      }).id;
      const { token } = await tokens.signInvitationToken({ userId, tenantId });

      // Sans quoi l'invitation serait une réinitialisation de mot de passe
      // déguisée, sans la moindre preuve de possession de l'adresse.
      await expect(
        inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD })),
      ).rejects.toBeInstanceOf(InvalidInvitationError);
    });

    it('refuse un compte désactivé', async () => {
      const userId = repository.addUser({
        tenantId,
        email: 'partie@lilas.test',
        passwordHash: null,
        role: 'STAFF',
        isActive: false,
      }).id;
      const { token } = await tokens.signInvitationToken({ userId, tenantId });

      await expect(
        inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD })),
      ).rejects.toBeInstanceOf(InvalidInvitationError);
    });

    it('refuse une fiche cliente — l’invitation ne concerne que le personnel', async () => {
      const userId = repository.addUser({
        tenantId,
        email: 'cliente@lilas.test',
        passwordHash: null,
        role: 'CLIENT',
      }).id;
      const { token } = await tokens.signInvitationToken({ userId, tenantId });

      await expect(
        inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD })),
      ).rejects.toBeInstanceOf(InvalidInvitationError);
    });

    it('refuse un jeton d’un autre usage — jeton d’accès ou de rafraîchissement', async () => {
      const userId = seedInvitee();
      const access = await tokens.signAccessToken({ userId, tenantId, role: 'STAFF' });
      const refresh = await tokens.signRefreshToken({ userId, tenantId, sessionId: 'session-1' });

      // Les clés sont distinctes — celle des invitations est dérivée du secret de
      // rafraîchissement par HMAC — et `typ` est vérifié par-dessus.
      for (const token of [access, refresh.token]) {
        await expect(
          inRequest(() => service.acceptInvitation({ token, password: NEW_PASSWORD })),
        ).rejects.toBeInstanceOf(InvalidInvitationError);
      }
    });

    it('refuse un compte de l’établissement voisin, et n’écrit rien chez lui', async () => {
      const autre = repository.addTenant('barbier-du-port');
      const userId = seedInvitee(autre);
      const { token } = await tokens.signInvitationToken({ userId, tenantId: autre });

      // La portée est déjà celle d'un autre établissement : le jeton n'est pas
      // celui de cette requête, et il est hors de question de choisir.
      await expect(
        runWithTenant(tenantId, async () =>
          service.acceptInvitation({ token, password: NEW_PASSWORD }),
        ),
      ).rejects.toBeInstanceOf(InvalidInvitationError);

      expect(repository.users.find((user) => user.id === userId)?.passwordHash).toBeNull();
    });

    it('rend le même refus quelle qu’en soit la cause', async () => {
      const actif = seedInvitee();
      const inactif = repository.addUser({
        tenantId,
        email: 'partie@lilas.test',
        passwordHash: null,
        role: 'STAFF',
        isActive: false,
      }).id;

      const inconnu = await rejectionOf(
        inRequest(async () =>
          service.acceptInvitation({
            token: (
              await tokens.signInvitationToken({
                userId: '99999999-9999-4999-8999-999999999999',
                tenantId,
              })
            ).token,
            password: NEW_PASSWORD,
          }),
        ),
      );
      const desactive = await rejectionOf(
        inRequest(async () =>
          service.acceptInvitation({
            token: (await tokens.signInvitationToken({ userId: inactif, tenantId })).token,
            password: NEW_PASSWORD,
          }),
        ),
      );
      const contrefait = await rejectionOf(
        inRequest(() => service.acceptInvitation({ token: 'pas-un-jeton', password: NEW_PASSWORD })),
      );

      // Le point d'entrée n'est pas authentifié : distinguer les causes dirait à
      // qui présente un jeton ramassé si le compte existe encore, et dans quel
      // état.
      const messages = [inconnu, desactive, contrefait].map(
        (error) => (error as InvalidInvitationError).message,
      );
      expect(new Set(messages).size).toBe(1);
      expect((inconnu as InvalidInvitationError).status).toBe(401);
      // Le compte encore invitable n'a pas bougé.
      expect(repository.users.find((user) => user.id === actif)?.passwordHash).toBeNull();
    });
  });
});
