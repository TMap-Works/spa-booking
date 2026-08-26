import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { CatalogRepository, type StaffRecord } from './catalog.repository';
import type { ServiceStaffMemberView } from './catalog.types';

/**
 * Affectation « ce praticien pratique cette prestation » — la relation N–N que
 * le choix du praticien et l'option « premier disponible » réclament (#25).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi il y a quand même deux contrôles
 *
 * Le repository injecte un client Prisma **scopé** : ni `requireService` ni
 * `requireStaff` ne comparent de `tenantId`, ils lisent simplement, et une
 * lecture visant un autre établissement rend `null`. Aucun `tenantId` ne
 * traverse ces signatures, donc aucune comparaison ne peut être oubliée.
 *
 * Ces deux contrôles ne sont donc **pas** la frontière — ce sont les clés
 * étrangères composites `(tenant_id, service_id)` et `(tenant_id, staff_id)` de
 * `service_staff` qui rendent l'affectation croisée impossible en base. Ils
 * servent à autre chose : sans eux, l'insertion échouerait sur une violation de
 * contrainte, remontée en 500 et indistinguable d'un incident. Avec eux, le
 * refus est un 404 qui nomme ce qui manque — et le même 404 couvre « n'existe
 * nulle part » et « existe ailleurs », ce qui est exactement ce qu'il faut
 * répondre (tenant-isolation §4).
 *
 * ## Une suppression, ici, et pas une désactivation
 *
 * Le reste du module ne supprime rien — une prestation ou une rubrique sort du
 * catalogue par `isActive: false`, parce que les rendez-vous passés la
 * référencent. Une ligne d'affectation, elle, n'est référencée par personne : un
 * rendez-vous porte son propre `staff_id` et son propre `service_id`, figés à la
 * réservation. La retirer n'efface donc rien de ce qui a été vendu, et la
 * conserver désactivée n'apprendrait rien à personne.
 */
@Injectable()
export class ServiceStaffService {
  public constructor(private readonly repository: CatalogRepository) {}

  /**
   * Les praticiens affectés à une prestation de l'établissement courant.
   *
   * La prestation est **vérifiée** avant la lecture : sans cela, un identifiant
   * inconnu — ou d'un autre établissement — rendrait une liste vide,
   * indistinguable d'une prestation à laquelle personne n'est encore affecté.
   * Les deux méritent des réponses différentes, et c'est 404 pour la première.
   */
  public async list(serviceId: string): Promise<ServiceStaffMemberView[]> {
    await this.requireService(serviceId);
    const staff = await this.repository.listServiceStaff(serviceId);
    return staff.map((member) => ServiceStaffService.toView(member));
  }

  /**
   * Affecte un praticien à une prestation.
   *
   * Rend le praticien affecté, et non la liste entière : c'est la ressource que
   * l'appel vient de créer, et l'écran qui coche une case n'a pas besoin de
   * relire les autres. Le doublon est un 409 — jamais un 200 silencieux, qui
   * empêcherait de distinguer « c'était déjà fait » de « quelqu'un vient de le
   * faire ».
   */
  public async assign(serviceId: string, staffId: string): Promise<ServiceStaffMemberView> {
    await this.requireService(serviceId);
    const staff = await this.requireStaff(staffId);

    await this.repository.assignStaff(serviceId, staffId);
    return ServiceStaffService.toView(staff);
  }

  /**
   * Retire l'affectation d'un praticien.
   *
   * Le praticien n'est pas vérifié à part : son identifiant ne sert qu'à
   * désigner la ligne à retirer, et « ce praticien n'existe pas ici » comme
   * « il n'est pas affecté à cette prestation » aboutissent au même refus. Un
   * contrôle de plus n'ajouterait qu'une requête et une façon supplémentaire de
   * distinguer deux absences qu'il n'y a aucune raison de séparer.
   *
   * La prestation, elle, l'est : c'est ce qui distingue « cette prestation
   * n'existe pas » de « personne de tel n'y est affecté », et le premier cas
   * mérite d'être dit à un écran qui croit encore afficher une fiche.
   */
  public async remove(serviceId: string, staffId: string): Promise<void> {
    await this.requireService(serviceId);

    const removed = await this.repository.removeStaff(serviceId, staffId);
    if (!removed) {
      throw new NotFoundError('Ce praticien n’est pas affecté à cette prestation.', {
        serviceId,
        staffId,
      });
    }
  }

  /** La prestation visée appartient-elle à l'établissement courant ? */
  private async requireService(serviceId: string): Promise<void> {
    const service = await this.repository.findServiceById(serviceId);
    if (service === null) {
      throw new NotFoundError('Prestation introuvable.', { serviceId });
    }
  }

  /**
   * La fiche praticien visée appartient-elle à l'établissement courant ?
   *
   * Rend l'enregistrement plutôt qu'un simple verdict : l'appelant en a besoin
   * pour composer sa réponse, et le relire après l'écriture coûterait une
   * requête pour des valeurs qui n'ont pas bougé entre-temps.
   */
  private async requireStaff(staffId: string): Promise<StaffRecord> {
    const staff = await this.repository.findStaffById(staffId);
    if (staff === null) {
      throw new NotFoundError('Praticien introuvable.', { staffId });
    }
    return staff;
  }

  /**
   * Recopie champ par champ plutôt qu'un `{ ...staff }`.
   *
   * L'étalement rendrait ce que le repository a lu — donc, le jour où quelqu'un
   * élargit la projection sans penser à la réponse, un champ interne de plus
   * dans une réponse d'API. Ici, publier demande d'écrire une ligne.
   */
  private static toView(staff: StaffRecord): ServiceStaffMemberView {
    return { id: staff.id, displayName: staff.displayName, isActive: staff.isActive };
  }
}
