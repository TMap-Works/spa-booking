import { Injectable } from '@nestjs/common';

import { assertOrderedWindow, toHistoryPage } from './history';
import { PaymentsRepository } from './payments.repository';
import type { PaymentHistoryFilter, PaymentTransactionPage } from './payments.types';

/**
 * L'historique des transactions — deuxième et troisième critères de #62.
 *
 * ## Ce qu'il sert, et pourquoi c'est la surface du rapprochement
 *
 * Le CDC §4.9 demande « une journalisation permettant la réconciliation avec les
 * relevés Stripe ». Cette lecture-ci **est** cette journalisation : chaque ligne
 * porte son moyen, son statut, son montant, son cumul remboursé, son instant de
 * capture et — quand il y en a une — sa référence Stripe.
 *
 * Le rapprochement se fait alors en deux temps, et c'est le partage que le
 * quatrième critère de #62 impose :
 *
 * | Lignes | Ce qui en fait foi |
 * |---|---|
 * | `providerChargeId` non nul | le relevé Stripe, ligne à ligne |
 * | espèces (`providerChargeId` nul par construction) | la caisse du salon |
 *
 * Un filtre `method=CASH` isole les secondes, `method=CARD` les premières. Ce
 * n'est pas une convention documentée qu'il faudrait respecter : une vente en
 * espèces n'a **pas** de référence de prestataire parce qu'aucun appel n'a eu
 * lieu pour en produire une.
 *
 * ## Pourquoi un service distinct, là encore
 *
 * Comme `CashPaymentsService`, il n'injecte ni `StripeConfig` ni
 * `STRIPE_GATEWAY` : lire l'historique ne parle à personne. Le rapprochement se
 * fait sur **nos** lignes, pas en interrogeant Stripe à chaque ouverture d'un
 * écran — ce qui aurait rendu le back-office dépendant de la disponibilité du
 * prestataire pour afficher une liste.
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici. Le dépôt est scopé par le contexte de requête : la liste ne
 * contient que les encaissements de l'établissement courant, sans qu'aucune
 * ligne de ce fichier n'ait à le demander. Il n'y a pas de 403 à rendre — il n'y
 * a rien à voir.
 */
@Injectable()
export class PaymentsHistoryService {
  public constructor(private readonly payments: PaymentsRepository) {}

  /**
   * Une page de l'historique, la plus récente d'abord.
   *
   * @throws {HistoryWindowInvalidError} `from` postérieur ou égal à `to` — la
   * borne haute étant exclue, une telle fenêtre ne contient aucun instant.
   */
  public async list(filter: PaymentHistoryFilter): Promise<PaymentTransactionPage> {
    assertOrderedWindow(filter);

    return toHistoryPage(filter, await this.payments.listTransactions(filter));
  }
}
