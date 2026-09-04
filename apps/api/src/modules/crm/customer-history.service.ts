import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { CrmRepository, type HonoredTotalByCurrency } from './crm.repository';
import type { CustomerVisitHistory, CustomerVisitSummary } from './crm.types';

/**
 * Historique de visites **agrégé** — troisième critère de #56, CDC §2.3.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Il ne
 * journalise rien non plus : un historique est un objet fait de données
 * personnelles de bout en bout, et le seul canal par lequel il doit sortir est
 * la réponse HTTP demandée par un rôle interne (CDC §5.1).
 *
 * ## Pourquoi un service à part de `CustomersService`
 *
 * Parce que les questions ne sont pas les mêmes. `CustomersService` répond de
 * l'état d'une fiche — créer, corriger, désactiver ; celui-ci ne répond que
 * d'une **projection en lecture seule** sur des rendez-vous déjà écrits. Il
 * n'écrit rien, ne décide rien du cycle de vie d'un rendez-vous, et le mêler au
 * CRUD aurait donné un service dont la moitié des méthodes ne peut rien changer.
 *
 * ## L'agrégat porte sur tout, la liste sur une fenêtre
 *
 * C'est la propriété qui définit cet historique. `summary` compte, borne et
 * somme sur la **totalité** des rendez-vous de la fiche ; `visits` n'en montre
 * que les plus récents. Un agrégat calculé sur la fenêtre serait faux dès que la
 * fiche la dépasse — et il le serait silencieusement, ce qui est le pire mode de
 * défaillance pour un chiffre affiché à un commerçant.
 */
@Injectable()
export class CustomerHistoryService {
  public constructor(private readonly repository: CrmRepository) {}

  /**
   * L'historique d'une fiche cliente de l'établissement courant.
   *
   * La fiche est relue d'abord, et le 404 qui en découle n'est pas une
   * politesse : sans lui, l'historique d'un identifiant inconnu — ou d'une fiche
   * du salon voisin — rendrait un agrégat vide et une liste vide, c'est-à-dire
   * un **200 indiscernable** de celui d'une cliente qui n'est jamais venue. Un
   * 200 sur une ressource qui n'existe pas dans cette portée est une sonde
   * d'existence à l'envers : il ne dit pas que la fiche existe ailleurs, il dit
   * qu'on n'a pas regardé.
   *
   * Les quatre lectures qui suivent sont émises **en parallèle** : elles portent
   * sur la même table, aucune ne dépend du résultat d'une autre, et les
   * enchaîner ferait payer quatre allers-retours à un écran qui en attend un.
   */
  public async byCustomerId(customerId: string, limit: number): Promise<CustomerVisitHistory> {
    const customer = await this.repository.findById(customerId);
    if (customer === null) {
      throw new NotFoundError('Fiche cliente introuvable.');
    }

    const [visits, counts, bounds, totals] = await Promise.all([
      this.repository.recentVisits(customerId, limit),
      this.repository.countVisitsByStatus(customerId),
      this.repository.honoredVisitBounds(customerId),
      this.repository.sumHonoredByCurrency(customerId),
    ]);

    const byStatus = new Map(counts.map((row) => [row.status, row.count]));
    const countOf = (status: string): number => byStatus.get(status) ?? 0;
    const spent = singleCurrencyTotal(totals);

    const summary: CustomerVisitSummary = {
      // Somme des groupes plutôt qu'un `count` de plus : `groupBy` a déjà
      // parcouru les mêmes lignes, et deux requêtes qui comptent la même chose
      // finissent par se contredire sous concurrence.
      totalVisits: counts.reduce((total, row) => total + row.count, 0),
      honoredVisits: countOf('COMPLETED'),
      cancelledVisits: countOf('CANCELLED'),
      noShowVisits: countOf('NO_SHOW'),
      // « À venir » est ce qui occupe encore l'agenda — la même liste que le
      // prédicat partiel de la contrainte d'exclusion. Un `PENDING` du mois
      // dernier jamais honoré y figure : c'est un rendez-vous qui n'a été ni
      // annulé ni conclu, et le montrer est plus utile que de le taire.
      upcomingVisits: countOf('PENDING') + countOf('CONFIRMED'),
      firstVisitAt: bounds.firstVisitAt,
      lastVisitAt: bounds.lastVisitAt,
      totalSpentAmountMinor: spent?.amountMinor ?? null,
      totalSpentCurrency: spent?.currency ?? null,
    };

    return { summary, visits };
  }
}

/**
 * Le total dépensé, **si et seulement si** une seule devise est en jeu.
 *
 * Trois cas, et le troisième est le seul qui mérite d'être argumenté :
 *
 * - aucune visite honorée → `null`. Pas `0` : un zéro laisserait croire à une
 *   cliente venue sans rien payer, alors qu'elle n'est jamais venue ;
 * - une devise → la somme, avec son code ;
 * - plusieurs devises → `null`. Additionner des entiers dont les codes diffèrent
 *   produirait un nombre qui ne veut rien dire, et c'est exactement ce que le
 *   couple montant + devise du projet existe pour rendre impossible. Choisir
 *   « la devise dominante » serait pire : le chiffre serait plausible et faux.
 *
 * Le cas se produit quand l'établissement a changé de devise — chaque
 * rendez-vous fige la sienne à la réservation, et les anciennes lignes gardent
 * l'ancienne. Le rendre visible plutôt que le lisser est une décision : la
 * ventilation par devise dans la réponse est une évolution de contrat, donc une
 * issue, pas une ligne de plus ici.
 */
export function singleCurrencyTotal(
  totals: readonly HonoredTotalByCurrency[],
): HonoredTotalByCurrency | null {
  return totals.length === 1 ? (totals[0] ?? null) : null;
}
