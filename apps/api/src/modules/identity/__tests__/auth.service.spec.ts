import { JwtService } from '@nestjs/jwt';

import { ConflictError, NotFoundError } from '../../../common/errors';
import { getTenantId, runInTenantScope, runWithTenant } from '../../../common/tenant';
import { AuthService } from '../auth.service';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from '../identity.errors';
import { PasswordHasher } from '../password.hasher';
import { hashJti, TokenService } from '../token.service';
import { FakeIdentityRepository, fakeConfig, silentLogger } from './identity.doubles';

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
});
