import { Injectable } from '@nestjs/common';

import { CatalogRepository, type StaffRecord } from './catalog.repository';
import type { StaffMemberView } from './catalog.types';

/**
 * L'annuaire des fiches praticien de l'établissement (#421).
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
 * `GET /v1/users`, lui, rend des **comptes** : son identifiant n'est pas celui
 * d'une fiche, et l'envoyer à l'affectation donne un 404. Séparer les deux n'est
 * pas un accident du modèle, c'est ce qui permet à une fiche de survivre à la
 * désactivation d'un compte et de rester citée par les rendez-vous passés.
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture ne peut donc rendre que les fiches d'ici, et il n'y a pas de
 * comparaison à oublier — pas plus qu'il n'y a de paramètre par lequel désigner
 * un autre établissement.
 *
 * Le mode ouvert par défaut est ce qui produit les fuites : l'extension refuse
 * toute opération sans portée résolue plutôt que de retomber sur « toutes les
 * lignes » (tenant-isolation §3).
 *
 * ## Pourquoi une liste, et rien d'autre
 *
 * Ni lecture par identifiant, ni création, ni modification : la fiche praticien
 * n'appartient à aucun module — le CDC §2.3 ne lui en donne pas — et `catalog`
 * ne fait que la **lire** pour ses affectations, sans en être propriétaire.
 * Ouvrir ici son cycle de vie reviendrait à choisir ce propriétaire par
 * inadvertance. Le jour où un module la prendra, cette lecture deviendra l'appel
 * de service correspondant (api-module §3).
 */
@Injectable()
export class StaffService {
  public constructor(private readonly repository: CatalogRepository) {}

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
