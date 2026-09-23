import { Injectable } from '@nestjs/common';

import { NotificationsRepository } from './notifications.repository';
import type {
  NotificationChannel,
  NotificationStatus,
  NotificationTrace,
  NotificationType,
} from './notifications.types';

/**
 * Plafond de lignes rendues par `GET /notifications`.
 *
 * Généreux pour l'usage dominant — un rendez-vous porte au plus six lignes,
 * trois messages fois deux canaux — et borné pour l'usage large : un
 * établissement actif accumule des milliers d'envois, et une lecture non bornée
 * est un déni de service à une requête. Ce n'est pas une pagination : le journal
 * n'est pas un écran qu'on parcourt, c'est une réponse à « qu'est-ce qui est
 * parti pour ce rendez-vous ? ». Le jour où il le deviendrait, il lui faudrait
 * un curseur, pas un plafond plus haut.
 */
export const NOTIFICATION_LIST_MAX = 200;

/** Les filtres qu'un appelant peut poser, plafond exclu. */
export interface NotificationSearch {
  readonly appointmentId?: string;
  readonly type?: NotificationType;
  readonly channel?: NotificationChannel;
  readonly statuses?: readonly NotificationStatus[];
  readonly limit?: number;
  /**
   * Le périmètre de lecture de l'appelant — `null` pour tout l'établissement,
   * son identifiant de compte pour ses seuls rendez-vous (#1200).
   *
   * Ce n'est **pas un filtre de la requête** : il ne vient pas de la chaîne de
   * requête mais du jeton vérifié, et il est posé par le contrôleur, qui seul
   * connaît la porte par laquelle l'appelant est entré. Un praticien ne peut
   * donc pas l'élargir — le `whitelist` du `ValidationPipe` global refuse déjà
   * tout champ non déclaré par `ListNotificationsQueryDto`, et celui-ci n'y
   * figure pas.
   *
   * Obligatoire, contrairement aux autres champs : voir
   * `NotificationListQuery.ownedByUserId`.
   */
  readonly ownedByUserId: string | null;
}

/**
 * La lecture du journal d'envois — cinquième critère d'acceptation de #70,
 * « le statut d'envoi est visible dans le back-office ».
 *
 * ## Pourquoi un service pour une seule lecture
 *
 * Parce que le plafond est une **règle**, pas de la plomberie HTTP : le
 * contrôleur ne doit pas pouvoir l'oublier, et le dépôt ne doit pas en décider.
 * Le mettre ici est ce qui garantit qu'aucun appelant — le contrôleur
 * d'aujourd'hui, le consommateur de file de demain — ne lise sans borne.
 *
 * ## Ce qu'il ne décide pas : la portée
 *
 * `ownedByUserId` lui arrive **déjà résolu**, du contrôleur. Il ne lit ni rôle
 * ni permission, et c'est délibéré : ADR 0013 écarte nommément l'option de
 * « filtrer les réponses selon le rôle » dans chaque service, parce que le
 * défaut d'un filtre oublié y est silencieux — la route répond 200, avec trop de
 * données. Ici la portée est un critère de recherche comme un autre, obligatoire
 * dans le type, et le service reste testable sans couche d'autorisation.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne **renvoie** pas, ne **réessaie** pas, ne **supprime** pas. Le journal
 * est en lecture seule : la reprise d'un envoi échoué appartient à SQS et à son
 * backoff natif (notifications §4), et un bouton « renvoyer » au comptoir
 * doublerait la file en masquant la profondeur de DLQ sur laquelle repose
 * l'alarme. C'est une décision d'exploitation, pas un geste de comptoir.
 */
@Injectable()
export class NotificationsService {
  public constructor(private readonly repository: NotificationsRepository) {}

  public list(search: NotificationSearch): Promise<readonly NotificationTrace[]> {
    return this.repository.list({
      ...(search.appointmentId === undefined ? {} : { appointmentId: search.appointmentId }),
      ...(search.type === undefined ? {} : { type: search.type }),
      ...(search.channel === undefined ? {} : { channel: search.channel }),
      ...(search.statuses === undefined ? {} : { statuses: search.statuses }),
      // Recopié tel quel, `null` compris : le service ne décide pas de la
      // portée, il la transmet. La décider ici aurait demandé de lire le rôle de
      // l'appelant — c'est-à-dire de remettre la matrice de permissions dans un
      // service, ce qu'ADR 0013 écarte explicitement (option B).
      ownedByUserId: search.ownedByUserId,
      // Borné des **deux** côtés : `take` négatif ne rend pas moins de lignes
      // chez Prisma, il inverse le parcours et rendrait les envois les plus
      // *anciens* sous un ordre annoncé décroissant. Le plancher est ce qui
      // empêche un appelant distrait de retourner le journal.
      limit: Math.min(Math.max(search.limit ?? NOTIFICATION_LIST_MAX, 1), NOTIFICATION_LIST_MAX),
    });
  }
}
