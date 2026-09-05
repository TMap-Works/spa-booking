import { Injectable } from '@nestjs/common';

import { AvailabilityCacheService } from './availability-cache';
import { AvailabilityService, requireServableRange } from './availability.service';
import type { AvailabilityView, EngineAvailabilityQuery } from './availability.types';

/**
 * Le chemin de **lecture** de la disponibilité : le moteur, derrière son cache
 * (#35).
 *
 * ## Pourquoi un service distinct, et non une option de `AvailabilityService`
 *
 * Parce que la frontière entre « caché » et « non caché » est la garantie que le
 * cinquième critère de #35 demande : *un cache périmé ne peut jamais provoquer
 * une double réservation*. Elle tient à ceci, et à rien d'autre :
 *
 * | Chemin | Ce qu'il appelle | Voit le cache |
 * |---|---|---|
 * | `GET …/availability` | `AvailabilityQueryService` | oui |
 * | `GET …/availability?excludeAppointmentId=…` | `AvailabilityQueryService` | **non** (#442) |
 * | `POST …/appointments` (réservation, report) | `AvailabilityService` | **non** |
 *
 * Un drapeau `useCache` sur une méthode unique aurait mis cette garantie à la
 * merci d'un argument par défaut mal choisi, dans un fichier que le prochain
 * ticket modifiera. Deux services la rendent lisible d'un coup d'œil sur le
 * graphe d'injection, et un test suffit à la prouver : le service de rendez-vous
 * ne déclare pas ce fournisseur.
 *
 * Ce que le cache peut donc faire de pire, c'est **proposer** un créneau qui
 * n'est plus libre. La cliente le choisit, la réservation rejoue le moteur à
 * froid, et — s'il faut trancher — la contrainte d'exclusion rend 409. C'est le
 * partage de booking-engine §1 : le cache sert l'affichage, la base garantit
 * l'unicité.
 *
 * ## L'ordre des quatre étapes, et ce qui n'est jamais mis en cache
 *
 * 1. La plage est **jugée d'abord** : une plage inversée ou de plus de trente et
 *    un jours sort en 422 sans qu'aucune clé ne soit ni lue ni fabriquée.
 * 2. Une requête portant une **exclusion** est servie par le moteur nu, sans
 *    toucher au cache (#442) — voir `slotsFor`.
 * 3. Le cache est interrogé pour toutes les journées de la plage — tout ou rien.
 * 4. Sur défaut, le moteur calcule la plage entière et le résultat est écrit.
 *
 * Les **refus** ne sont jamais mis en cache : rien n'est écrit quand le moteur
 * lève. Un 404 caché survivrait à la réactivation de la prestation, et le salon
 * verrait sa page publique rester vide sans savoir pourquoi.
 *
 * La contrepartie, et il faut la lire en face : un **succès** caché court-circuite
 * aussi les contrôles du moteur. Une prestation désactivée alors que ses journées
 * sont déjà en cache continue de rendre 200 jusqu'à l'expiration du TTL, là où un
 * appel à froid rendrait 404 — et le catalogue (durée, tampons, `isActive`,
 * affectation des praticiens) n'invalide pas ce cache, faute de quoi
 * `CatalogModule` devrait dépendre d'`AvailabilityModule`, qui dépend déjà de lui.
 * C'est borné aux soixante secondes du TTL, et cela retombe dans l'asymétrie
 * assumée du CDC : au pire un créneau proposé que la réservation refusera, jamais
 * un rendez-vous posé sur une prestation qui n'existe plus — `book()` rejoue le
 * moteur à froid.
 */
@Injectable()
export class AvailabilityQueryService {
  public constructor(
    private readonly engine: AvailabilityService,
    private readonly cache: AvailabilityCacheService,
  ) {}

