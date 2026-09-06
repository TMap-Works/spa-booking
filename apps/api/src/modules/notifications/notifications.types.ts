/**
 * Le vocabulaire du module `notifications`, côté domaine.
 *
 * Ni DTO HTTP — le module n'a aucune route au périmètre de #68 — ni types
 * générés par Prisma : ce sont les formes que le service et le dépôt acceptent
 * et rendent (api-module §2).
 *
 * **Aucune coordonnée n'y figure.** Pas d'adresse e-mail, pas de numéro, pas de
 * nom de cliente : le destinataire est désigné par l'identifiant de son compte,
 * et l'adresse se relit au moment de l'envoi. C'est la règle du schéma — « aucune
 * coordonnée n'est recopiée ici » — portée jusque dans les types, pour qu'une
 * donnée personnelle n'ait structurellement aucun endroit où se glisser dans un
 * message de file ou dans un journal (CDC §5.1, notifications §7).
 */

/**
 * Les trois messages du périmètre MVP — CDC §1.4, `enum NotificationType` du
 * schéma.
 *
 * Liste locale plutôt qu'import du client généré, pour la raison qui vaut dans
 * `payments.types.ts`, `appointment-status.ts` et `identity/roles.ts` : ce
 * fichier est lu par le service, auquel api-module §2 interdit de connaître
 * Prisma, et une machine sans `prisma generate` verrait sinon échouer des suites
 * qui ne parlent pas du schéma. Le **témoin** vit dans
 * `__tests__/notifications.types.spec.ts`.
 *
 * En ajouter une valeur revient à élargir le périmètre MVP : cela passe par une
 * issue, pas par une ligne.
 */
export const NOTIFICATION_TYPES = ['BOOKING_CONFIRMATION', 'REMINDER_24H', 'CANCELLATION'] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Canal d'expédition — `enum NotificationChannel` du schéma, même régime. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Sort d'un envoi — `enum NotificationStatus` du schéma, même régime. */
export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Les statuts qui **occupent** la place dans `notifications_live_once`.
 *
 * `PENDING` l'occupe parce que la ligne est inscrite avant l'appel au
 * fournisseur — c'est cette inscription qui sérialise deux livraisons
 * concurrentes. `SENT` l'occupe parce que le message est parti. `FAILED` ne
 * l'occupe pas : un échec transitoire doit pouvoir se réessayer, sans quoi la
 * première erreur réseau condamnerait le rappel (notifications §4).
 *
 * Cette liste est le **reflet applicatif** du `WHERE` de l'index, pas sa source :
 * l'index vit dans la migration, et c'est lui qui tranche. Elle sert à ce que le
 * dépôt cherche la ligne vivante avec la même définition que la base, et une
 * suite vérifie que les deux disent la même chose.
 */
export const LIVE_NOTIFICATION_STATUSES = ['PENDING', 'SENT'] as const;

export type LiveNotificationStatus = (typeof LIVE_NOTIFICATION_STATUSES)[number];

/**
 * Ce qu'une livraison SQS demande d'envoyer.
 *
 * Le message ne porte **rien qui puisse dériver** : ni contenu rendu, ni adresse.
 * Il désigne, et l'expéditeur relit. Un message de file survit à sa file — il
 * peut être rejoué une heure plus tard, après une annulation — et un contenu figé
 * au moment de la publication annoncerait alors un rendez-vous qui n'existe plus.
 */
export interface NotificationMessage {
  /**
   * L'identité de la livraison, telle que le producteur la compose.
   *
   * Portée par `(tenant_id, dedupe_key)` en base. Distincte de l'invariant
   * métier que porte `notifications_live_once` : voir l'en-tête de la migration
   * `20260906120000_add_notification_idempotency`.
   */
  readonly dedupeKey: string;

  /** Le rendez-vous concerné — les trois types du MVP en portent tous un. */
  readonly appointmentId: string;

  /** Le compte destinataire. L'adresse se relit dessus au moment de l'envoi. */
  readonly recipientUserId: string;

  readonly type: NotificationType;
  readonly channel: NotificationChannel;

  /**
   * L'instant d'envoi voulu, en UTC — le rappel J-1 est planifié, pas immédiat.
   * `null` pour un message immédiat.
   */
  readonly scheduledFor: Date | null;
}

/** Une ligne de `notifications`, réduite à ce dont le domaine a besoin. */
export interface NotificationRecord {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly recipientUserId: string | null;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly dedupeKey: string;
  readonly providerMessageId: string | null;
  readonly attemptCount: number;
}

/**
 * Le résultat d'une tentative de réservation de l'envoi.
 *
 * Deux issues, et la distinction est tout le ticket : ou bien cette livraison-ci
 * détient le droit d'appeler le fournisseur, ou bien une autre l'a déjà fait — et
 * il n'y a alors **rien** à envoyer.
 */
export type NotificationClaim =
  | {
      readonly outcome: 'claimed';
      /** La ligne réservée, en `PENDING`. C'est elle qu'il faudra clore. */
      readonly notification: NotificationRecord;
    }
  | {
      readonly outcome: 'already-live';
      /**
       * L'identifiant de la ligne vivante qui occupe la place, quand le dépôt a
       * pu la relire. `null` si elle a disparu entre le refus de la base et la
       * relecture — un rejeu sans conséquence, mais qu'on ne prétend pas
       * documenter.
       */
      readonly notificationId: string | null;
    };

/**
 * Ce qu'une expédition a produit.
 *
 * `skipped` n'est pas un échec : c'est le rejeu faisant exactement ce qu'on
 * attend de lui.
 */
export type DispatchOutcome = 'sent' | 'skipped';

/**
 * La clé de déduplication canonique d'un message rattaché à un rendez-vous.
 *
 * Déterministe, et c'est ce qui compte : deux publications du même rappel — la
 * même heure de balayage rejouée, la même Lambda relancée — composent la même
 * chaîne, donc entrent en conflit sur `(tenant_id, dedupe_key)` au lieu de
 * s'ignorer.
 *
 * Elle ne porte **pas** le tenant : la colonne est déjà dans l'unique, et l'y
 * recopier n'ajouterait rien qu'une occasion de divergence.
 */
export function appointmentDedupeKey(
  appointmentId: string,
  type: NotificationType,
  channel: NotificationChannel,
): string {
  return `appointment:${appointmentId}:${type}:${channel}`;
}
