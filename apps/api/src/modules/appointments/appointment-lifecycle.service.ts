import { Injectable } from '@nestjs/common';

import { InvalidStateTransitionError } from '../../common/errors';
import type { AppointmentStatus } from './appointment-status';
import { APPOINTMENT_STATUSES } from './appointment-status';

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

@Injectable()
export class AppointmentLifecycleService {
  /** `true` si le cycle de vie autorise ce passage. Un statut vers lui-même, non. */
  public canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /**
   * Refuse le passage que le cycle de vie n'autorise pas.
   *
   * @throws {InvalidStateTransitionError} 422, avec `from` et `to` dans
   * `details` : le front sait alors quoi dire sans avoir à interpréter un
   * message traduisible.
   */
  public requireTransition(from: AppointmentStatus, to: AppointmentStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to);
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
