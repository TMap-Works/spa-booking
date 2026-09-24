import { Injectable } from '@nestjs/common';
import { hasAppointmentStarted } from '@spa/shared';

import { InvalidStateTransitionError } from '../../common/errors';
import type { AppointmentStatus } from './appointment-status';
import { APPOINTMENT_STATUSES, recordsOutcome } from './appointment-status';
import { AppointmentNotStartedError } from './appointments.errors';

/**
 * Le cycle de vie du rendez-vous, et **le seul endroit qui dise ce qui suit
 * quoi** — quatrième critère de #40 : « les transitions de statut interdites
 * sont refusées par un service dédié, pas par le contrôleur ».
 *
 * ```
 *                  ┌──────────► CANCELLED
 *                  │
 * PENDING ──► CONFIRMED ──► COMPLETED
 *    │              │
 *    │              └──────────► NO_SHOW
 *    └──► CANCELLED
 * ```
 *
 * ## Pourquoi un service, alors qu'une fonction pure aurait suffi
 *
 * Parce que c'est la place que le CDC et booking-engine §5 lui donnent — « les
 * valider dans un service dédié, pas dans le contrôleur » — et parce que la
 * règle est appelée à s'enrichir : #48 fera dépendre l'annulation d'un délai
 * préalable, #49 posera la confirmation, #51 le no-show. Chacun de ces tickets
 * ajoutera une condition qui a besoin de collaborateurs — l'horloge, les
 * réglages du tenant. Un injectable aujourd'hui évite d'avoir à réécrire tous
 * ses appelants le jour où il en aura.
 *
 * La **table**, elle, reste une donnée pure et exportée : elle se lit d'un coup
 * d'œil, se teste sans conteneur d'injection, et un test la compare aux statuts
 * qui occupent l'agenda.
 *
 * ## Deux règles, et non une seule table
 *
 * La table dit ce qui **suit** quoi. Elle ne dit pas *quand* : c'est la seconde
 * règle, posée par #1137. `COMPLETED` et `NO_SHOW` ne sont pas des décisions, ce
 * sont des **constats** — « honoré, encaissé », « client absent » —, et un constat
 * ne s'écrit pas avant le fait. Tant que le rendez-vous n'a pas commencé, les
 * deux sortent en 422 comme n'importe quelle transition interdite.
 *
 * C'est exactement la condition que ce fichier annonçait : « la règle est appelée
 * à s'enrichir … chacun de ces tickets ajoutera une condition qui a besoin de
 * collaborateurs — l'horloge ». Elle arrive ici, et non dans le contrôleur, pour
 * la raison qui vaut déjà pour la table — booking-engine §5 : « les valider dans
 * un service dédié ».
 *
 * ## Ce que ce service garantit, et ce qu'il ne garantit pas
 *
 * Il rend la **réponse** juste : un rendez-vous déjà annulé, terminé ou no-show
 * sort en 422 `INVALID_STATE_TRANSITION`, et non en 409 ni en 500. Il ne garantit
 * **rien** sous concurrence : entre sa réponse et l'écriture, une autre requête
 * peut avoir changé le statut. Ce qui tranche là est l'écriture conditionnelle
 * du repository — `updateMany` filtré sur le statut, qui rend un compte — et
 * c'est la même répartition que pour le report (#39) : ce service parle, la base
 * décide (booking-engine §1).
 *
 * La règle d'horloge, elle, **n'a pas de doublure en base** — et n'en a pas
 * besoin : `startsAt` ne bouge pas sous la requête. Un report en produit une
 * ligne neuve (booking-engine §5) plutôt que de déplacer celle-ci, si bien que
 * l'heure lue avant l'écriture est encore celle de la ligne écrite. Le seul écart
 * possible est le temps qui passe, et il ne va que dans le sens qui autorise.
 *
 * Les faire coexister n'est pas une redondance : sans ce service, la perdante
 * d'une course et la cliente qui reclique sur un lien d'annulation périmé
 * recevraient la même réponse indistincte, alors que l'une doit réessayer et
 * l'autre n'a plus rien à faire.
 */

/**
 * Ce qui peut suivre chaque statut — la table entière, statuts terminaux
 * compris.
 *
 * Les trois listes vides ne sont pas un remplissage : ce sont les états
 * terminaux du cycle, et les écrire explicitement est ce qui fait qu'un statut
 * ajouté demain au vocabulaire sans être ajouté ici ne compile pas. Un
 * `Partial<Record<…>>` aurait laissé le trou passer.
 *
 * `COMPLETED` ne mène nulle part : « tout retour en arrière depuis `completed` »
 * est interdit (booking-engine §5). Un soin honoré et encaissé qui redeviendrait
 * annulable ferait diverger le reporting du CDC §1.4 de la caisse.
 *
 * `PENDING` ne mène pas directement à `COMPLETED` : un soin ne peut pas être
 * honoré sans avoir été confirmé, et sauter la confirmation priverait la chaîne
 * de notifications de son point d'accroche.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/**
 * Le rendez-vous sur lequel la transition porte, et l'instant où on la demande —
 * #1137.
 *
 * Les deux vont ensemble et se lisent ensemble : séparés, on aurait pu appeler
 * la règle avec l'heure d'un rendez-vous et l'horloge d'un autre geste. `now`
 * n'est pas lu de l'horloge système ici, mais reçu : c'est la discipline du
 * module — toute méthode de `AppointmentsService` porte son instant en
 * paramètre, faute de quoi aucun test ne pourrait décaler le temps sans décaler
 * celui de la machine.
 */
