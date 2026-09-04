import { Injectable } from '@nestjs/common';

import { ConflictError, NotFoundError } from '../../common/errors';
import { getTenantId, setRequestTenantId } from '../../common/tenant';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { normalizeEmail } from './email';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInvitationError,
  InvalidRefreshTokenError,
} from './identity.errors';
import { IdentityRepository, toProfile, type UserRecord } from './identity.repository';
import type { AuthenticationResult, UserProfile } from './identity.types';
import { PasswordHasher } from './password.hasher';
import { isStaffRole } from './roles';
import { hashJti, TokenService } from './token.service';

/**
 * Règles d'authentification. Ne connaît ni `Request`, ni `Response`, ni Prisma
 * (api-module §2) : il est exerçable sans HTTP et sans base.
 *
 * ## D'où vient le tenant, et pourquoi ce n'est pas une entrée utilisateur
 *
 * La connexion est le seul moment où le tenant ne peut pas venir d'un jeton — il
 * n'y en a pas encore. Il vient donc du **slug d'établissement**, comme pour les
 * pages de réservation publiques (tenant-isolation §2) : le slug est résolu contre
 * la table `tenants`, et c'est le résultat de cette résolution — un identifiant
 * lu en base — qui entre dans le contexte. Un slug inconnu est refusé avant
 * d'atteindre la moindre donnée.
 *
 * Ce n'est pas « le client choisit son tenant » : connaître le slug d'un salon
 * n'ouvre rien, il faut encore des identifiants valides *de ce salon*. Ce qui
 * serait une fuite, c'est de laisser un `tenantId` brut traverser depuis le corps
 * de la requête — et aucun chemin de code ne le permet.
 */
