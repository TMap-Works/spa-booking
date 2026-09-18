import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { BusinessRuleError, ConflictError, NotFoundError } from '../../../common/errors';
import { getTenantId, runInTenantScope, runWithTenant } from '../../../common/tenant';
import { AuthService, REFRESH_ROTATION_GRACE_MS } from '../auth.service';
import { IdentityEvents } from '../events/identity-events';
import type { PasswordResetRequestedEvent } from '../events/password-reset-requested.event';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInvitationError,
  InvalidPasswordResetTokenError,
  InvalidRefreshTokenError,
} from '../identity.errors';
import { PasswordHasher } from '../password.hasher';
import { hashJti, PASSWORD_RESET_COOLDOWN_MS, TokenService } from '../token.service';
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
  let events: IdentityEvents;
  /**
   * Ce que le bus a publié pendant le cas en cours — la seule façon d'observer
   * que la chaîne d'envoi a été sollicitée, `AuthService` ne rendant rien sur la
   * demande de réinitialisation.
   */
  let emitted: PasswordResetRequestedEvent[];

  beforeEach(() => {
    const config = fakeConfig();
    repository = new FakeIdentityRepository();
    tenantId = repository.addTenant(SLUG);
    tokens = new TokenService(new JwtService(), config);
    events = new IdentityEvents(silentLogger());
    emitted = [];
    events.onPasswordResetRequested((event) => {
      emitted.push(event);
    });
    service = new AuthService(
      repository.asRepository(),
      new PasswordHasher(config),
      tokens,
      silentLogger(),
      events,
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
          dataConsent: true,
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
          dataConsent: true,
        }),
      );

      const stored = repository.users[0];
      expect(stored).toBeDefined();
      expect(stored?.passwordHash).not.toBe(PASSWORD);
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('date le consentement sur l’horloge du serveur, et ne le rend à personne', async () => {
      const avant = Date.now();

      const result = await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
          dataConsent: true,
        }),
      );

      const apres = Date.now();
      const preuve = repository.users[0]?.dataConsentAt;

      // Datée, et datée *maintenant* : rien dans la demande ne portait de date,
      // et c'est ce qui donne sa valeur à la preuve (RGPD art. 7.1).
      expect(preuve).toBeInstanceOf(Date);
      expect(preuve?.getTime()).toBeGreaterThanOrEqual(avant);
      expect(preuve?.getTime()).toBeLessThanOrEqual(apres);

      // Et elle ne ressort pas par la session : c'est une donnée de registre,
      // du côté de l'établissement. `USER_SELECT` ne la lit même pas.
      expect(JSON.stringify(result)).not.toContain('dataConsent');
    });

    it('refuse une inscription dont l’accord est absent, sans écrire de ligne', async () => {
      const error = await inRequest(() =>
        service
          .register({
            tenantSlug: SLUG,
            email: 'alice@example.test',
            password: PASSWORD,
            firstName: 'Alice',
            lastName: 'Durand',
            dataConsent: false,
          })
          .catch((caught: unknown) => caught),
      );

      expect(error).toBeInstanceOf(BusinessRuleError);
      // Rien en base : le refus précède la résolution du tenant comme
      // l'écriture, et un compte à moitié créé serait le pire des deux mondes.
      expect(repository.users).toHaveLength(0);
    });

    it('force le rôle CLIENT — une inscription publique ne fabrique pas d’administrateur', async () => {
      await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
          dataConsent: true,
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
          dataConsent: true,
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
            dataConsent: true,
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
            dataConsent: true,
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
          dataConsent: true,
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
            dataConsent: true,
          }),
        ),
      ).resolves.toBeDefined();

      expect(repository.users).toHaveLength(2);
    });

    /**
     * Le téléphone en E.164 — #824.
     *
     * L'inscription est la porte par laquelle la cliente saisit elle-même son
     * numéro, au format qu'elle a sous les yeux : « 06 12 34 56 78 ». C'est le
     * cas de la capture du ticket, et c'est celui qui doit passer.
     */
    it('complète un numéro national avec le pays de l’établissement', async () => {
      repository.addTenant(SLUG, tenantId, { countryCode: 'FR' });

      const result = await inRequest(() =>
        service.register({
          tenantSlug: SLUG,
          email: 'alice@example.test',
          password: PASSWORD,
          firstName: 'Alice',
          lastName: 'Durand',
          phone: '06 12 34 56 78',
          dataConsent: true,
        }),
      );

      expect(result.user.phone).toBe('+33612345678');
      expect(repository.users[0]?.phone).toBe('+33612345678');
    });

    it('refuse un numéro invalide en 400 nommant le champ, sans créer le compte', async () => {
      repository.addTenant(SLUG, tenantId, { countryCode: 'FR' });

      const failure = await rejectionOf(
        inRequest(() =>
          service.register({
            tenantSlug: SLUG,
            email: 'alice@example.test',
            password: PASSWORD,
            firstName: 'Alice',
            lastName: 'Durand',
            phone: '06 12 34',
            dataConsent: true,
          }),
        ),
      );

      expect(failure).toBeInstanceOf(BadRequestException);
      const response = (failure as BadRequestException).getResponse() as { message: unknown };
      expect(response.message).toEqual([expect.stringMatching(/^phone : /)]);
      // Aucun compte, et surtout : le refus est tombé **avant** l'empreinte
      // argon2id, qui coûte une centaine de millisecondes.
      expect(repository.users).toHaveLength(0);
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

    /** Recule la dernière rotation au-delà du délai de grâce. */
    const ageLastRotation = (): void => {
      for (const session of repository.sessions) {
        if (session.rotatedAt !== null) {
          session.rotatedAt = new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 1_000);
        }
      }
    };

    it('révoque toute la session au réemploi d’un jeton déjà consommé', async () => {
      const first = await openSession();
      await inRequest(() => service.refresh(first));
      ageLastRotation();

      // Le jeton d'origine ressort, passé le délai de grâce : soit un vol, soit
      // un rejeu. On ne sait pas lequel des deux porteurs est légitime, donc
      // aucun ne garde la main.
      await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );

      expect(repository.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('n’éteint que la session réemployée — l’autre appareil reste connecté', async () => {
      // #862 : la rotation est écrite avant que le navigateur ait reçu le
      // cookie. Onglet fermé, rechargement en plein vol, navigation annulée —
      // la réponse se perd, le poste garde l'ancien jeton, et le représente
      // bien après le délai de grâce. Rien ne distingue ce cookie perdu d'un
      // cookie volé : la session tombe. Le téléphone, lui, n'a jamais porté ce
      // jeton et n'a aucune raison de tomber avec elle.
      const poste = await openSession();
      const telephone = await inRequest(() =>
        service.login({ tenantSlug: SLUG, email: 'alice@example.test', password: PASSWORD }),
      );

      await inRequest(() => service.refresh(poste));
      ageLastRotation();

      await expect(inRequest(() => service.refresh(poste))).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );

      const [sessionDuPoste, sessionDuTelephone] = repository.sessions;
      expect(sessionDuPoste?.revokedAt).toBeInstanceOf(Date);
      expect(sessionDuTelephone?.revokedAt).toBeNull();

      // Et le second appareil renouvelle encore, sans rien avoir à ressaisir.
      const suite = await inRequest(() => service.refresh(telephone.refreshToken));
      expect(suite.refreshToken).not.toBeNull();
    });

    describe('renouvellements concurrents — #856', () => {
      it('garde trace de l’empreinte remplacée et de l’instant de la rotation', async () => {
        const first = await openSession();
        // L'estampillage de la connexion n'est pas une rotation : rien à retenir.
        expect(repository.sessions[0]?.previousTokenHash).toBeNull();
        expect(repository.sessions[0]?.rotatedAt).toBeNull();

        await inRequest(() => service.refresh(first));

        expect(repository.sessions[0]?.previousTokenHash).toBe(
          hashJti((await tokens.verifyRefreshToken(first)).jti),
        );
        expect(repository.sessions[0]?.rotatedAt).toBeInstanceOf(Date);
      });

      it('rend un jeton d’accès seul au jeton tout juste remplacé, sans rien révoquer', async () => {
        const first = await openSession();
        const winner = await inRequest(() => service.refresh(first));
        const stored = repository.sessions[0]?.tokenHash;

        // Le perdant lit après le commit du gagnant : son empreinte est devenue
        // la précédente.
        const loser = await inRequest(() => service.refresh(first));

        expect(loser.accessToken).not.toBe('');
        expect(loser.refreshToken).toBeNull();
        // Aucune seconde rotation : le jeton du gagnant reste le bon.
        expect(repository.sessions[0]?.tokenHash).toBe(stored);
        expect(repository.sessions.every((session) => session.revokedAt === null)).toBe(true);

        // Et il renouvelle normalement ensuite.
        expect(winner.refreshToken).not.toBeNull();
        const next = await inRequest(() => service.refresh(winner.refreshToken ?? ''));
        expect(next.refreshToken).not.toBeNull();
      });

      it('rend un jeton d’accès seul au perdant qui a lu avant la rotation', async () => {
        const first = await openSession();
        const presented = hashJti((await tokens.verifyRefreshToken(first)).jti);

        // Le chemin `rotated === false` : entre la lecture et l'écriture, un
        // autre renouvellement fait tourner la ligne.
        const rotate = repository.rotateSession.bind(repository);
        jest.spyOn(repository, 'rotateSession').mockImplementationOnce(async (input) => {
          await rotate({ ...input, nextTokenHash: hashJti('jeton-du-gagnant') });
          return false;
        });

        const loser = await inRequest(() => service.refresh(first));

        expect(loser.refreshToken).toBeNull();
        expect(loser.accessToken).not.toBe('');
        expect(repository.sessions[0]?.previousTokenHash).toBe(presented);
        expect(repository.sessions[0]?.tokenHash).toBe(hashJti('jeton-du-gagnant'));
        expect(repository.sessions.every((session) => session.revokedAt === null)).toBe(true);
      });

      it('refuse le perdant quand la session a été éteinte pendant la course', async () => {
        const first = await openSession();
        const sessionId = repository.sessions[0]?.id ?? '';

        jest.spyOn(repository, 'rotateSession').mockImplementationOnce(async () => {
          await repository.revokeSession(sessionId);
          return false;
        });

        await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
          InvalidRefreshTokenError,
        );
      });

      it('laisse la session ouverte quand deux renouvellements partent ensemble', async () => {
        const first = await openSession();

        const results = await Promise.all([
          inRequest(() => service.refresh(first)),
          inRequest(() => service.refresh(first)),
        ]);

        // Un seul a fait tourner la session ; l'autre n'a qu'un jeton d'accès.
        const rotated = results.filter((result) => result.refreshToken !== null);
        expect(rotated).toHaveLength(1);
        expect(results.every((result) => result.accessToken !== '')).toBe(true);
        expect(repository.sessions.every((session) => session.revokedAt === null)).toBe(true);

        // Le cookie final — celui du gagnant — renouvelle encore.
        const next = await inRequest(() => service.refresh(rotated[0]?.refreshToken ?? ''));
        expect(next.refreshToken).not.toBeNull();
      });

      it('révoque un jeton plus ancien que le précédent, même dans le délai', async () => {
        const first = await openSession();
        const second = await inRequest(() => service.refresh(first));
        await inRequest(() => service.refresh(second.refreshToken ?? ''));

        // `first` a été remplacé il y a quelques millisecondes, mais il n'est
        // plus l'empreinte **précédente** : c'est un réemploi.
        await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
          InvalidRefreshTokenError,
        );
        expect(repository.sessions.every((session) => session.revokedAt !== null)).toBe(true);
      });

      it('ne rend rien au jeton tout juste remplacé d’un compte désactivé', async () => {
        const first = await openSession();
        await inRequest(() => service.refresh(first));
        const user = repository.users[0];
        if (user !== undefined) {
          user.isActive = false;
        }

        await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
          InvalidRefreshTokenError,
        );
        expect(repository.sessions[0]?.revokedAt).toBeInstanceOf(Date);
      });

      it('borne le délai dans les deux sens — une horloge aberrante n’ouvre rien', async () => {
        const first = await openSession();
        await inRequest(() => service.refresh(first));
        const session = repository.sessions[0];
        if (session !== undefined) {
          session.rotatedAt = new Date(Date.now() + REFRESH_ROTATION_GRACE_MS + 60_000);
        }

        await expect(inRequest(() => service.refresh(first))).rejects.toBeInstanceOf(
          InvalidRefreshTokenError,
        );
        expect(repository.sessions.every((candidate) => candidate.revokedAt !== null)).toBe(true);
      });
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

  /**
   * Réinitialisation d'un mot de passe oublié — #809.
   *
   * Les cinq cas du cinquième critère d'acceptation sont ici, et le sixième avec
   * eux. Ce qui est vérifié n'est pas « ça marche » mais, comme partout dans
   * cette suite, **ce que ça refuse et ce que ça ne dit pas en refusant** : la
   * valeur d'une procédure de récupération d'accès tient à ce qu'elle ne
   * transforme pas un formulaire public en annuaire de la clientèle du salon.
   */
  describe('réinitialisation de mot de passe', () => {
    const EMAIL = 'alice@example.test';
    const NEW_PASSWORD = 'nouveau-mot-de-passe-long';

    /** Le compte ordinaire des cas passants — cliente, active, avec un mot de passe. */
    const seedClient = async (): Promise<string> => {
      const user = repository.addUser({
        tenantId,
        email: EMAIL,
        passwordHash: await new PasswordHasher(fakeConfig()).hash(PASSWORD),
      });
      return user.id;
    };

    /**
     * Le jeton que la demande vient d'émettre, lu **sur l'événement** et non
     * rendu par le service.
     *
     * C'est la seule façon de l'obtenir, et c'est voulu : la route ne rend rien
     * (« toujours 202 »), et le jeton n'existe en clair qu'à cet instant — la
     * base n'en garde que l'empreinte. Un test qui irait le chercher ailleurs
     * testerait autre chose que la production.
     */
    const requestAndTakeToken = async (): Promise<string> => {
      await inRequest(() => service.requestPasswordReset({ tenantSlug: SLUG, email: EMAIL }));
      const event = emitted.at(-1);
      if (event === undefined) {
        throw new Error('aucun événement de réinitialisation publié');
      }
      return event.token;
    };

    it('arme un jeton haché et publie le lien, sans jamais rendre le jeton', async () => {
      const userId = await seedClient();

      await inRequest(() => service.requestPasswordReset({ tenantSlug: SLUG, email: EMAIL }));

      const stored = repository.users.find((user) => user.id === userId);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.userId).toBe(userId);
      // Ce qui est **stocké** est l'empreinte, jamais le jeton : c'est le
      // deuxième critère, et c'est ce qui rend une fuite de la table sans effet.
      expect(stored?.passwordResetTokenHash).toBe(hashJti(decodeJti(emitted[0]?.token ?? '')));
      expect(stored?.passwordResetTokenHash).not.toBe(emitted[0]?.token);
      // L'échéance est à trente minutes, et c'est la base qui la porte — pas
      // seulement l'`exp` du porteur.
      const ttlMs = (stored?.passwordResetExpiresAt?.getTime() ?? 0) - Date.now();
      expect(ttlMs).toBeGreaterThan(29 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(30 * 60_000);
    });

    it('répond la même chose sur une adresse inconnue que sur une adresse connue', async () => {
      // Le quatrième cas du cinquième critère. Aucun compte n'est semé : la
      // demande porte sur une adresse qui n'existe pas dans ce salon.
      const inconnue = await inRequest(() =>
        service.requestPasswordReset({ tenantSlug: SLUG, email: 'personne@example.test' }),
      );

      await seedClient();
      const connue = await inRequest(() =>
        service.requestPasswordReset({ tenantSlug: SLUG, email: EMAIL }),
      );

      // Les deux rendent `undefined` — la route en fait un 202 dans les deux
      // cas. Si l'une des deux levait, le contrôleur rendrait un statut
      // différent, et le formulaire dirait quelles adresses ont un compte.
      expect(inconnue).toBeUndefined();
      expect(connue).toBeUndefined();
      // Et seule l'adresse connue a produit un message : c'est la réponse qui
      // est indistincte, pas l'effet.
      expect(emitted).toHaveLength(1);
    });

    it('n’envoie rien à un compte suspendu, ni à un compte sans mot de passe', async () => {
      // Sixième critère, moitié « compte suspendu ». Le compte sans mot de passe
      // relève de l'invitation (#55) et non de la réinitialisation : lui servir
      // un jeton aurait ouvert un second chemin d'activation.
      repository.addUser({
        tenantId,
        email: 'suspendue@example.test',
        passwordHash: 'peu-importe',
        isActive: false,
      });
      repository.addUser({ tenantId, email: 'invitee@example.test', passwordHash: null });

      await inRequest(() =>
        service.requestPasswordReset({ tenantSlug: SLUG, email: 'suspendue@example.test' }),
      );
      await inRequest(() =>
        service.requestPasswordReset({ tenantSlug: SLUG, email: 'invitee@example.test' }),
      );

      expect(emitted).toHaveLength(0);
    });

    it('traite un établissement désactivé comme un établissement inexistant', async () => {
      // Sixième critère, moitié « établissement désactivé » (voir #407). Le
      // refus est celui d'un slug inconnu : distinguer les deux dirait à un
      // visiteur qu'un salon a fermé, et lequel.
      const fermeId = repository.addTenant('salon-ferme', randomUUID(), { isActive: false });
      repository.addUser({ tenantId: fermeId, email: EMAIL, passwordHash: 'peu-importe' });

      const error = await rejectionOf(
        inRequest(() =>
          service.requestPasswordReset({ tenantSlug: 'salon-ferme', email: EMAIL }),
        ),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(emitted).toHaveLength(0);
    });

    it('n’émet pas un second message quand la demande est trop rapprochée', async () => {
      await seedClient();

      await inRequest(() => service.requestPasswordReset({ tenantSlug: SLUG, email: EMAIL }));
      await inRequest(() => service.requestPasswordReset({ tenantSlug: SLUG, email: EMAIL }));

      // La moitié « par adresse » de la limite de débit du premier critère. Elle
      // est en base — donc partagée par toutes les tâches —, et son refus est
      // invisible : la seconde demande rend quand même 202.
      expect(emitted).toHaveLength(1);
    });

    it('pose le mot de passe, consomme le jeton et révoque toutes les sessions', async () => {
      const userId = await seedClient();
      // Deux sessions ouvertes ailleurs — c'est ce que le troisième critère
      // demande de couper.
      await inRequest(() => service.login({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD }));
      await inRequest(() => service.login({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD }));
      const token = await requestAndTakeToken();

      await inRequest(() => service.confirmPasswordReset({ token, password: NEW_PASSWORD }));

      const stored = repository.users.find((user) => user.id === userId);
      // Le jeton est consommé dans l'écriture même qui pose le mot de passe.
      expect(stored?.passwordResetTokenHash).toBeNull();
      expect(stored?.passwordResetExpiresAt).toBeNull();
      // Le nouveau mot de passe ouvre la session, l'ancien non.
      await expect(
        inRequest(() => service.login({ tenantSlug: SLUG, email: EMAIL, password: NEW_PASSWORD })),
      ).resolves.toBeDefined();
      // Toutes les sessions antérieures sont éteintes : une réinitialisation est
      // le geste de quelqu'un qui a perdu la main sur son compte.
      expect(
        repository.sessions.filter(
          (session) => session.userId === userId && session.revokedAt === null,
        ),
      ).toHaveLength(1);
    });

    it('refuse de rejouer un jeton déjà consommé', async () => {
      // Deuxième cas du cinquième critère.
      await seedClient();
      const token = await requestAndTakeToken();
      await inRequest(() => service.confirmPasswordReset({ token, password: NEW_PASSWORD }));

      const error = await rejectionOf(
        inRequest(() => service.confirmPasswordReset({ token, password: 'encore-un-autre-mdp' })),
      );

      expect(error).toBeInstanceOf(InvalidPasswordResetTokenError);
      expect((error as InvalidPasswordResetTokenError).status).toBe(401);
    });

    it('refuse un jeton qu’une demande plus récente a remplacé', async () => {
      await seedClient();
      const premier = await requestAndTakeToken();
      // La limite de débit ne doit pas empêcher ce scénario : on recule la
      // dernière demande au-delà du délai, comme l'aurait fait le temps.
      const stored = repository.users.find((user) => user.email === EMAIL);
      if (stored !== undefined) {
        stored.passwordResetRequestedAt = new Date(Date.now() - PASSWORD_RESET_COOLDOWN_MS - 1);
      }
      const second = await requestAndTakeToken();

      const error = await rejectionOf(
        inRequest(() => service.confirmPasswordReset({ token: premier, password: NEW_PASSWORD })),
      );

      // L'émission d'un nouveau jeton invalide l'ancien — deuxième critère. Le
      // second, lui, ouvre bien le compte.
      expect(error).toBeInstanceOf(InvalidPasswordResetTokenError);
      await expect(
        inRequest(() => service.confirmPasswordReset({ token: second, password: NEW_PASSWORD })),
      ).resolves.toBeUndefined();
    });

    it('refuse un jeton expiré', async () => {
      // Troisième cas du cinquième critère. L'échéance est reculée en base
      // plutôt que dans le jeton : c'est **la base qui tranche**, et c'est
      // précisément cette propriété qu'on veut voir échouer côté base même quand
      // l'`exp` du porteur serait encore bon.
      await seedClient();
      const token = await requestAndTakeToken();
      const stored = repository.users.find((user) => user.email === EMAIL);
      if (stored !== undefined) {
        stored.passwordResetExpiresAt = new Date(Date.now() - 1_000);
      }

      const error = await rejectionOf(
        inRequest(() => service.confirmPasswordReset({ token, password: NEW_PASSWORD })),
      );

      expect(error).toBeInstanceOf(InvalidPasswordResetTokenError);
    });

    it('refuse un jeton du salon A présenté sur le salon B, sans rien révéler', async () => {
      // **Le test d'isolation inter-tenant du cinquième critère.**
      //
      // Le jeton est émis dans le salon A, pour un compte du salon A. La
      // confirmation est ensuite tentée dans une requête déjà bornée au salon B
      // — ce que fait le middleware de résolution publique sur une page du salon
      // B. Le refus doit être **le même** que celui d'un jeton contrefait : rien
      // ne doit apprendre au salon B que ce jeton existe, ni qu'un compte le
      // porte ailleurs.
      await seedClient();
      const token = await requestAndTakeToken();
      const voisinId = repository.addTenant('salon-voisin');

      const croise = await rejectionOf(
        runWithTenant(voisinId, () => service.confirmPasswordReset({ token, password: NEW_PASSWORD })),
      );
      const contrefait = await rejectionOf(
        inRequest(() => service.confirmPasswordReset({ token: 'pas-un-jeton', password: NEW_PASSWORD })),
      );

      // Même classe, même statut, même message : le refus ne distingue pas
      // « ce jeton est d'un autre salon » de « ce jeton n'existe pas »
      // (tenant-isolation §4).
      expect(croise).toBeInstanceOf(InvalidPasswordResetTokenError);
      expect(contrefait).toBeInstanceOf(InvalidPasswordResetTokenError);
      expect((croise as InvalidPasswordResetTokenError).message).toBe(
        (contrefait as InvalidPasswordResetTokenError).message,
      );
      expect((croise as InvalidPasswordResetTokenError).status).toBe(
        (contrefait as InvalidPasswordResetTokenError).status,
      );
      // Et le compte du salon A n'a pas bougé : le jeton est toujours armé, son
      // mot de passe est intact.
      const stored = repository.users.find((user) => user.email === EMAIL);
      expect(stored?.passwordResetTokenHash).not.toBeNull();
      await expect(
        inRequest(() => service.login({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD })),
      ).resolves.toBeDefined();
    });

    it('refuse un jeton d’invitation présenté comme jeton de réinitialisation', async () => {
      // La séparation des clés dérivées, vue depuis l'extérieur. Sans elle, une
      // invitation de sept jours — que tout le personnel reçoit par courrier —
      // aurait servi à poser le mot de passe d'un compte déjà activé.
      const userId = await seedClient();
      const invitation = await tokens.signInvitationToken({ userId, tenantId });

      const error = await rejectionOf(
        inRequest(() =>
          service.confirmPasswordReset({ token: invitation.token, password: NEW_PASSWORD }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidPasswordResetTokenError);
    });
  });
});

/**
 * Le `jti` d'un jeton de réinitialisation, lu sans vérifier sa signature.
 *
 * Réservé aux assertions : la suite a besoin de recalculer l'empreinte que le
 * service a écrite pour la comparer à la colonne, et le `jti` est l'aléa dont
 * elle est tirée. Aucun code de production ne lit un jeton sans le vérifier —
 * c'est `TokenService.verifyPasswordResetToken` qui en a la charge.
 */
function decodeJti(token: string): string {
  const payload = token.split('.')[1] ?? '';
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

  if (decoded === null || typeof decoded !== 'object') {
    throw new Error('charge utile de jeton illisible');
  }

  const jti = (decoded as Record<string, unknown>)['jti'];

  if (typeof jti !== 'string') {
    throw new Error('jeton sans jti');
  }

  return jti;
}
