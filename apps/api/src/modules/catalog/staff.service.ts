import { Injectable } from '@nestjs/common';
import type { CreateStaffMemberRequest, UpdateStaffMemberRequest } from '@spa/shared';

import { NotFoundError } from '../../common/errors';
import { UsersService } from '../identity/users.service';
import { CatalogRepository, type StaffRecord } from './catalog.repository';
import type { StaffMemberView } from './catalog.types';

/**
 * Les fiches praticien de l'établissement — annuaire (#421) et cycle de vie
 * (#694).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Ce qu'il débloque
 *
 * L'affectation « ce praticien pratique cette prestation » attend l'identifiant
 * d'une **fiche** praticien. Deux lectures en rendaient jusqu'ici, et aucune ne
 * suffisait pour amorcer un salon : `GET /services/:id/staff` ne rend que les
 * praticiens **déjà affectés**, et le catalogue public pas davantage. Un salon
 * qui démarre n'a aucune affectation, donc aucun candidat, donc aucun moyen de
 * faire la première — la liste des candidats se déduisait d'affectations qui
 * n'existaient pas encore.
 *
 * #421 a livré la liste. Il y manquait ce qui la remplit : **aucun geste du
 * back-office ne créait de fiche**. Seul le jeu d'essai Prisma en posait, si
 * bien qu'un établissement jamais semé restait inexploitable de bout en bout —
 * zéro praticien, donc zéro affectation possible, donc « aucun créneau sur les
 * 14 prochains jours » dans le tunnel public. C'est ce que #694 referme.
 *
 * ## Compte et fiche : deux choses, et le lien est ici
 *
 * `GET /v1/users` rend des **comptes** : leur identifiant n'est pas celui d'une
 * fiche, et l'envoyer à l'affectation donne un 404. Séparer les deux n'est pas
 * un accident du modèle, c'est ce qui permet à une fiche de survivre à la
 * désactivation d'un compte et de rester citée par les rendez-vous passés.
 *
 * La création est précisément le geste qui **noue** les deux, et c'est le seul
 * endroit où le nœud se fait. Le compte est vérifié par un appel à
 * `UsersService` — la voie prévue entre modules (api-module §3) —, jamais par
 * une lecture de la table `users` depuis le dépôt du catalogue. Ce que cet appel
 * garantit tient en trois refus, et son 404 les couvre tous les trois : le
 * compte n'existe nulle part, il appartient à l'établissement voisin, ou c'est
 * une fiche cliente. Aucun des trois ne se distingue dans la réponse — la
 * différence est exactement l'information à ne pas donner (tenant-isolation §4).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture ne peut donc rendre que les fiches d'ici, une écriture ne peut en
 * poser qu'ici, et il n'y a pas de comparaison à oublier — pas plus qu'il n'y a
 * de paramètre par lequel désigner un autre établissement.
 *
 * Le mode ouvert par défaut est ce qui produit les fuites : l'extension refuse
 * toute opération sans portée résolue plutôt que de retomber sur « toutes les
 * lignes » (tenant-isolation §3).
 *
 * ## Pourquoi pas de suppression
 *
 * Une fiche se **désactive** (`PATCH`, `isActive: false`). Les rendez-vous
 * passés la citent par `staff_id` et le reporting doit continuer à savoir qui a
 * tenu la cabine ; la supprimer effacerait l'histoire du salon pour épargner une
 * ligne de liste. Même arbitrage que sur les prestations et les comptes.
 */
@Injectable()
export class StaffService {
  public constructor(
    private readonly repository: CatalogRepository,
    private readonly users: UsersService,
  ) {}

  /**
   * Les fiches praticien de l'établissement courant.
   *
   * Rend **toutes** les fiches par défaut, désactivées comprises : c'est à
   * l'écran de décider ce qu'il propose, et une gérante qui ne voit pas une
   * fiche désactivée la recrée — pour se heurter à l'unicité
   * `(tenant_id, user_id)`. Le filtre existe pour qui n'en veut pas, comme sur
   * les prestations et les rubriques.
   */
  public async list(activeOnly: boolean): Promise<StaffMemberView[]> {
    const staff = await this.repository.listStaff(activeOnly);
    return staff.map((member) => StaffService.toView(member));
  }

