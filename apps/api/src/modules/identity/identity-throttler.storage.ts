import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Le stockage des compteurs du limiteur de débit — une fenêtre fixe qui expulse
 * ses entrées expirées, **sans une seule minuterie** (#1128).
 *
 * ## Les deux défauts qu'il remplace
 *
 * `ThrottlerStorageService`, le stockage par défaut de `@nestjs/throttler`
 * 6.5.0, en porte deux, et ils sont de la même famille : tous deux viennent de
 * ce qu'il fait décroître ses compteurs par un `setTimeout` **par appel** plutôt
 * que de dater sa fenêtre.
 *
 * ### 1. Une clé y naît et n'en repart jamais
 *
 * Sa `Map` n'est jamais purgée : seul le compteur d'une clé décroît, la clé
 * elle-même reste jusqu'au redémarrage de la tâche. Tant que `/auth/login`
 * n'avait qu'une clé — l'adresse du front Next, la même pour tout le monde —,
 * cela ne se voyait pas. Depuis #1127 la clé est la **cible** que l'appelant
 * nomme, et une cible s'invente : un slug qui n'existe pas suffit, et il coûte
 * moins cher qu'une connexion puisque la validation le refuse **après** la
 * garde.
 *
 * ### 2. Une entrée bloquée figeait la décroissance de toutes les autres
 *
 * `resetBlockdRequest` appelle `clearExpirationTimes(throttlerName)`, qui annule
 * les minuteries de **toutes** les clés du limiteur et pas seulement celles de
 * la clé remise à zéro. Dès qu'un blocage expirait quelque part, les compteurs
 * des autres cibles cessaient de décroître et s'accumulaient jusqu'à franchir
 * leur propre plafond. Le quota se comportait alors en fenêtre fixe sans le
 * dire — un comportement que l'on subissait au lieu de le choisir.
 *
 * ## Ce que celui-ci fait à la place
 *
 * Une entrée porte la **date de fin** de sa fenêtre, et rien d'autre ne la fait
 * vivre. Il n'y a donc aucune minuterie à annuler, et aucun moyen pour l'état
 * d'une clé de toucher à celui d'une autre : le second défaut ne disparaît pas,
 * il devient inexprimable.
 *
 * L'expulsion, elle, se fait par **balayage amorti** : au plus un parcours par
 * seconde (`SWEEP_INTERVAL_MS`), déclenché par les appels eux-mêmes. Pas de
 * minuterie de fond non plus — un stockage qui arme un intervalle tient la
 * boucle d'événements éveillée pour rien, et c'est précisément ce qui oblige la
 * suite de tests du stockage par défaut à l'éteindre à la main.
 *
 * ## La borne réelle, dite honnêtement
 *
 * La taille n'est pas bornée par une constante : elle l'est par **une fenêtre de
 * trafic**. Un appelant qui invente une cible par requête fait naître une entrée
 * par requête, et ces entrées vivent jusqu'à la fin de leur fenêtre — soixante
 * secondes sur les routes d'identité. C'est déjà tout autre chose qu'une
 * croissance jusqu'au redémarrage, et c'est la borne qu'un limiteur à fenêtre
 * peut tenir seul : fermer le flot lui-même relève du limiteur d'entrée
 * (`infra/terraform/`), pas d'un compteur applicatif — voir
 * `identity-throttler.guard.ts`, « Ce que ce compteur ne borne pas ».
 *
 * Expulser une entrée **non expirée** pour tenir un plafond dur serait pire que
 * le mal : ce serait rendre un quota neuf à la cible expulsée, c'est-à-dire
 * offrir à l'attaquant le moyen de vider le compteur qui le gêne. Un stockage
 * réellement borné se partage (Redis) ; il a de toute façon vocation à arriver
 * le jour où l'API tourne sur plus d'une tâche, les compteurs en mémoire étant
 * aujourd'hui divisés par le nombre de tâches.
 *
 * ## Fenêtre fixe, et ce que cela concède
 *
 * Une fenêtre fixe autorise jusqu'à deux fois le plafond à cheval sur une
 * bordure — dix connexions à la fin d'une minute, dix au début de la suivante.
 * Le débit moyen reste celui qu'on annonce, et sur ces routes-là c'est ce qui
 * compte : ce que le plafond borne est le coût d'un bcrypt de coût 12 et le
 * forçage d'un mot de passe sur la durée, pas une rafale de deux secondes. Le
 * stockage remplacé ne faisait pas mieux — il tombait dans cette même fenêtre
 * fixe dès le premier blocage, par accident.
 */

/**
 * Le verdict rendu au limiteur à chaque appel.
 *
 * Dérivé de l'interface plutôt qu'importé : `@nestjs/throttler` 6.5.0 déclare
 * bien un `ThrottlerStorageRecord`, mais son baril ne le réexporte pas — seul
 * `throttler-storage-record.interface` le porte, et l'atteindre demanderait un
 * import profond dans le `dist` d'une dépendance, c'est-à-dire un chemin que
 * rien ne garantit d'une version à l'autre. Le tirer de la signature publique
 * donne exactement le même type, et le fait suivre si elle change.
 */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Intervalle minimal entre deux balayages — voir l'en-tête. */
export const SWEEP_INTERVAL_MS = 1_000;

/** Un compteur, et la fenêtre pendant laquelle il vaut. */
interface Counter {
  /** Appels comptés depuis l'ouverture de la fenêtre. */
  hits: number;
  /** Fin de la fenêtre — date absolue en millisecondes. */
  expiresAt: number;
  /** Fin du blocage, ou `0` tant que le compteur n'a jamais été bloqué. */
  blockExpiresAt: number;
}

/** Secondes restantes avant une échéance — jamais négatif, comme l'attend la garde. */
function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * L'identifiant interne d'un compteur — le nom du limiteur **et** sa clé.
 *
 * `generateKey` préfixe déjà la clé du nom du limiteur, si bien que deux
 * limiteurs nommés ne se confondent pas aujourd'hui. Les joindre ici malgré tout
 * tient la promesse de l'interface, qui passe `throttlerName` en argument : une
 * application qui redéfinirait `generateKey` sans y mettre le nom trouverait
 * sinon ses deux limiteurs sur un seul compteur.
 *
 * Joints **préfixés de leur longueur** plutôt que par un séparateur, pour la
 * raison qu'expose déjà `targetTracker` dans la garde : un séparateur suppose un
 * caractère qu'aucune des deux moitiés ne peut porter, et la longueur ne se
 * falsifie pas.
 */
function counterId(throttlerName: string, key: string): string {
  return `${throttlerName.length}:${throttlerName}${key}`;
}

@Injectable()
export class IdentityThrottlerStorage implements ThrottlerStorage {
  private readonly counters = new Map<string, Counter>();

  /**
   * Date du dernier balayage. Zéro au départ : le premier appel balaie une
   * `Map` vide, ce qui ne coûte rien et évite un cas particulier.
   */
  private lastSweptAt = 0;

  /**
   * Le nombre d'entrées vivantes.
   *
   * Exposé pour l'**observation** — c'est ce que la suite de tests mesure pour
   * montrer que les entrées expirées repartent. Aucune décision du limiteur n'en
   * dépend, et rien ne doit en dépendre : un stockage qui se bornerait lui-même
   * en expulsant des compteurs vivants rendrait des quotas neufs.
   */
  public get size(): number {
    return this.counters.size;
  }

  /**
   * L'interface du limiteur est asynchrone — un stockage partagé fait un
   * aller-retour réseau. Celui-ci est en mémoire : il répond sans rien attendre,
   * et le `Promise.resolve` n'est là que pour honorer la signature.
   */
  public increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    return Promise.resolve(this.count(key, ttl, limit, blockDuration, throttlerName));
  }

  /** Le verdict de cet appel, et la mise à jour du compteur qu'il consomme. */
  private count(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ThrottlerStorageRecord {
    const now = Date.now();
    this.sweep(now);

    const id = counterId(throttlerName, key);
    let counter = this.counters.get(id);

    if (counter === undefined) {
      counter = { hits: 0, expiresAt: now + ttl, blockExpiresAt: 0 };
      this.counters.set(id, counter);
    }

    // Blocage en cours : l'appel est refusé **sans être compté**. Le compter
    // repousserait la fin du blocage à chaque essai, et qui insiste ne
    // retrouverait jamais la main.
    if (counter.blockExpiresAt > now) {
      return {
        totalHits: counter.hits,
        timeToExpire: secondsUntil(counter.expiresAt, now),
        isBlocked: true,
        timeToBlockExpire: secondsUntil(counter.blockExpiresAt, now),
      };
    }

    // Blocage échu, ou fenêtre close : dans les deux cas le compteur repart de
    // zéro sur une fenêtre neuve. `blockExpiresAt` est une date absolue, jamais
    // nulle une fois posée — c'est ce qui distingue « a été bloqué » de
    // « ne l'a jamais été ».
    if (counter.blockExpiresAt !== 0 || counter.expiresAt <= now) {
      counter.hits = 0;
      counter.blockExpiresAt = 0;
      counter.expiresAt = now + ttl;
    }

    counter.hits += 1;

    const blocked = counter.hits > limit;
    if (blocked) {
      counter.blockExpiresAt = now + blockDuration;
    }

    return {
      totalHits: counter.hits,
      timeToExpire: secondsUntil(counter.expiresAt, now),
      isBlocked: blocked,
      timeToBlockExpire: blocked ? secondsUntil(counter.blockExpiresAt, now) : 0,
    };
  }

  /**
   * Expulse les compteurs dont la fenêtre **et** le blocage sont échus — au plus
   * un parcours par seconde.
   *
   * L'amortissement est ce qui empêche le remède de coûter plus cher que le
   * mal : balayer à chaque appel rendrait le limiteur quadratique en nombre de
   * cibles vivantes, ce qu'une attaque par cibles inventées saurait exploiter.
   * Une entrée expirée survit donc au plus une seconde de plus, ce qui ne change
   * rien à ce qu'elle décide — elle est morte, et le prochain appel sur sa clé
   * lui rouvrirait de toute façon une fenêtre neuve.
   *
   * Supprimer pendant l'itération est licite sur une `Map` : l'itérateur ne
   * revient pas sur ce qu'il a déjà rendu.
   */
  private sweep(now: number): void {
    if (now - this.lastSweptAt < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweptAt = now;

    for (const [id, counter] of this.counters) {
      if (counter.expiresAt <= now && counter.blockExpiresAt <= now) {
        this.counters.delete(id);
      }
    }
  }
}
