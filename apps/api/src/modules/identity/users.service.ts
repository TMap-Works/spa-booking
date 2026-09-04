import { Injectable } from '@nestjs/common';

import { BusinessRuleError, NotFoundError } from '../../common/errors';
import { normalizeEmail } from './email';
import { EmailAlreadyRegisteredError, InvitationAlreadyAcceptedError } from './identity.errors';
import { IdentityRepository, toProfile, type UserRecord } from './identity.repository';
import type {
  AuthenticatedUser,
  StaffAccountState,
  StaffInvitation,
  UserProfile,
} from './identity.types';
import type { StaffRole, UserRole } from './roles';
import { TokenService } from './token.service';

/**
 * Administration des comptes de l'établissement — CDC §1.4 « comptes staff avec
 * rôles et permissions ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture visant un compte d'un autre établissement ne le trouve donc pas —
 * elle rend `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4) : il confirmerait que la ressource
 * existe ailleurs. Ne pas avoir l'information est la meilleure garantie de ne
 * pas la divulguer.
 */
@Injectable()
export class UsersService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly tokens: TokenService,
  ) {}

  /** Les comptes internes de l'établissement courant — jamais la clientèle. */
  public async listStaffAccounts(): Promise<UserProfile[]> {
    return this.repository.listStaffAccounts();
  }

  /**
   * Crée un membre du personnel et émet son invitation — #55.
   *
   * ## Le compte naît sans mot de passe
   *
   * `passwordHash: null`, et c'est la définition même de « invité » : le compte
   * existe, il est listé, il peut recevoir un rôle et des affectations, mais il
   * est **inconnectable** tant que la personne n'a pas choisi son mot de passe.
   * Aucune colonne d'état ne l'exprime — la nullité de l'empreinte suffit, et
   * c'est ce qui permet de livrer l'invitation sans migration.
   *
   * Un administrateur ne choisit donc jamais le mot de passe d'un tiers : ce
   * serait un secret partagé dès sa naissance, et communiqué par un canal que
   * personne ne maîtrise.
   *
   * ## Le rôle est borné au personnel
   *
   * `StaffRole` au type, `@IsIn(STAFF_ROLES)` au DTO. Créer un `CLIENT` par ce
   * point d'entrée n'aurait pas de sens — la clientèle s'inscrit d'elle-même ou
   * relève du module `crm` — et la liste que ce point d'entrée alimente
   * (`listStaffAccounts`) ne la montrerait de toute façon pas : le compte serait
   * créé puis invisible, ce qui est le pire des deux mondes.
   *
   * ## Le contrôle d'unicité, et pourquoi il ne suffit pas
   *
   * Comme à l'inscription : c'est la base qui tranche, par
   * `@@unique([tenantId, email])`, et le repository traduit la violation en 409.
   * La lecture préalable ne sert qu'à rendre le refus lisible dans le cas
   * courant — deux invitations concurrentes sur la même adresse la passent
   * toutes les deux.
   *
   * Une adresse déjà portée par une **cliente** de l'établissement produit ce
   * même 409, et c'est le bon comportement : la faire passer au personnel est un
   * changement de rôle (`PATCH /users/:id/role`), pas une création.
   */
  public async inviteStaffMember(input: {
    tenantId: string;
    email: string;
    role: StaffRole;
    firstName: string;
    lastName: string;
    phone: string | null;
  }): Promise<StaffInvitation> {
    // La normalisation est **la même fonction** que celle de `/auth/login`
    // (`./email`) : une invitation envoyée à `Alice@Lilas.test` créerait sinon
    // une ligne prise que la connexion, qui normalise, ne retrouverait jamais.
    const email = normalizeEmail(input.email);

    const existing = await this.repository.findUserByEmail(email);
    if (existing !== null) {
      throw new EmailAlreadyRegisteredError();
    }

    const user = await this.repository.createUser({
      email,
      role: input.role,
      passwordHash: null,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      phone: input.phone?.trim() ?? null,
    });

    return this.issueInvitation(input.tenantId, user);
  }

  /**
   * Réémet l'invitation d'un compte **jamais activé** — #55.
   *
   * Sans elle, une invitation expirée condamnerait le compte : il n'a pas de mot
   * de passe, aucune procédure de réinitialisation n'existe dans le périmètre
   * MVP, et il n'y aurait plus aucun chemin vers la première connexion. C'est ce
   * qui la rend indissociable du critère « invitation par e-mail et première
   * connexion » plutôt qu'un ajout de confort.
   *
   * Les invitations émises précédemment restent valides — rien en base ne les
   * gage, et il n'y a rien à révoquer. Ce n'est pas un relâchement : elles
   * portent toutes les mêmes revendications, ouvrent le même compte, et meurent
   * **ensemble** à la première acceptée (`setInitialPassword` exige une empreinte
   * encore nulle). Deux liens dans une boîte mail ne valent donc jamais deux
   * activations.
   *
   * `findStaffAccountById` : une fiche cliente n'a pas d'invitation à réémettre,
   * et un identifiant d'un autre établissement ne se trouve pas — 404 dans les
   * deux cas, indistinctement (tenant-isolation §4).
   */
  public async reissueInvitation(input: {
    tenantId: string;
    userId: string;
  }): Promise<StaffInvitation> {
    const user = await this.repository.findStaffAccountById(input.userId);
    if (user === null) {
      throw new NotFoundError('Compte introuvable.');
    }

    if (user.passwordHash !== null) {
      // Dit franchement, contrairement au refus d'`/auth/invitations/accept` :
      // l'appelant est un administrateur de cet établissement, qui a déjà le
      // droit de lire ce compte. Il n'y a rien à lui taire, et « invitation
      // invalide » le laisserait réessayer sans comprendre.
      throw new InvitationAlreadyAcceptedError();
    }

    if (!user.isActive) {
      // `acceptInvitation` refuse un compte désactivé — et le refuse par un 401
      // muet, qui ne dit pas pourquoi. Émettre quand même le jeton rendrait donc
      // un 201 dont le lien ne peut qu'échouer, et l'échec tomberait chez la
      // personne invitée, pas chez l'administrateur qui l'a envoyé. Le refus se
      // dit ici, où il est encore lisible : réactiver d'abord, réinviter ensuite.
      throw new BusinessRuleError(
        'Ce compte est désactivé : le réactiver avant de réémettre son invitation.',
      );
    }

    return this.issueInvitation(input.tenantId, user);
  }

  /**
   * Le jeton d'invitation d'un compte donné, mis en forme pour la réponse.
   *
   * Écrit une fois : les deux points d'entrée doivent rendre exactement la même
   * chose, et un `expiresIn` recopié à deux endroits finirait par diverger de la
   * durée réellement signée.
   *
   * `tenantId` vient d'un jeton d'accès **vérifié**, jamais du chemin ni du corps
   * (tenant-isolation §2). Le compte, lui, a été lu dans la portée de ce même
   * établissement — l'invitation ne peut donc pas désigner un compte d'ailleurs.
   */
  private async issueInvitation(tenantId: string, user: UserRecord): Promise<StaffInvitation> {
    const invitation = await this.tokens.signInvitationToken({ userId: user.id, tenantId });
    return {
      user: toProfile(user),
      invitationToken: invitation.token,
      expiresIn: invitation.expiresIn,
    };
  }

  /**
   * Un **compte interne** de l'établissement courant, par identifiant.
   *
   * Le 404 couvre indistinctement trois situations — « n'existe nulle part »,
   * « existe dans un autre établissement » et « est une fiche cliente » — et
   * c'est exactement ce qu'il faut : la différence entre les deux premières est
   * précisément l'information à ne pas donner, et la troisième relève du module
   * `crm`, pas de l'administration des droits. Le point d'entrée rend ce que la
   * liste rend, ni plus ni moins.
   */
  public async byId(userId: string): Promise<UserProfile> {
    const user = await this.repository.findStaffAccountById(userId);
    if (user === null) {
      throw new NotFoundError('Compte introuvable.');
    }
    return toProfile(user);
  }

  /**
   * Attribue un rôle à un compte de l'établissement courant.
   *
   * `actor` sert à une seule règle, et elle n'est pas une permission : **un
   * compte ne change pas son propre rôle**. Sans elle, l'unique administrateur
   * d'un salon peut se rétrograder d'un clic et laisser l'établissement sans
   * personne pour attribuer des droits — une porte qui se referme de l'intérieur,
   * sans clé. Le contrôle est une règle métier (422), pas un refus de droit
   * (403) : l'appelant *a* le droit, c'est l'opération qui n'a pas de sens.
   *
   * Le rôle visé est déjà borné à l'énumération par le DTO ; le type le redit
   * ici pour que le repository n'ait pas à le supposer.
   */
  public async changeRole(input: {
    actor: AuthenticatedUser;
    userId: string;
    role: UserRole;
  }): Promise<UserProfile> {
    if (input.actor.userId === input.userId) {
      throw new BusinessRuleError('Un compte ne peut pas modifier son propre rôle.');
    }

    // Relu avant écriture pour distinguer « inconnu ici » d'une non-modification :
    // `updateUserRole` rend `false` dans les deux cas, et répondre 404 à une
    // réattribution du rôle déjà porté serait faux.
    //
    // `findUserById` et non `findStaffAccountById` : promouvoir une cliente
    // fidèle en praticienne est la façon normale dont un salon embauche, et la
    // route est déjà réservée aux administrateurs. C'est la **lecture** des
    // fiches clientes qui est refusée ici, pas leur promotion.
    const target = await this.repository.findUserById(input.userId);
    if (target === null) {
      throw new NotFoundError('Compte introuvable.');
    }

    if (target.role !== input.role) {
      const updated = await this.repository.updateUserRole({
        userId: input.userId,
        role: input.role,
      });
      if (!updated) {
        // La ligne a disparu entre la lecture et l'écriture. Même réponse que si
        // elle n'avait jamais été là : c'est ce qu'elle est maintenant.
        throw new NotFoundError('Compte introuvable.');
      }

      // Le rang voyage dans la revendication d'un jeton déjà signé : la colonne
      // change, les jetons en circulation non. Révoquer les sessions du compte
      // coupe la chaîne de rafraîchissement — sans quoi une rétrogradation
      // resterait sans effet pendant les sept jours du jeton de renouvellement,
      // le porteur se réémettant un jeton d'accès à volonté. La fenêtre qui
      // subsiste est celle du jeton d'accès en cours (`JWT_EXPIRES_IN`, 15 min) :
      // la fermer demanderait une revendication de version de compte, décision de
      // conception assumée par #21 et hors du périmètre de ce ticket.
      await this.repository.revokeAllSessionsOfUser(input.userId);
    }

    return { ...toProfile(target), role: input.role };
  }

  /**
   * Met à jour les coordonnées d'un **membre du personnel** — #55.
   *
   * ## Ce qu'elle ne touche pas, et pourquoi
   *
   * Ni `email`, ni `role`, ni `isActive` : le DTO ne les porte pas, le type de
   * `changes` ne les nomme pas, et le repository ne saurait pas les écrire. Les
   * trois ont chacun leur point d'entrée — le rôle par `PATCH /users/:id/role`,
   * l'activation par `PATCH /users/:id/status` — et l'adresse aucun, faute d'une
   * procédure de vérification de la nouvelle (même arbitrage qu'au #47).
   *
   * Ce découpage n'est pas une préférence de style : une route qui écrirait le
   * rôle serait une seconde porte vers l'attribution des droits, ouverte au rang
   * `MANAGER` là où l'autre exige `ADMIN`. La règle « un compte ne change pas son
   * propre rôle » s'y contournerait par la porte de service.
   *
   * `findStaffAccountById` avant écriture : c'est ce qui distingue « inconnu
   * ici » d'une non-modification, `updateContactDetails` rendant `false` dans les
   * deux cas — et c'est aussi ce qui rend une fiche cliente introuvable depuis
   * l'administration du personnel, comme partout ailleurs dans ce service.
   */
  public async updateStaffContactDetails(input: {
    userId: string;
    changes: { firstName?: string; lastName?: string; phone?: string | null };
  }): Promise<UserProfile> {
    const current = await this.repository.findStaffAccountById(input.userId);
    if (current === null) {
      throw new NotFoundError('Compte introuvable.');
    }

    const updated = await this.repository.updateContactDetails({
      userId: input.userId,
      changes: input.changes,
    });
    if (!updated) {
      // La ligne a disparu entre la lecture et l'écriture. Même réponse que si
      // elle n'avait jamais été là : c'est ce qu'elle est maintenant.
      throw new NotFoundError('Compte introuvable.');
    }

    return { ...toProfile(current), ...input.changes };
  }

  /**
   * Désactive — ou réactive — un compte du personnel, **sans rien supprimer**
   * (#55).
   *
   * ## Une colonne, pas un `DELETE`
   *
   * Le critère du CDC est « désactivation d'un compte sans suppression des
   * rendez-vous passés ». Un `DELETE` est donc exclu par l'énoncé, et il l'est
   * doublement par le schéma : `Appointment.staffId` et `Staff.userId` référencent
   * `users` en `Restrict`, si bien qu'un compte ayant honoré une seule visite ne
   * se supprime pas. La désactivation est un basculement de `is_active`, et la
   * ligne — donc l'historique qui la référence — reste intacte.
   *
   * Ce qui se ferme est la **connexion** : `AuthService.login` refuse un compte
   * inactif, et `refresh` éteint la session qu'il trouverait encore ouverte.
   *
   * ## Pourquoi révoquer les sessions
   *
   * Parce que `refresh` ne s'exécute qu'au renouvellement : sans révocation, un
   * jeton d'accès déjà émis reste valable jusqu'à son expiration
   * (`JWT_EXPIRES_IN`, 15 min), et le porteur continuerait d'agir avec les droits
   * d'un compte qu'on vient de fermer. Éteindre les sessions coupe la chaîne de
   * rafraîchissement immédiatement ; la fenêtre résiduelle est celle du jeton
   * d'accès en cours, comme pour `changeRole`, et la fermer demanderait une
   * revendication de version de compte — décision de conception assumée par #21,
   * hors du périmètre de ce ticket.
   *
   * Seulement à la désactivation : réactiver un compte n'a aucune session à
   * couper, et le faire déconnecterait un compte qu'on vient de rouvrir.
   *
   * ## Pourquoi on ne se désactive pas soi-même
   *
   * Même raison que pour `changeRole`, et le cas est plus brutal encore : l'unique
   * administrateur d'un salon qui se désactive ferme la porte de l'intérieur et
   * jette la clé — plus personne ne peut ni attribuer un rôle, ni réactiver quoi
   * que ce soit. Le contrôle est une règle métier (422), pas un refus de droit
   * (403) : l'appelant *a* le droit, c'est l'opération qui n'a pas de sens.
   *
   * Un salon ne peut donc jamais tomber à zéro administrateur actif par cette
   * route : il faut être connecté pour l'appeler, et on ne peut viser que
   * quelqu'un d'autre.
   */
  public async setStaffAccountActive(input: {
    actor: AuthenticatedUser;
    userId: string;
    isActive: boolean;
  }): Promise<StaffAccountState> {
    if (input.actor.userId === input.userId) {
      throw new BusinessRuleError('Un compte ne peut pas modifier sa propre activation.');
    }

    const target = await this.repository.findStaffAccountById(input.userId);
    if (target === null) {
      throw new NotFoundError('Compte introuvable.');
    }

    if (target.isActive !== input.isActive) {
      const updated = await this.repository.setStaffAccountActive({
        userId: input.userId,
        isActive: input.isActive,
      });
      if (!updated) {
        // La ligne a disparu entre la lecture et l'écriture. Même réponse que si
        // elle n'avait jamais été là : c'est ce qu'elle est maintenant.
        throw new NotFoundError('Compte introuvable.');
      }

      if (!input.isActive) {
        await this.repository.revokeAllSessionsOfUser(input.userId);
      }
    }

    // `isActive` s'ajoute **ici**, dans la forme propre à cette route, plutôt que
    // dans `UserProfile` : ce dernier est la charge utile de `GET /users`,
    // `GET /users/:id` et `/auth/me`, que le front lit par un schéma partagé
    // (`packages/shared`, empreinte de #314). Y ajouter un champ élargirait trois
    // contrats pour le besoin d'un seul, et un compte inactif n'a pas à être
    // désigné comme tel dans une réponse rendue à la clientèle.
    //
    // La valeur rendue est celle demandée, pas celle qu'on a lue : c'est l'état
    // du compte après l'appel, y compris quand rien n'a été écrit parce qu'il y
    // était déjà. L'opération est idempotente, sa réponse aussi.
    return { ...toProfile(target), isActive: input.isActive };
  }

  /**
   * Met à jour les coordonnées du compte **authentifié** — le quatrième critère
   * de #47.
   *
   * ## Pourquoi il n'y a pas d'`actor` à comparer
   *
   * Parce qu'il n'y a rien à comparer : le compte modifié **est** celui du jeton.
   * Le contrôleur passe `@CurrentUser().userId`, il n'y a pas d'identifiant en
   * chemin, et le client Prisma est déjà borné à l'établissement du jeton. Une
   * signature qui aurait pris un `userId` de requête aurait exigé un `if` de
   * plus, et ce `if` aurait eu à choisir entre 403 et 404 — le 403 étant
   * précisément la fuite qu'on refuse (tenant-isolation §4).
   *
   * ## Pourquoi la relecture précède l'écriture
   *
   * Pour la raison de `changeRole` : `updateContactDetails` rend `false` aussi bien
   * pour « ce compte n'existe pas dans cet établissement » que pour « aucune
   * ligne n'a changé ». Distinguer les deux demande de lire d'abord. Le cas n'est
   * pas théorique — un jeton reste valide quinze minutes après la suppression du
   * compte qu'il désigne, et un jeton signé sur le tenant voisin arrive ici avec
   * un `userId` que la portée courante ne connaît pas.
   *
   * `findUserById` et non `findStaffAccountById` : la clientèle est justement
   * l'appelante attendue de cette route, et le filtre sur les rôles internes la
   * rendrait introuvable d'elle-même.
   *
   * ## Ce que cette méthode ne fait pas
   *
   * Elle ne révoque aucune session, contrairement à `changeRole`. Changer de nom
   * ou de numéro ne change aucune revendication du jeton — ni `sub`, ni
   * `tenantId`, ni `role` —, et déconnecter quelqu'un qui vient de corriger une
   * faute de frappe dans son prénom serait gratuit.
   */
  public async updateOwnContactDetails(input: {
    userId: string;
    changes: { firstName?: string; lastName?: string; phone?: string | null };
  }): Promise<UserProfile> {
    const current = await this.repository.findUserById(input.userId);
    if (current === null) {
      throw new NotFoundError('Compte introuvable.');
    }

    const updated = await this.repository.updateContactDetails({
      userId: input.userId,
      changes: input.changes,
    });
    if (!updated) {
      // La ligne a disparu entre la lecture et l'écriture. Même réponse que si
      // elle n'avait jamais été là : c'est ce qu'elle est maintenant.
      throw new NotFoundError('Compte introuvable.');
    }

    // Recomposé plutôt que relu : les champs écrits sont exactement ceux que
    // `changes` porte, et une seconde lecture ne ferait qu'ajouter un
    // aller-retour pour retrouver ce qu'on vient d'envoyer.
    return { ...toProfile(current), ...input.changes };
  }
}