@Injectable()
export class AuthService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly passwords: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Renseigne la portée de tenant, ou vérifie qu'elle désigne déjà le même
   * établissement. Renvoie `false` sur désaccord — à l'appelant de choisir la
   * réponse, elle n'est pas la même sur un slug et sur un jeton.
   *
   * Le désaccord n'est pas théorique : dès qu'un second résolveur existera (la
   * résolution publique par slug de #23, par exemple), la portée pourra être
   * déjà remplie en entrant ici. Poursuivre en silence ferait lire et écrire les
   * données de l'établissement de la portée tout en signant des jetons pour
   * l'autre — un compte créé quelque part, un jeton qui le cherche ailleurs.
   */
  private static adoptTenantScope(tenantId: string): boolean {
    const current = getTenantId();
    if (current === undefined) {
      // Le middleware a ouvert une portée vide ; on la renseigne une fois.
      setRequestTenantId(tenantId);
      return true;
    }
    return current === tenantId;
  }

  /**
   * Ouvre la portée de tenant depuis le slug. Toute opération de données qui suit
   * est bornée à cet établissement.
   */
  private async openTenantScope(tenantSlug: string): Promise<string> {
    const tenantId = await this.repository.findTenantIdBySlug(tenantSlug.trim().toLowerCase());
    if (tenantId === null) {
      // 404 et non 403 : un 403 confirmerait qu'un établissement porte ce slug.
      throw new NotFoundError('Établissement introuvable.');
    }

    if (!AuthService.adoptTenantScope(tenantId)) {
      // La requête est déjà bornée à un autre établissement. Même réponse qu'un
      // slug inconnu : elle ne dit rien de plus que « pas ici ».
      throw new NotFoundError('Établissement introuvable.');
    }
    return tenantId;
  }

  /**
   * Inscription d'un **client**.
   *
   * Le rôle est figé à `CLIENT` et n'est pas un paramètre : une inscription
   * publique qui accepterait un rôle laisserait n'importe qui se déclarer `ADMIN`
   * de l'établissement. La création d'un compte staff ou admin relève du
   * back-office, pas de ce point d'entrée.
   */
  public async register(input: {
    tenantSlug: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string | undefined;
  }): Promise<AuthenticationResult> {
    const tenantId = await this.openTenantScope(input.tenantSlug);
    const email = normalizeEmail(input.email);

    const existing = await this.repository.findUserByEmail(email);
    if (existing !== null) {
      throw new EmailAlreadyRegisteredError();
    }

    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.repository.createUser({
      email,
      role: 'CLIENT',
      passwordHash,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      phone: input.phone?.trim() ?? null,
    });

    return this.openSession(tenantId, user);
  }

  /**
   * Connexion — clients, staff et administrateurs par le même point d'entrée.
   *
   * Le rôle est lu sur le compte, jamais demandé : un formulaire qui laisserait
   * choisir « je me connecte en tant qu'admin » n'aurait aucune valeur de
   * sécurité, et trois routes séparées se distingueraient par leurs réponses —
   * un oracle de plus.
   */
  public async login(input: {
    tenantSlug: string;
    email: string;
    password: string;
  }): Promise<AuthenticationResult> {
    const tenantId = await this.openTenantScope(input.tenantSlug);
    const email = normalizeEmail(input.email);

    const user = await this.repository.findUserByEmail(email);

    if (user === null) {
      // Le temps de réponse doit être celui d'un échec de mot de passe, sinon la
      // rapidité de ce chemin dit que l'adresse est inconnue dans ce salon.
      await this.passwords.burnComparableTime(input.password);
      throw new InvalidCredentialsError();
    }

    const matches = await this.passwords.verify(input.password, user.passwordHash);
    if (!matches) {
      throw new InvalidCredentialsError();
    }

    // Contrôlé **après** la vérification du mot de passe : l'inverse dirait, par
    // sa rapidité, qu'un compte existe et qu'il est désactivé.
    if (!user.isActive) {
      throw new InvalidCredentialsError();
    }

    await this.repository.touchLastLogin(user.id);

    return this.openSession(tenantId, user);
  }

  /**
   * Première connexion d'un membre du personnel invité — troisième critère de
   * #55.
   *
   * ## Pourquoi il n'y a pas de `tenantSlug` ici
   *
   * Contrairement à `login` et `register`, l'établissement n'a pas à être
   * demandé : il est une revendication **signée** de l'invitation, comme il l'est
   * du jeton de rafraîchissement. Le réclamer en plus donnerait au client une
   * seconde source pour la même information, donc un désaccord possible à
   * arbitrer — et l'arbitrer serait choisir entre deux établissements sur la foi
   * d'une entrée utilisateur.
   *
   * ## Le déroulé, et l'ordre des refus
   *
   * 1. le jeton est vérifié cryptographiquement — sinon rien de ce qui suit n'a
   *    de sens ;
   * 2. son `tenantId`, désormais une donnée serveur, ouvre la portée ;
   * 3. le compte est relu **dans cette portée** : un `sub` d'un autre
   *    établissement ne s'y trouve pas ;
   * 4. quatre conditions valent refus, et **toutes rendent le même 401** :
   *    compte inconnu, compte désactivé, compte déjà activé, compte qui n'est pas
   *    du personnel. Le point d'entrée n'est pas authentifié — distinguer les cas
   *    dirait à qui présente un jeton ramassé si le compte existe encore, et dans
   *    quel état ;
   * 5. l'écriture elle-même est conditionnée à `password_hash IS NULL`, ce qui
   *    la rend atomique : deux acceptations concurrentes du même jeton se
   *    disputent la ligne, une seule gagne, la perdante reçoit le même 401 que
   *    les autres refus.
   *
   * Le pas 5 est ce qui fait l'**usage unique** de l'invitation sans qu'aucune
   * colonne ne la gage : le jeton reste cryptographiquement valide jusqu'à son
   * expiration, mais il n'ouvre plus rien.
   *
   * ## Pourquoi la session s'ouvre dans la foulée
   *
   * Parce que le critère dit « invitation par e-mail **et première connexion** » :
   * renvoyer la personne vers `/auth/login` juste après lui avoir fait choisir son
   * mot de passe la lui ferait ressaisir, et exigerait du front qu'il connaisse le
   * slug de l'établissement — que l'invitation, elle, porte déjà.
   */
  public async acceptInvitation(input: {
    token: string;
    password: string;
  }): Promise<AuthenticationResult> {
    const claims = await this.tokens.verifyInvitationToken(input.token);

    if (!AuthService.adoptTenantScope(claims.tenantId)) {
      // La requête est déjà bornée à un autre établissement : le jeton n'est pas
      // celui de cette requête, et il est hors de question de choisir l'un des
      // deux.
      throw new InvalidInvitationError();
    }

    const user = await this.repository.findUserById(claims.sub);
    if (user === null || !user.isActive || user.passwordHash !== null || !isStaffRole(user.role)) {
      // Un seul refus pour quatre causes — voir `InvalidInvitationError`.
      throw new InvalidInvitationError();
    }

    const passwordHash = await this.passwords.hash(input.password);
    const accepted = await this.repository.setInitialPassword({
      userId: user.id,
      passwordHash,
    });
    if (!accepted) {
      // Une autre acceptation a gagné la course, ou le compte a disparu entre la
      // lecture et l'écriture. Même réponse que tous les autres refus.
      throw new InvalidInvitationError();
    }

    await this.repository.touchLastLogin(user.id);

    // L'empreinte fraîchement posée est recopiée dans l'enregistrement en
    // mémoire : `openSession` n'en fait rien, mais rendre un `UserRecord` qui se
    // dit encore sans mot de passe serait faux pour le prochain lecteur.
    return this.openSession(claims.tenantId, { ...user, passwordHash });
  }

  /**
   * Rotation du jeton de rafraîchissement, avec détection de réemploi.
   *
   * Le déroulé, dans cet ordre précis :
   *
   * 1. le jeton est vérifié cryptographiquement — sinon rien de ce qui suit n'a
   *    de sens ;
   * 2. son `tenantId`, désormais une donnée signée, ouvre la portée ;
   * 3. la session est relue **dans cette portée** : un `sid` d'un autre
   *    établissement ne se trouve pas ;
   * 4. l'empreinte présentée est comparée à l'empreinte courante. Si elle diffère,
   *    c'est qu'un jeton déjà consommé ressort : toutes les sessions du compte
   *    sont éteintes ;
   * 5. la rotation elle-même est conditionnée à l'empreinte attendue, ce qui la
   *    rend atomique face à deux rafraîchissements concurrents.
   */
  public async refresh(refreshToken: string): Promise<AuthenticationResult> {
    const claims = await this.tokens.verifyRefreshToken(refreshToken);

    // Le tenant vient d'une revendication signée : c'est une donnée serveur. Si
    // la portée désigne déjà un autre établissement, le jeton n'est pas celui de
    // cette requête — et il est hors de question de choisir l'un des deux.
    if (!AuthService.adoptTenantScope(claims.tenantId)) {
      throw new InvalidRefreshTokenError();
    }

    const session = await this.repository.findSessionById(claims.sid);
    if (session === null || session.userId !== claims.sub) {
      throw new InvalidRefreshTokenError();
    }

    if (session.revokedAt !== null) {
      // Une session éteinte dont on présente encore un jeton : soit une
      // déconnexion suivie d'un rejeu, soit un vol. Dans les deux cas, il n'y a
      // rien à rouvrir.
      throw new InvalidRefreshTokenError();
    }

    // La base tranche, pas l'`exp` du porteur : les deux devraient coïncider, et
    // c'est justement pour cela qu'on ne se fie pas au second seul.
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new InvalidRefreshTokenError();
    }

    if (session.tokenHash !== hashJti(claims.jti)) {
      await this.repository.revokeAllSessionsOfUser(session.userId);
      this.logger.warn(
        'Réemploi d’un jeton de rafraîchissement détecté : toutes les sessions du compte sont révoquées.',
        { sessionId: session.id },
        AuthService.name,
      );
      throw new InvalidRefreshTokenError();
    }

    const user = await this.repository.findUserById(session.userId);
    if (user === null || !user.isActive) {
      await this.repository.revokeSession(session.id);
      throw new InvalidRefreshTokenError();
    }

    const issued = await this.tokens.signRefreshToken({
      userId: user.id,
      tenantId: claims.tenantId,
      sessionId: session.id,
    });

    const rotated = await this.repository.rotateSession({
      sessionId: session.id,
      expectedTokenHash: session.tokenHash,
      nextTokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
    });

    if (!rotated) {
      // Un autre rafraîchissement a gagné la course. On ne rejoue pas : le jeton
      // qu'on aurait rendu ne correspondrait plus à l'empreinte en base.
      throw new InvalidRefreshTokenError();
    }

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      tenantId: claims.tenantId,
      role: user.role,
    });

    return {
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: toProfile(user),
      refreshToken: issued.token,
      refreshTokenMaxAge: this.tokens.refreshTokenTtlSeconds,
    };
  }

  /**
   * Déconnexion — **c'est la ligne en base qui s'éteint**, pas seulement le
   * cookie qui s'efface. Un jeton signé reste valable jusqu'à son expiration :
   * sans révocation, « se déconnecter » se réduirait à effacer un cookie que
   * l'attaquant qui l'a volé n'effacera pas.
   *
   * Ne lève jamais. Une déconnexion présentant un jeton illisible, expiré ou déjà
   * révoqué a déjà le résultat voulu — l'échouer n'apprendrait au client que ce
   * qu'il ne doit pas savoir, et empêcherait le front d'effacer son état.
   */
  public async logout(refreshToken: string | null): Promise<void> {
    if (refreshToken === null) {
      return;
    }

    let claims;
    try {
      claims = await this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      return;
    }

    try {
      if (!AuthService.adoptTenantScope(claims.tenantId)) {
        // La portée est celle d'un autre établissement : on ne va pas y chercher
        // une session. Le cookie sera effacé par le contrôleur, comme toujours.
        return;
      }
      const session = await this.repository.findSessionById(claims.sid);
      // La session est relue dans la portée du tenant du jeton : un `sid` d'un
      // autre établissement ne s'y trouve pas, et la révocation ne peut donc pas
      // éteindre la session d'autrui.
      if (session !== null && session.userId === claims.sub) {
        await this.repository.revokeSession(session.id);
      }
    } catch (error: unknown) {
      // Une base indisponible ne doit pas empêcher le front d'effacer son état.
      this.logger.warn(
        'Déconnexion : la session n’a pas pu être révoquée.',
        { reason: error instanceof Error ? error.name : 'inconnue' },
        AuthService.name,
      );
    }
  }

  /** Le profil du compte porté par le jeton d'accès vérifié. */
  public async profileOf(userId: string): Promise<UserProfile> {
    const user = await this.repository.findUserById(userId);
    if (user === null) {
      throw new NotFoundError('Compte introuvable.');
    }
    return toProfile(user);
  }

  /** Ouvre une session neuve : ligne en base, puis les deux jetons. */
  private async openSession(tenantId: string, user: UserRecord): Promise<AuthenticationResult> {
    // La ligne est créée avec une empreinte de remplissage, puis mise à jour avec
    // l'empreinte réelle : le `jti` ne peut pas être tiré avant de connaître le
    // `sid`, puisqu'il est signé *avec* lui. Les deux écritures sont dans la même
    // requête HTTP, et la ligne intermédiaire ne correspond à aucun jeton émis —
    // elle n'ouvre donc rien.
    const placeholder = hashJti(`placeholder:${user.id}:${Date.now()}:${Math.random()}`);
    const session = await this.repository.createSession({
      userId: user.id,
      tokenHash: placeholder,
      expiresAt: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds * 1000),
    });

    const issued = await this.tokens.signRefreshToken({
      userId: user.id,
      tenantId,
      sessionId: session.id,
    });

    const stamped = await this.repository.rotateSession({
      sessionId: session.id,
      expectedTokenHash: placeholder,
      nextTokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
    });

    if (!stamped) {
      // La ligne a disparu ou a été révoquée entre sa création et son
      // estampillage — une révocation globale du compte, déclenchée sur un autre
      // appareil, passe exactement là. Rendre le jeton quand même donnerait au
      // porteur une empreinte qui ne correspond à rien : son premier
      // rafraîchissement serait pris pour un réemploi et éteindrait *toutes* ses
      // sessions. Mieux vaut échouer ici, où il ne reste qu'à se reconnecter.
      this.logger.warn(
        'Ouverture de session : la ligne n’a pas pu être estampillée, aucun jeton n’est rendu.',
        { sessionId: session.id },
        AuthService.name,
      );
      throw new ConflictError('La session n’a pas pu être ouverte. Réessayez.');
    }

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      tenantId,
      role: user.role,
    });

    return {
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: toProfile(user),
      refreshToken: issued.token,
      refreshTokenMaxAge: this.tokens.refreshTokenTtlSeconds,
    };
  }
}
