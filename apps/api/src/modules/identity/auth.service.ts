import { Injectable } from '@nestjs/common';

import { BusinessRuleError, ConflictError, NotFoundError } from '../../common/errors';
import { getTenantId, setRequestTenantId } from '../../common/tenant';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { normalizeEmail } from './email';
import { IdentityEvents } from './events/identity-events';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidInvitationError,
  InvalidPasswordResetTokenError,
  InvalidRefreshTokenError,
} from './identity.errors';
import {
  IdentityRepository,
  toProfile,
  type SessionRecord,
  type UserRecord,
} from './identity.repository';
import type { AuthenticationResult, RefreshResult, UserProfile } from './identity.types';
import { PasswordHasher } from './password.hasher';
import { toE164OrNull } from './phone';
import { isStaffRole } from './roles';
import { hashJti, PASSWORD_RESET_COOLDOWN_MS, TokenService } from './token.service';

/**
 * Le délai pendant lequel un jeton de rafraîchissement **tout juste remplacé**
 * reste reconnu comme tel — dix secondes (#856).
 *
 * Deux renouvellements partis ensemble avec le même cookie — deux onglets
 * rechargés, un double clic, l'effet rejoué par `reactStrictMode` — arrivent à
 * l'API à quelques millisecondes d'écart, parfois quelques centaines quand le
 * serveur Next est chargé. Sans délai, le second passait pour un réemploi et
 * fermait toutes les sessions du compte.
 *
 * Court et borné, parce que c'est une fenêtre pendant laquelle un jeton déjà
 * consommé obtient encore un jeton d'accès : dix secondes couvrent largement une
 * course réelle, et laissent entière la détection d'un jeton qui ressortirait
 * plus tard.
 */
export const REFRESH_ROTATION_GRACE_MS = 10_000;

/**
 * Le `sub` du jeton qu'une demande de réinitialisation **jette**, et
 * l'identifiant de la lecture qu'elle jette avec — #809, #1034.
 *
 * Il ne désigne aucun compte, et c'est tout son objet : quand l'adresse demandée
 * n'a pas de compte joignable, la signature et la lecture d'état ont quand même
 * lieu, pour rapprocher le temps de réponse des deux chemins. C'est la même
 * intention que `PasswordHasher.burnComparableTime` sur la connexion.
 *
 * Un UUID nul plutôt qu'un aléa : la valeur ne doit rien apprendre non plus.
 * Deux demandes sur deux adresses inconnues produisent ainsi des jetons qui ne
 * diffèrent que par leur `jti`, comme deux demandes légitimes. Le jeton produit
 * n'est jamais rendu, jamais émis, jamais écrit — il est signé et perdu ; l'état
 * lu est toujours `null` — un compte dont l'identifiant est nul n'existe dans
 * aucun établissement — et il est lu puis jeté.
 *
 * ## Ce que cette égalisation garantit, et ce qu'elle ne garantit pas
 *
 * Elle **garantit** que les deux chemins font le même travail cryptographique
 * (une signature HMAC) et le même nombre d'allers-retours en base en **lecture**
 * (deux : le compte, puis son état de réinitialisation). Sans elle, le chemin
 * stérile en faisait un seul et ne signait rien : deux différences mesurables,
 * dont l'une — une allée-retour réseau vers PostgreSQL — se compte en
 * millisecondes, là où un HMAC-SHA256 sur quelques dizaines d'octets se compte
 * en microsecondes.
 *
 * Elle **ne garantit pas** un temps de réponse constant, et le dire autrement
 * serait faux (#1034). Ce qui reste observable est l'**écriture** d'un armement
 * réussi — une allée-retour de plus, sur le seul chemin qui aboutit. Ce qui la
 * borne n'est pas cette constante mais la limite de débit par adresse : une
 * adresse ne peut armer qu'une fois par `PASSWORD_RESET_COOLDOWN_MS`, si bien
 * que de la deuxième sonde à la N-ième — et il en faut beaucoup pour battre la
 * gigue du réseau — une adresse connue coûte exactement ce que coûte une adresse
 * inconnue : deux lectures, une signature, aucune écriture.
 *
 * Fermer complètement l'écart demanderait soit une écriture factice sur chaque
 * demande, y compris sur une adresse inconnue — un vecteur de charge sur une
 * route publique —, soit une réponse rendue après un délai constant borné, qui
 * change la latence annoncée de la route. Les deux ont été écartés ici ; le jour
 * où l'énumération au chronomètre devient un risque tenu pour réel, c'est parmi
 * ces deux-là qu'il faut choisir.
 */