export interface StatusChangeOccurrence {
  /**
   * L'heure du **soin** — le début de l'intervalle facturé, UTC.
   *
   * Et non `appointments.starts_at` tel quel : la colonne porte l'intervalle
   * **occupé**, qui commence un tampon de préparation plus tôt
   * (`billed-interval.ts`). L'appelant dérive donc cette heure comme les écrans
   * la dérivent — `AppointmentsService.treatmentStartOf` —, sans quoi la règle
   * ouvrirait « non présenté » cinq à dix minutes avant l'heure annoncée à la
   * cliente.
   */
  readonly startsAt: Date;
  /** L'instant de la décision. UTC. */
  readonly now: Date;
}

@Injectable()
export class AppointmentLifecycleService {
  /** `true` si le cycle de vie autorise ce passage. Un statut vers lui-même, non. */
  public canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /**
   * `true` si le rendez-vous a commencé — l'instant de son début est atteint.
   *
   * L'égalité compte comme « commencé » : à l'instant exact de son heure, le
   * rendez-vous a lieu, et une cliente qui ne s'est pas présentée à l'heure
   * pile est déjà absente.
   *
   * Le **début** et non la fin, délibérément : c'est ce que demande #1137
   * (« tant que le rendez-vous n'a pas commencé »), et c'est aussi ce qui reste
   * utilisable au comptoir. Exiger `endsAt` interdirait de solder une cliente
   * partie plus tôt, ou de marquer absente, à 9 h 05, celle qui ne viendra pas
   * à son rendez-vous de 9 h — deux gestes que le salon fait sans attendre.
   *
   * La comparaison elle-même vient de `@spa/shared` — `hasAppointmentStarted`,
   * posée par #1210, que le tiroir du comptoir et « Mon planning » lisent pour
   * n'offrir les deux constats qu'à partir de l'heure. Écrite des deux côtés,
   * c'est une inégalité qui finit par diverger d'un `<` : un écran ouvrirait
   * alors un geste que cette règle refuse, ou l'inverse.
   */
  public hasStarted(occurrence: StatusChangeOccurrence): boolean {
    return hasAppointmentStarted(occurrence.startsAt, occurrence.now);
  }

  /**
   * Refuse le passage que le cycle de vie n'autorise pas — par sa table, puis par
   * l'horloge.
   *
   * L'ordre n'est pas indifférent : `PENDING → COMPLETED` est interdit *par
   * nature* et doit le rester dit comme tel, même sur un rendez-vous passé. Ce
   * n'est qu'un passage autorisé par la table qui se voit ensuite demander s'il
   * a lieu d'être maintenant.
   *
   * `occurrence` est **obligatoire**, et c'est ce qui fait tenir la règle : un
   * paramètre facultatif aurait laissé un appelant futur — ou une méthode
   * ajoutée demain à `AppointmentsService` — la contourner par omission, sans
   * qu'aucun test ne le voie.
   *
   * @throws {InvalidStateTransitionError} 422, avec `from` et `to` dans
   * `details` : le front sait alors quoi dire sans avoir à interpréter un
   * message traduisible.
   * @throws {AppointmentNotStartedError} 422 lui aussi, `details.notStarted`
   * posé : le constat précède le fait qu'il prétend constater.
   */
  public requireTransition(
    from: AppointmentStatus,
    to: AppointmentStatus,
    occurrence: StatusChangeOccurrence,
  ): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to);
    }

    // `recordsOutcome` plutôt que deux littéraux : la liste vit dans
    // `appointment-status.ts`, avec le reste du vocabulaire, et un sixième statut
    // qui constaterait le passé s'y rangerait une fois pour toutes.
    if (recordsOutcome(to) && !this.hasStarted(occurrence)) {
      throw new AppointmentNotStartedError(from, to, occurrence.startsAt, occurrence.now);
    }
  }

  /**
   * Les statuts depuis lesquels on peut atteindre celui-ci.
   *
   * Dérivé de la table plutôt que recopié — c'est ce qui permet au témoin de
   * `__tests__/appointment-lifecycle.spec.ts` de vérifier que « ce qui peut
   * encore être annulé » est exactement « ce qui occupe l'agenda », sans que
   * deux listes aient à être tenues à jour ensemble.
   */
  public statusesLeadingTo(to: AppointmentStatus): readonly AppointmentStatus[] {
    return APPOINTMENT_STATUSES.filter((from) => this.canTransition(from, to));
  }
}
