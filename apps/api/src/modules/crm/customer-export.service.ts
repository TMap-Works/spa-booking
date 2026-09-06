import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
// Import **de valeur** et non `import type` : Nest lit le type du paramètre de
// constructeur dans les métadonnées émises par TypeScript, et un `import type`
// s'efface à la compilation — l'injection échouerait alors au démarrage.
import { CrmRepository } from './crm.repository';
import type { CustomerDataExport } from './crm.types';

/**
 * L'export des données personnelles d'une cliente — premier critère de #81,
 * CDC §5.1 « mécanismes d'accès, de rectification, d'export et de suppression ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Il ne
 * journalise rien non plus, et pour une raison plus forte encore qu'ailleurs
 * dans ce module : ce service produit, en un seul objet, **la totalité** de ce
 * que le salon détient sur une personne. C'est exactement la charge utile qu'on
 * ne veut voir passer nulle part ailleurs que dans la réponse HTTP demandée.
 *
 * ## Pourquoi un service à part de `CustomerHistoryService`
 *
 * Les deux lisent la fiche puis ses rendez-vous, et pourtant ils ne répondent
 * pas de la même chose. L'historique **agrège pour décider** : il compte, il
 * borne, il somme, et il montre une fenêtre parce qu'un écran affiche une
 * fenêtre. L'export **restitue pour rendre des comptes** : il n'agrège rien, ne
 * borne rien, et rend les textes libres que l'historique écarte délibérément.
 *
 * Les mêler aurait donné un service dont chaque méthode contredit la doctrine de
 * l'autre — et, plus concrètement, il aurait fallu un drapeau pour dire « cette
 * fois, ramène aussi les notes ». Un drapeau qui, mal placé, fait sortir des
 * notes internes par une route qui n'était pas faite pour.
 *
 * ## Ce que l'export n'a pas à porter
 *
 * Ni `tenantId`, ni les identifiants internes du praticien et de la prestation.
 * Le destinataire du document est la personne, pas l'établissement : ces
 * identifiants ne lui apprennent rien et invitent aux essais
 * (tenant-isolation §4).
 */
@Injectable()
export class CustomerExportService {
  public constructor(private readonly repository: CrmRepository) {}

  /**
   * Le dossier complet d'une fiche cliente de l'établissement courant.
   *
   * ## La fiche est lue d'abord, et le 404 en découle
   *
   * Même raison qu'à l'historique, en plus tranchée : sans cette relecture,
   * l'export d'un identifiant inconnu — ou d'une fiche du salon voisin —
   * rendrait un document **bien formé et vide** en 200. Un tel document a
   * l'apparence d'une réponse au titre de l'art. 15 alors qu'il ne prouve rien,
   * et il se remettrait à un demandeur sans que personne ne s'aperçoive de
   * l'erreur.
   *
   * ## Les deux lectures ne sont pas parallélisées
   *
   * Contrairement aux quatre de l'historique, et c'est délibéré : la seconde ne
   * doit avoir lieu **que** si la première a trouvé la fiche. Les lancer de
   * front ferait lire les rendez-vous d'un identifiant qu'on s'apprête à
   * déclarer introuvable — sans conséquence pour l'appelant, qui reçoit son 404,
   * mais c'est une lecture de données personnelles faite pour rien, et la
   * minimisation du CDC §5.1 commence là.
   *
   * ## Une fiche anonymisée s'exporte quand même
   *
   * Elle rend son pseudonyme, ses dates et ses montants — c'est-à-dire
   * exactement ce que le salon détient encore. Refuser l'export aurait été le
   * seul moyen de ne pas répondre à la question « que reste-t-il de moi chez
   * vous ? », qui est précisément celle que ce droit permet de poser.
   *
   * @throws {NotFoundError} aucune fiche de cet établissement ne porte cet
   * identifiant — inconnu, du salon voisin, ou compte du personnel,
   * indistinctement.
   */
  public async byCustomerId(customerId: string): Promise<CustomerDataExport> {
    const generatedAt = this.now();

    const customer = await this.repository.findById(customerId);
    if (customer === null) {
      throw new NotFoundError('Fiche cliente introuvable.');
    }

    const appointments = await this.repository.allAppointmentsForExport(customerId);

    return {
      generatedAt,
      identity: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        isActive: customer.isActive,
        createdAt: customer.createdAt,
        anonymizedAt: customer.anonymizedAt,
      },
      consents: {
        marketing: customer.marketingConsent,
        marketingRecordedAt: customer.marketingConsentAt,
      },
      // La note interne du salon fait partie du dossier : le droit d'accès porte
      // sur les données **concernant** la personne, y compris celles qu'elle
      // n'a pas écrites elle-même.
      internalNote: customer.internalNote,
      appointments,
    };
  }

  /**
   * L'instant courant, lu en un seul endroit — jumeau de celui de
   * `CustomersService`, et pour la même raison : une suite peut le remplacer
   * sans geler l'horloge du processus entier.
   */
  private now(): Date {
    return new Date();
  }
}
