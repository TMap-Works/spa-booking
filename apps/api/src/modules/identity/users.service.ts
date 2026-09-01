import { Injectable } from '@nestjs/common';

import { BusinessRuleError, NotFoundError } from '../../common/errors';
import { IdentityRepository, toProfile } from './identity.repository';
import type { AuthenticatedUser, UserProfile } from './identity.types';
import type { UserRole } from './roles';

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
  public constructor(private readonly repository: IdentityRepository) {}

  /** Les comptes internes de l'établissement courant — jamais la clientèle. */
  public async listStaffAccounts(): Promise<UserProfile[]> {
    return this.repository.listStaffAccounts();
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
   * Pour la raison de `changeRole` : `updateOwnProfile` rend `false` aussi bien
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

    const updated = await this.repository.updateOwnProfile({
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