  /**
   * Crée la fiche praticien d'un compte du personnel (#694).
   *
   * Le compte est vérifié **avant** l'insertion, et par le module qui le
   * possède : `UsersService.byId` lève un 404 pour un compte inconnu, celui d'un
   * autre établissement, ou une fiche cliente. Ce n'est pas une garde
   * redondante avec la clé étrangère composite `(tenant_id, user_id)` — celle-ci
   * refuserait l'insertion, mais par une erreur de contrainte que rien ne
   * saurait traduire en un message compréhensible, et elle laisserait passer le
   * cas qui compte le plus ici : le compte `CLIENT` d'ici, que la base accepte
   * très bien et dont personne ne veut l'agenda dans le planning du salon.
   *
   * Le conflit d'unicité, lui, reste à la base : deux soumissions concurrentes
   * du même formulaire passeraient toutes les deux un contrôle applicatif, et la
   * perdante recevrait un 500 au lieu du 409 annoncé.
   *
   * `displayName` vient du corps et non du compte : c'est le nom **de vitrine**,
   * celui que la cliente lira dans le tunnel de réservation, et il n'a aucune
   * raison de reprendre l'état civil du contrat de travail. L'écran le préremplit
   * avec le nom du compte, ce qui est un service rendu à la saisie, pas une règle
   * du domaine.
   */
  public async create(input: CreateStaffMemberRequest): Promise<StaffMemberView> {
    await this.users.byId(input.userId);

    const created = await this.repository.createStaff({
      userId: input.userId,
      displayName: input.displayName,
      // « Absente » et « vide » disent la même chose à la création : pas de
      // présentation. La colonne est nullable, elle porte cette absence.
      bio: input.bio ?? null,
    });

    return StaffService.toView(created);
  }

  /**
   * Modifie une fiche de l'établissement courant — nom de vitrine, présentation,
   * activation.
   *
   * Un corps vide est accepté et ne change rien : c'est ce que le `PATCH` des
   * prestations fait déjà, et refuser obligerait chaque écran à savoir s'il a
   * quelque chose à envoyer avant de pouvoir enregistrer.
   *
   * `null` traduit le 404 : identifiant inconnu ou fiche du voisin,
   * indistinctement — la différence est ce qu'il ne faut pas publier (§4).
   *
   * ## Le cache de disponibilité n'est pas chassé ici, et c'est délibéré
   *
   * Désactiver un praticien retire ses créneaux du tunnel public, que le module
   * `availability` sert derrière un cache de 60 s. Le chasser obligerait
   * `catalog` à dépendre d'`availability` — une dépendance qu'aucune de ses
   * écritures n'a aujourd'hui, `assignStaff` et `removeStaff` comprises, qui
   * changent pourtant elles aussi qui peut servir quelle prestation. La fenêtre
   * de péremption est la même pour les trois, bornée par le TTL, et la
   * réservation revalide de toute façon à l'écriture : un créneau servi depuis
   * un cache périmé ne devient pas un rendez-vous. Ouvrir cette dépendance pour
   * une seule des trois écritures serait une incohérence de plus, pas une
   * correction.
   *
   * Les champs sont recopiés par étalement conditionnel plutôt que passés en
   * bloc — la conduite d'`ServicesService.update`, et pour la même raison :
   * `exactOptionalPropertyTypes` distingue « absent » de « présent et
   * `undefined` », et c'est cette distinction qui empêche un `{ bio: undefined }`
   * de descendre jusqu'à Prisma, où il serait ignoré en silence plutôt que
   * refusé.
   */
  public async update(id: string, patch: UpdateStaffMemberRequest): Promise<StaffMemberView> {
    const updated = await this.repository.updateStaff(id, {
      ...(patch.displayName !== undefined && { displayName: patch.displayName }),
      ...(patch.bio !== undefined && { bio: patch.bio }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    });

    if (updated === null) {
      throw new NotFoundError('Praticien introuvable.');
    }

    return StaffService.toView(updated);
  }

  /**
   * Recopie champ par champ plutôt qu'un `{ ...member }`.
   *
   * L'étalement rendrait ce que le repository a lu — donc, le jour où quelqu'un
   * élargit la projection sans penser à la réponse, un champ interne de plus
   * dans une réponse d'API. Ici, publier demande d'écrire une ligne.
   */
  private static toView(member: StaffRecord): StaffMemberView {
    return { id: member.id, displayName: member.displayName, isActive: member.isActive };
  }
}