const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000000';

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
    /**
     * Le bus du module — le seul point par lequel `identity` annonce un fait à
     * qui voudra l'entendre (#809).
     *
     * Ce service ne sait rien de la chaîne de notifications, et c'est la
     * condition pour que `notifications` puisse continuer d'importer
     * `IdentityModule` : la dépendance inverse formerait un cycle que Nest
     * refuse au démarrage. Voir `events/password-reset-requested.event.ts`.
     */
    private readonly events: IdentityEvents,
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
   * Le numéro tel qu'il entre en base — E.164, ou `null` (#824).
   *
   * Le pays de l'établissement n'est lu **que** si un numéro est fourni : la
   * grande majorité des inscriptions n'en portent pas, et une requête de plus sur
   * chacune ne servirait à compléter rien.
   *
   * La portée est déjà ouverte quand on arrive ici — `openTenantScope` a posé le
   * tenant dans le contexte de requête —, si bien que cette lecture est bornée
   * par l'extension de scoping comme n'importe quelle autre.
   */
  private async toE164(phone: string | undefined): Promise<string | null> {
    if (phone === undefined || phone.trim() === '') {
      return null;
    }

    return toE164OrNull('phone', phone, await this.repository.findCurrentTenantCountryCode());
  }

  /**
   * Inscription d'un **client**.
   *
   * Le rôle est figé à `CLIENT` et n'est pas un paramètre : une inscription
   * publique qui accepterait un rôle laisserait n'importe qui se déclarer `ADMIN`
   * de l'établissement. La création d'un compte staff ou admin relève du
   * back-office, pas de ce point d'entrée.
   *
   * ## La preuve de consentement est datée ici, et par personne d'autre (#880)
   *
   * `dataConsent` arrive à `true` ou n'arrive pas : le contrat partagé refuse
   * `false` et refuse l'absence, si bien qu'aucun compte ne naît par cette porte
   * sans accord. Ce que ce service ajoute, c'est la **date** : elle est lue sur
   * l'horloge du serveur au moment de l'écriture, jamais reçue de l'appelant.
   * RGPD art. 7.1 met la preuve à la charge du responsable du traitement, et une
   * preuve horodatée par celui qu'elle engage n'en est pas une.
   *
   * Le booléen est quand même reçu plutôt que déduit du fait qu'on est ici : un
   * service qui daterait un consentement sans qu'aucun paramètre ne le porte
   * daterait aussi bien l'absence d'accord, le jour où un second appelant
   * l'invoquerait. Le type est ce qui oblige à le poser.
   */
  public async register(input: {
    tenantSlug: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string | undefined;
    dataConsent: boolean;
  }): Promise<AuthenticationResult> {
    if (!input.dataConsent) {
      // Une seconde barrière derrière celle du contrat, et elle n'est pas
      // redondante : c'est ce service, et non le pipe de validation, qui décide
      // ce qui entre en base. Un futur appelant interne qui l'invoquerait sans
      // passer par `registerBody` se verrait refusé ici plutôt que d'écrire une
      // ligne dont rien ne dirait qu'elle a été consentie.
      //
      // `BusinessRuleError` et non un code d'erreur neuf : le refus que le front
      // traite est celui du contrat, rendu champ par champ par le pipe de
      // validation. Celui-ci ne peut être atteint que par un appelant interne
      // qui aurait contourné le pipe — il n'a donc aucun écran à renseigner, et
      // inventer un code que la clientèle ne verra jamais élargirait la surface
      // du contrat pour rien.
      throw new BusinessRuleError(
        'Le traitement des données doit être accepté pour créer un compte.',
      );
    }

    const tenantId = await this.openTenantScope(input.tenantSlug);
    const email = normalizeEmail(input.email);

    // Avant l'empreinte du mot de passe, qui coûte une centaine de millisecondes
    // d'argon2id : un numéro illisible doit être refusé sans les dépenser.
    const phone = await this.toE164(input.phone);

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
      phone,
      dataConsentAt: new Date(),
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
   * Demande de réinitialisation d'un mot de passe oublié — #809, premier
   * critère.
   *
   * ## Elle ne rend rien, et n'échoue que sur l'établissement
   *
   * « Il répond **toujours 202**, que le compte existe ou non » : ce point
   * d'entrée n'est pas authentifié, et la moindre différence de réponse en
   * ferait un annuaire de la clientèle du salon. Adresse inconnue, compte sans
   * mot de passe, compte désactivé, demande trop rapprochée — les quatre suivent
   * le même chemin, ne produisent rien, et se taisent.
   *
   * La **seule** exception est le slug : un établissement inconnu ou désactivé
   * rend 404, comme pour `login` et `register`. Ce n'est pas une entorse au
   * critère, qui parle de l'existence du **compte** : un slug est une donnée
   * publique — c'est celle de l'URL de réservation — et son 404 n'apprend rien
   * que la page du salon ne dise déjà. Répondre 202 sur un salon qui n'existe
   * pas aurait au contraire promis un courrier que personne n'enverrait jamais.
   * `findTenantIdBySlug` conflue déjà « inconnu » et « désactivé », si bien
   * qu'aucun visiteur n'apprend qu'un salon a fermé — c'est la moitié
   * « établissement désactivé » du sixième critère.
   *
   * ## Le temps de réponse en dit le moins possible — mais pas rien
   *
   * Un compte introuvable ne coûterait, sans précaution, qu'une lecture indexée,
   * là où un compte trouvé paie deux lectures, une signature de jeton et une
   * écriture. L'écart est mesurable depuis l'extérieur, et il rétablirait au
   * chronomètre l'énumération que la réponse uniforme interdit. Les deux chemins
   * passent donc par les **mêmes deux lectures** et la **même signature** : sur
   * le chemin stérile, l'une et l'autre sont **jetées** (voir
   * `PLACEHOLDER_USER_ID`, qui porte le détail de ce que cela garantit).
   *
   * Ce que cela ne fait pas, et qu'il ne faut pas lui prêter (#1034) : rendre le
   * temps de réponse constant. L'écriture d'un armement réussi reste une
   * allée-retour de plus, sur le seul chemin qui aboutit — mais elle n'a lieu
   * qu'une fois par fenêtre de débit et par adresse, si bien qu'à la deuxième
   * sonde une adresse connue coûte déjà ce que coûte une adresse inconnue.
   *
   * ## Un compte sans mot de passe ne reçoit rien
   *
   * `passwordHash === null` désigne un compte jamais activé — une invitation de
   * personnel en attente, ou une fiche cliente saisie au comptoir. Il n'y a rien
   * à réinitialiser : ce qui lui manque est une **première** connexion, et elle
   * a sa propre procédure (`POST /auth/invitations/accept`, #55). Lui servir un
   * jeton de réinitialisation aurait ouvert un second chemin d'activation, sans
   * le contrôle de rôle que l'invitation exerce.
   *
   * ## L'ordre des trois écritures
   *
   * 1. le jeton est signé — rien n'est encore engagé ;
   * 2. l'empreinte est armée en base, ce qui **invalide** le jeton précédent
   *    (deuxième critère) ;
   * 3. l'événement est émis, et l'abonné de `notifications` publie l'enveloppe.
   *
   * L'émission vient en dernier pour la raison qui vaut pour tous les événements
   * de ce dépôt : annoncer un jeton que la base n'a pas accepté enverrait un
   * lien qui ne pourrait rien ouvrir.
   *
   * ## La limite par adresse est tenue **par la base** — #1034
   *
   * La lecture d'état ci-dessous compare l'instant de la demande précédente au
   * délai, mais elle ne décide de rien : deux demandes parties ensemble lisent la
   * même valeur et passent toutes deux. C'est le `where` d'`armPasswordReset` qui
   * tranche — le seuil y est la **condition de l'écriture** —, et la perdante
   * rend `false` sans qu'aucun événement ne parte. Sans cela, deux courriers
   * partaient pour une seule fenêtre, et le lien du premier n'ouvrait rien.
   *
   * La lecture reste parce qu'elle sert à deux choses que l'écriture ne peut pas
   * rendre : distinguer dans le journal une demande trop rapprochée d'un compte
   * disparu, et épargner l'écriture quand le refus est déjà certain. Elle est
   * aussi, sur le chemin stérile, la seconde allée-retour qui égalise les deux
   * chemins — c'est pourquoi elle a lieu même quand il n'y a personne à servir.
   */
  public async requestPasswordReset(input: { tenantSlug: string; email: string }): Promise<void> {
    const tenantId = await this.openTenantScope(input.tenantSlug);
    const email = normalizeEmail(input.email);

    const user = await this.repository.findUserByEmail(email);
    const now = new Date();

    // Signé avant de savoir si on s'en servira : le chemin stérile paie la même
    // signature, et elle est jetée. Le coût est un HMAC de quelques microsecondes
    // sur une route limitée en débit, et la route n'a de toute façon rien d'autre
    // à faire.
    const issued = await this.tokens.signPasswordResetToken({
      userId: user?.id ?? PLACEHOLDER_USER_ID,
      tenantId,
    });

    // La seconde lecture a lieu sur les deux chemins, pour la même raison que la
    // signature : c'est l'allée-retour en base — des millisecondes, là où le HMAC
    // n'en coûte que des microsecondes — qui trahissait l'existence du compte
    // (#1034). Sur le chemin stérile, elle porte l'identifiant nul et rend
    // toujours `null`.
    const state = await this.repository.findPasswordResetState(user?.id ?? PLACEHOLDER_USER_ID);

    if (user === null || !user.isActive || user.passwordHash === null) {
      // Les trois refus qui ne se voient pas. Le journal, lui, les distingue —
      // c'est ce qui permet de répondre au comptoir « cette adresse n'a pas de
      // compte ici » sans que la route l'ait jamais dit.
      this.logger.log(
        'réinitialisation sans destinataire : demande sans effet',
        {
          reason:
            user === null ? 'compte-inconnu' : user.isActive ? 'compte-sans-mot-de-passe' : 'compte-desactive',
        },
        AuthService.name,
      );
      return;
    }

    // Le seuil que la base appliquera, calculé ici : la règle reste dans le
    // service, la décision est à l'écriture.
    const notRequestedSince = new Date(now.getTime() - PASSWORD_RESET_COOLDOWN_MS);

    if (state !== null && AuthService.isWithinResetCooldown(state.passwordResetRequestedAt, now)) {
      // La moitié « par adresse » de la limite de débit, vue depuis la lecture :
      // un raccourci qui épargne l'écriture quand le refus est déjà certain, pas
      // la garantie elle-même — elle est dans le `where` ci-dessous. Silencieuse :
      // un 429 aurait dit que l'adresse existe.
      this.logger.log(
        'réinitialisation trop rapprochée : demande sans effet',
        { userId: user.id },
        AuthService.name,
      );
      return;
    }

    const armed = await this.repository.armPasswordReset({
      userId: user.id,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      requestedAt: now,
      notRequestedSince,
    });

    if (!armed) {
      // Deux causes, indistinguables ici et sans conséquence différente : une
      // demande concurrente a gagné la course — c'est le cas nominal que le
      // `where` est là pour produire (#1034) —, ou le compte a disparu entre la
      // lecture et l'écriture. Rien à envoyer, et rien à dire au demandeur qu'il
      // ne sache déjà : il reçoit 202.
      this.logger.log(
        'réinitialisation non armée : demande concurrente ou compte disparu, aucun message n’est émis',
        { userId: user.id },
        AuthService.name,
      );
      return;
    }

    this.events.passwordResetRequested({ tenantId, userId: user.id, token: issued.token });
  }

  /**
   * `true` si la demande précédente est trop récente pour qu'une nouvelle
   * produise un message — #809, limite de débit par adresse.
   *
   * **Un raccourci, pas la garantie** (#1034) : deux demandes simultanées lisent
   * la même valeur et passent toutes deux ici. Ce qui départage est le `where`
   * d'`armPasswordReset`, où le même seuil est la condition de l'écriture. Ce
   * test-ci épargne l'écriture quand le refus est déjà certain, et permet au
   * journal de nommer la cause.
   *
   * L'écart est pris en valeur absolue, comme celui du délai de grâce de
   * rotation, et pour la même raison : `password_reset_requested_at` est écrit
   * par la tâche qui a servi la demande, et deux tâches ECS n'ont jamais tout à
   * fait la même horloge. Un instant daté d'un léger futur doit compter comme
   * récent — l'ignorer aurait ouvert la porte qu'il est là pour fermer.
   */
  private static isWithinResetCooldown(requestedAt: Date | null, now: Date): boolean {
    if (requestedAt === null) {
      return false;
    }
    return Math.abs(now.getTime() - requestedAt.getTime()) < PASSWORD_RESET_COOLDOWN_MS;
  }

  /**
   * Choix du nouveau mot de passe, jeton en main — #809, troisième critère.
   *
   * ## Le déroulé, et l'ordre des refus
   *
   * 1. le jeton est vérifié cryptographiquement — sinon rien de ce qui suit n'a
   *    de sens ;
   * 2. son `tenantId`, désormais une donnée serveur, ouvre la portée ;
   * 3. l'état du compte est relu **dans cette portée** : un `sub` d'un autre
   *    établissement ne s'y trouve pas. C'est le cinquième critère
   *    d'acceptation, et il est tenu par le scoping plutôt que par une
   *    comparaison — « un jeton émis pour le salon A est refusé sur le salon B,
   *    sans révéler son existence » ;
   * 4. quatre conditions valent refus, et **toutes rendent le même 401** :
   *    compte inconnu dans cette portée, compte désactivé, aucun jeton armé, ou
   *    une empreinte qui n'est pas celle du jeton présenté. Le point d'entrée
   *    n'est pas authentifié — distinguer les cas dirait à qui présente un lien
   *    ramassé si le compte existe encore, et dans quel état ;
   * 5. l'écriture elle-même est conditionnée à l'empreinte attendue **et** à
   *    l'échéance, ce qui la rend atomique : deux confirmations concurrentes du
   *    même lien se disputent la ligne, une seule gagne, la perdante reçoit le
   *    même 401 que les autres refus.
   *
   * Le pas 5 est ce qui fait l'**usage unique** : l'empreinte est effacée dans
   * l'écriture même qui pose le mot de passe. Le jeton reste
   * cryptographiquement valide jusqu'à son expiration, mais il n'ouvre plus
   * rien — exactement le procédé de l'invitation de #55, et de la rotation de
   * session de #21.
   *
   * ## L'usage unique est tenu **par la base**, la comparaison en mémoire n'est
   * qu'un raccourci
   *
   * C'est le `where` de l'écriture qui décide, et lui seul le peut : la
   * comparaison du pas 4 lit une ligne, l'écriture du pas 5 en referme la
   * fenêtre. Les deux ne sont donc pas interchangeables, et le pas 4 ne dispense
   * de rien — il **épargne** le bcrypt du pas intermédiaire sur un jeton dont on
   * sait déjà, à la lecture, qu'il n'ouvrira rien : rejoué, remplacé par une
   * demande plus récente, ou ramassé dans une boîte mail. Sans lui, chaque
   * tentative sur un lien mort coûtait une centaine de millisecondes de CPU sur
   * une route publique dont le quota par IP ne distingue pas les visiteurs.
   *
   * ## Toutes les sessions tombent
   *
   * « Révoque tous les refresh tokens du compte » est le critère, et ce n'est
   * pas une précaution de style : une réinitialisation est le geste de quelqu'un
   * qui a perdu la main sur son compte, ou qui craint de l'avoir perdue. Laisser
   * vivre les sessions ouvertes ailleurs laisserait exactement ce dont on se
   * protège. Contrairement à la détection de réemploi (#862), où la révocation
   * se borne à la session fautive, la portée est ici le **compte entier** : le
   * fait qui la déclenche porte sur le mot de passe, donc sur tout ce qui en
   * dépend.
   *
   * La révocation vient **après** l'écriture du mot de passe, et **dans la même
   * transaction** : révoquer d'abord aurait déconnecté partout quelqu'un dont la
   * confirmation échoue ensuite — un lien mort suffirait à le mettre dehors —, et
   * révoquer dans une seconde écriture indépendante aurait laissé, sur une
   * coupure entre les deux, un mot de passe changé et les sessions d'avant
   * toujours vivantes, sans aucun moyen de rattraper l'écart : le jeton est déjà
   * consommé. C'est `consumePasswordReset` qui porte les deux.
   */
  public async confirmPasswordReset(input: { token: string; password: string }): Promise<void> {
    const claims = await this.tokens.verifyPasswordResetToken(input.token);

    if (!AuthService.adoptTenantScope(claims.tenantId)) {
      // La requête est déjà bornée à un autre établissement : le jeton n'est pas
      // celui de cette requête, et il est hors de question de choisir l'un des
      // deux.
      throw new InvalidPasswordResetTokenError();
    }

    const state = await this.repository.findPasswordResetState(claims.sub);
    const expectedTokenHash = hashJti(claims.jti);

    if (
      state === null ||
      !state.isActive ||
      state.passwordResetTokenHash === null ||
      // Quatrième cause, et elle n'ajoute **aucune** garantie : c'est le `where`
      // de `consumePasswordReset` qui fait l'usage unique, et lui seul le peut.
      // Ce qu'elle épargne est le bcrypt ci-dessous — cent millisecondes de CPU
      // par tentative — sur un jeton dont on sait déjà qu'il n'ouvrira rien :
      // rejoué, remplacé, ou ramassé dans une boîte mail. La route n'est pas
      // authentifiée, et son quota par IP compte l'adresse du serveur Next pour
      // tous les visiteurs (`auth.controller.ts`).
      state.passwordResetTokenHash !== expectedTokenHash
    ) {
      // Un seul refus pour quatre causes — voir `InvalidPasswordResetTokenError`.
      throw new InvalidPasswordResetTokenError();
    }

    const passwordHash = await this.passwords.hash(input.password);

    const consumed = await this.repository.consumePasswordReset({
      userId: claims.sub,
      expectedTokenHash,
      passwordHash,
      now: new Date(),
    });

    if (!consumed) {
      // Le jeton a déjà servi, il a été remplacé par une demande plus récente,
      // ou son échéance est passée entre la lecture et l'écriture. Même réponse
      // que tous les autres refus.
      throw new InvalidPasswordResetTokenError();
    }

    this.logger.log(
      'mot de passe réinitialisé, sessions du compte révoquées',
      { userId: claims.sub },
      AuthService.name,
    );
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
   * 4. l'empreinte présentée est comparée à l'empreinte courante. Si elle diffère
   *    et n'est pas celle que la dernière rotation vient de remplacer, c'est
   *    qu'un jeton déjà consommé ressort : **cette session** est éteinte ;
   * 5. la rotation elle-même est conditionnée à l'empreinte attendue, ce qui la
   *    rend atomique face à deux rafraîchissements concurrents.
   *
   * ## Le perdant d'une course n'est pas un voleur (#856)
   *
   * Deux renouvellements partis ensemble avec le même jeton se disputent la même
   * ligne. Le gagnant la fait tourner ; le perdant la lit soit avant — sa
   * rotation ne trouve alors plus rien à mettre à jour —, soit après — son
   * empreinte est devenue la précédente. Dans les deux cas, et pendant
   * `REFRESH_ROTATION_GRACE_MS` seulement, il reçoit un **jeton d'accès seul** :
   * ni révocation, ni seconde rotation, ni cookie de rafraîchissement.
   *
   * Pourquoi un jeton d'accès, et non un simple refus sans conséquence : le
   * gagnant peut ne jamais rendre son cookie — une navigation annulée par un
   * double clic emporte sa réponse. Un perdant refusé renverrait alors la page
   * vers ce même renouvellement, qui le refuserait encore, en boucle jusqu'à la
   * fin du délai puis jusqu'à la révocation. Avec un jeton d'accès, la page
   * s'affiche, et le prochain renouvellement tranche.
   *
   * ## Ce qu'un réemploi éteint : la session, pas le compte (#862)
   *
   * La révocation porte sur **la session où le réemploi a eu lieu**, et sur elle
   * seule. C'est la portée que prescrit l'OAuth 2.0 Security BCP (RFC 9700
   * §4.14.2) : révoquer « la famille » du jeton, c'est-à-dire la chaîne de
   * rotations issue d'une autorisation — ici la ligne `refresh_tokens`, que
   * chaque rotation met à jour en place. Les sessions des **autres appareils**
   * du même compte n'ont jamais porté ce jeton : les éteindre n'ôte rien à qui
   * l'aurait volé, et déconnecte tout le monde ailleurs.
   *
   * Ce n'est pas une nuance de doctrine, c'est la correction d'un dommage
   * observé. Le délai de grâce ci-dessus est borné, et le déclencheur ne l'est
   * pas : une réponse de renouvellement qui n'arrive jamais au navigateur —
   * onglet fermé, rechargement en plein vol, navigation annulée — laisse le
   * client sur l'ancien jeton alors que la ligne a déjà tourné. Représenté
   * au-delà du délai, il est pris pour un réemploi, et il l'est de bonne foi :
   * le serveur ne peut pas distinguer un cookie perdu d'un cookie volé, les deux
   * porteurs présentant exactement la même empreinte. Ce qu'il peut faire, c'est
   * ne pas punir au-delà de ce que la preuve porte — un incident réseau sur un
   * poste n'a pas à fermer la session ouverte sur un autre.
   *
   * La session concernée, elle, est bien éteinte : entre deux porteurs de la même
   * empreinte, aucun ne garde la main, et le jeton remplacé comme son successeur
   * cessent de valoir quoi que ce soit.
   */
  public async refresh(refreshToken: string): Promise<RefreshResult> {
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

    const presented = hashJti(claims.jti);
    const isCurrent = session.tokenHash === presented;

    if (!isCurrent && !AuthService.isJustReplaced(session, presented)) {
      // La session, et elle seule (#862) : les autres appareils du compte n'ont
      // jamais porté ce jeton. Voir « Ce qu'un réemploi éteint » ci-dessus.
      await this.repository.revokeSession(session.id);
      this.logger.warn(
        'Réemploi d’un jeton de rafraîchissement détecté : la session est révoquée.',
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

    if (!isCurrent) {
      // Le gagnant a déjà fait tourner la session, avant même notre lecture.
      return this.renewAccessOnly(user, claims.tenantId, session.id);
    }

    const issued = await this.tokens.signRefreshToken({
      userId: user.id,
      tenantId: claims.tenantId,
      sessionId: session.id,
    });

    const rotated = await this.repository.rotateSession({
      sessionId: session.id,
      expectedTokenHash: presented,
      nextTokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      rotatedAt: new Date(),
    });

    if (!rotated) {
      // Un autre rafraîchissement a gagné la course entre notre lecture et notre
      // écriture — ou la session vient d'être éteinte. On relit pour savoir
      // lequel : seul le premier cas a droit au délai de grâce. On ne rejoue pas
      // la rotation, le jeton qu'on rendrait écraserait celui du gagnant.
      const after = await this.repository.findSessionById(session.id);
      if (
        after === null ||
        after.revokedAt !== null ||
        !AuthService.isJustReplaced(after, presented)
      ) {
        throw new InvalidRefreshTokenError();
      }
      return this.renewAccessOnly(user, claims.tenantId, session.id);
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
   * `true` si l'empreinte présentée est celle que la dernière rotation vient de
   * remplacer, il y a moins de `REFRESH_ROTATION_GRACE_MS`.
   *
   * L'écart est pris en valeur absolue : `rotated_at` est écrit par la tâche qui
   * a gagné, et deux tâches ECS n'ont jamais tout à fait la même horloge. Une
   * rotation datée d'un léger futur reste dans la fenêtre ; une date aberrante,
   * dans un sens comme dans l'autre, en sort.
   */
  private static isJustReplaced(session: SessionRecord, presentedHash: string): boolean {
    if (session.previousTokenHash !== presentedHash || session.rotatedAt === null) {
      return false;
    }
    return Math.abs(Date.now() - session.rotatedAt.getTime()) <= REFRESH_ROTATION_GRACE_MS;
  }

  /** Le jeton d'accès du perdant d'une course — sans rotation ni cookie. */
  private async renewAccessOnly(
    user: UserRecord,
    tenantId: string,
    sessionId: string,
  ): Promise<RefreshResult> {
    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      tenantId,
      role: user.role,
    });

    this.logger.debug(
      'Renouvellement concurrent absorbé : jeton d’accès émis sans nouvelle rotation.',
      { sessionId },
      AuthService.name,
    );

    return {
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      user: toProfile(user),
      refreshToken: null,
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
      // Un estampillage, pas une rotation : aucun jeton n'a porté l'empreinte
      // de remplissage, aucun n'a donc droit au délai de grâce.
      rotatedAt: null,
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