  /**
   * Les créneaux libres d'une prestation, servis depuis le cache quand il est
   * complet.
   *
   * `now` est un paramètre pour la même raison que dans `AvailabilityService` :
   * le filtrage du passé et du préavis se teste en décalant l'horloge de
   * l'appelant, jamais celle de la machine. Il ne participe **pas** à la clé de
   * cache, et c'est voulu — l'y mettre rendrait chaque requête unique, donc
   * chaque lecture un défaut. La conséquence assumée est qu'une réponse cachée
   * peut, pendant au plus soixante secondes, porter un créneau désormais sous le
   * préavis minimum ; la réservation le refusera, et c'est l'asymétrie du CDC :
   * mieux vaut un créneau montré en trop qu'un créneau libre masqué.
   *
   * ## La course connue du « lire puis écrire », et pourquoi on la garde
   *
   * Entre le défaut de cache et l'écriture ci-dessous, le moteur calcule — et une
   * invalidation qui tombe dans cet intervalle est **perdue** : elle jette des
   * clés qui n'existent pas encore, et la vue calculée *avant* l'écriture
   * s'installe pour tout le TTL. Une absence posée pile pendant ce calcul peut
   * donc rester invisible du calendrier pendant soixante secondes.
   *
   * C'est un défaut réel, et il est borné par le TTL — c'est-à-dire par la
   * garantie que ce cache offrait déjà sans aucune invalidation. La course ne
   * peut donc pas rendre la situation pire que le cas nominal du CDC, qui accepte
   * explicitement ce TTL court. La refermer demanderait une écriture
   * conditionnelle sur une génération par tenant (`INCR` à l'invalidation,
   * comparaison au moment d'écrire) — le même changement de forme de clé que
   * réclame déjà le coût du `SCAN`, et qu'une issue de suivi porte.
   *
   * Ce qu'elle ne met pas en cause : la réservation, qui rejoue le moteur à
   * froid et ne lit jamais ce cache.
   *
   * ## `excludeAppointmentId` contourne le cache, entièrement (#442)
   *
   * La clé est `(serviceId, staffId, journée)` et ne dit **rien** d'une
   * exclusion. Deux conduites étaient possibles : la faire entrer dans la clé,
   * ou écarter ces requêtes du cache. La seconde est retenue, et pour deux
   * raisons qui vont dans le même sens :
   *
   * - **la sûreté.** Une clé enrichie fonctionnerait, mais la moindre erreur d'y
   *   inscrire l'exclusion — un champ ajouté plus tard, un segment oublié —
   *   servirait une vue amputée d'un rendez-vous à tous les lecteurs de la
   *   minute suivante. Le contournement n'a pas d'état à tenir juste ;
   * - **le coût, qui est nul.** Ces requêtes sont rares : une par écran de
   *   report, sur une fenêtre de quatorze jours. Les mettre en cache
   *   n'économiserait rien, puisque personne ne repose deux fois la même
   *   question avec la même exclusion ; cela ne ferait qu'évincer les journées
   *   du calendrier ordinaire, qui, elles, sont demandées en boucle.
   *
   * Ni lecture ni écriture, donc : le cache est laissé exactement dans l'état où
   * la requête l'a trouvé.
   *
   * @throws {NotFoundError} prestation inconnue, hors de l'établissement, ou
   * retirée du catalogue.
   * @throws {AvailabilityRangeTooWideError} plage inversée ou trop large.
   */
  public async slotsFor(
    query: EngineAvailabilityQuery,
    now: Date = new Date(),
  ): Promise<AvailabilityView> {
    const dates = requireServableRange(query.from, query.to);

    if (query.excludeAppointmentId !== undefined) {
      // Le moteur nu, et rien d'autre : aucune clé n'est lue, aucune n'est
      // écrite. C'est ce qui rend vrai le troisième critère de #442 — « aucune
      // vue calculée avec une exclusion ne s'écrit dans le cache sous une clé
      // qui n'en dit rien ».
      return this.engine.slotsFor(query, now);
    }

    const key = { serviceId: query.serviceId, ...(query.staffId !== undefined && { staffId: query.staffId }) };

    const cached = await this.cache.readRange(key, dates);

    if (cached !== null) {
      return cached;
    }

    // Recomposée champ par champ plutôt que transmise telle quelle. La garde
    // ci-dessus suffit à écarter l'exclusion d'aujourd'hui ; la recomposition
    // dit la règle sur le type entier, et non sur un champ : ce qui descend ici
    // est **exactement** ce que la clé indexe. Un champ ajouté demain à
    // `EngineAvailabilityQuery` sans que la garde en soit informée ne pourra
    // donc pas se faire ranger sous une clé qui ne le mentionne pas — au pire il
    // sera ignoré sur ce chemin, ce qui est un manque, jamais une vue fausse
    // servie à tous les lecteurs de la minute suivante.
    const view = await this.engine.slotsFor(
      {
        serviceId: query.serviceId,
        ...(query.staffId !== undefined && { staffId: query.staffId }),
        from: query.from,
        to: query.to,
      },
      now,
    );

    await this.cache.writeRange(key, view);

    return view;
  }
}
