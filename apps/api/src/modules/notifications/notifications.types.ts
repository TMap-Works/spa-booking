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
   * L'établissement concerné — la **seule** chose qui ne se relit pas.
   *
   * Tout le reste de ce module lit la base par le client scopé, lequel exige une
   * portée de tenant ouverte. Un message de file n'en hérite d'aucune : il est
   * consommé hors de toute requête HTTP, par une Lambda qui n'a ni jeton ni
   * `AsyncLocalStorage` à reprendre. Sans ce champ, le consommateur n'aurait
   * qu'un choix — deviner le tenant par une lecture **non scopée** du
   * rendez-vous —, c'est-à-dire ouvrir dans la chaîne d'envoi exactement le genre
   * de chemin que tenant-isolation §3 cherche à supprimer.
   *
   * C'est le raisonnement que `AppointmentCreatedEvent` tient déjà mot pour mot :
   * il porte `tenantId` « précisément » parce que « le jour où l'événement
   * viendra d'une file, il n'y aura plus aucune requête ni aucun
   * `AsyncLocalStorage` à hériter ». Ce jour-là est celui du rappel J-1 (#71),
   * qui est le premier message réellement publié sur SQS.
   *
   * Il n'entre pas dans `dedupeKey` pour autant : la colonne `tenant_id` est déjà
   * dans les deux uniques de la table, et l'y recopier n'ajouterait qu'une
   * occasion de divergence.
   */
  readonly tenantId: string;

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

/**
 * Un rendez-vous que le balayage horaire a retenu pour son rappel J-1 (#71).
 *
 * C'est la **vue du producteur**, et elle ne ressemble pas par hasard à
 * `AppointmentCreatedEvent` : les deux désignent un rendez-vous et sa cliente
 * sans rien porter qui puisse dériver. Ni nom, ni adresse, ni numéro —
 * `hasEmail` et `hasSms` sont ce qui reste d'une coordonnée une fois qu'on lui a
 * demandé la seule chose dont le choix des canaux ait besoin : existe-t-elle, et
 * est-elle composable (notifications §7).
 *
 * `tenantId` y figure — contrairement à tout le reste du module — parce que le
 * balayage est le seul traitement inter-tenant de la chaîne : il ouvre une
 * portée de tenant par établissement, et il lui faut donc le nommer.
 */
export interface DueReminder {
  readonly tenantId: string;
  readonly appointmentId: string;
  /** Le compte destinataire du rappel — la cliente du rendez-vous. */
  readonly clientId: string;
  /** Début de la ligne d'agenda, en UTC. Sert à composer `scheduledFor`. */
  readonly startsAt: Date;
  readonly hasEmail: boolean;
  readonly hasSms: boolean;
  /**
   * Les canaux qu'un rappel **vivant** couvre déjà — vide au premier balayage.
   *
   * La couverture se compte par canal, jamais par rendez-vous : un balayage
   * rejoué après une publication partielle trouverait sinon le rappel e-mail
   * déjà pris et en conclurait, à tort, que le SMS l'est aussi. Le canal
   * manquant ne serait alors republié par personne — la fenêtre suivante ne
   * couvre plus ce rendez-vous.
   */
  readonly liveChannels: readonly NotificationChannel[];
}

/**
 * Ce qu'il faut savoir d'un rendez-vous **au moment d'envoyer** son rappel.
 *
 * Deux champs, et deux critères d'acceptation de #71 : le statut répond à « ce
 * rendez-vous existe-t-il encore ? », l'heure de début à « le rappel est-il
 * encore à l'heure ? ». Le verdict, lui, appartient à `reminder-window.ts` et à
 * `appointment-status.ts` — cette structure ne fait que porter la lecture.
 */
export interface ReminderEligibility {
  /** Statut du rendez-vous, tel que `AppointmentStatus` le nomme. */
  readonly status: string;
  /** Début de la ligne d'agenda, en UTC — jamais une heure locale. */
  readonly startsAt: Date;
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
 * Ce que le back-office lit d'un envoi — la trace, jamais le message.
 *
 * Ni `dedupeKey` ni `providerMessageId` : la première est une mécanique interne
 * d'idempotence, la seconde une référence AWS qui n'apprend rien à l'écran du
 * salon. Ce qu'une personne au comptoir a besoin de savoir tient dans « quel
 * message, sur quel canal, parti ou non, quand, et sinon pourquoi ».
 *
 * Aucune coordonnée non plus, pour la raison qui vaut dans tout ce fichier : la
 * table n'en contient pas, et cette projection ne pourrait donc pas en produire.
 */
export interface NotificationTrace {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly recipientUserId: string | null;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly scheduledFor: Date | null;
  readonly sentAt: Date | null;
  readonly attemptCount: number;
  readonly failureReason: string | null;
  readonly createdAt: Date;
}

/** Les filtres du journal d'envois du back-office — tous facultatifs. */
export interface NotificationListQuery {
  readonly appointmentId?: string;
  readonly type?: NotificationType;
  readonly channel?: NotificationChannel;
  readonly statuses?: readonly NotificationStatus[];
  /** Plafond de lignes rendues. Le service en impose un ; il n'est pas optionnel ici. */
  readonly limit: number;
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

/**
 * `true` si ce numéro est composable par SNS — donc si le canal SMS existe.
 *
 * ## Pourquoi E.164 strict, et pourquoi ici
 *
 * notifications §5 l'impose : « numéros au format E.164 strict (`+261...`).
 * Normaliser à la saisie, refuser ce qui n'est pas normalisable ». Un `06 12 34
 * 56 78` n'a pas de sens pour SNS, qui ne connaît pas le pays d'où il est
 * composé ; l'envoyer tel quel produit un échec permanent, facturé, et une
 * ligne `FAILED` qui laisse croire à une panne.
 *
 * La colonne `users.phone` est une chaîne libre de 32 caractères : rien au
 * schéma ne garantit la forme. C'est donc au moment de choisir le canal qu'on
 * tranche, et le refus est silencieux — la cliente reçoit son e-mail, qui porte
 * la confirmation complète.
 *
 * Les espaces, points et tirets sont tolérés à la lecture puis retirés : ils
 * sont fréquents à la saisie et n'altèrent pas le numéro. Tout le reste — les
 * préfixes `00`, les parenthèses d'indicatif, un numéro national nu — est
 * refusé, faute de savoir de quel pays le compléter.
 *
 * `null` et chaîne vide rendent `false` : il n'y a pas de numéro.
 */
export function isDialableNumber(phone: string | null): boolean {
  if (phone === null) {
    return false;
  }

  return /^\+[1-9][0-9]{7,14}$/.test(phone.replaceAll(/[\s.-]/g, ''));
}

/**
 * Tout ce qu'un message rattaché à un rendez-vous a besoin de dire.
 *
 * C'est la **seule** structure du module qui porte des données personnelles, et
 * c'est assumé : un e-mail de confirmation qui n'aurait ni le nom de la cliente
 * ni celui de sa prestation ne serait pas une confirmation. La règle du module
 * n'est pas « aucune donnée personnelle nulle part », elle est « aucune donnée
 * personnelle **qui persiste** » — ni en base, ni dans un message de file, ni
 * dans un journal (CDC §5.1, notifications §7). Celle-ci ne fait que traverser :
 * elle est relue à chaque tentative, juste avant l'appel au fournisseur, et rien
 * n'en est conservé.
 *
 * D'où le fait qu'elle soit **relue** et non transportée : une confirmation
 * rejouée une heure plus tard par SQS doit annoncer le rendez-vous tel qu'il est
 * alors, pas tel qu'il était à la publication.
 */
export interface AppointmentMessageContext {
  /** Nom commercial de l'établissement, tel qu'il signe le message. */
  readonly tenantName: string;
  /** Le slug, qui compose le lien d'annulation. */
  readonly tenantSlug: string;
  /** Fuseau IANA de l'établissement — l'heure s'affiche dedans, jamais en UTC. */
  readonly tenantTimeZone: string;
  readonly tenantAddress: string | null;
  readonly tenantPhone: string | null;

  readonly clientFirstName: string;
  readonly clientLastName: string;

  /**
   * Ni adresse ni numéro : le contexte sert à **composer** un message, pas à
   * l'adresser. C'est l'expéditeur qui relit la coordonnée sur le compte
   * désigné, au moment d'appeler le fournisseur (`NotificationSendRequest`,
   * notifications §7) — la faire transiter ici la sortirait de la base pour
   * rien, et une donnée personnelle qu'on ne lit pas est une donnée qu'on
   * finit par recopier.
   */

  readonly serviceName: string;
  readonly staffName: string;

  /**
   * Début du **soin**, en UTC — l'intervalle facturé, tampons exclus, et non la
   * ligne d'agenda. Converti au fuseau du salon pour l'affichage.
   */
  readonly startsAt: Date;
  /** Fin du soin, en UTC — début + durée de la prestation, ménage exclu. */
  readonly endsAt: Date;

  /** Prix, entier dans la plus petite unité — jamais un flottant. */
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
}

/**
 * Un message rendu, prêt à partir — la sortie des modèles.
 *
 * Trois représentations plutôt que deux : `subject` et `html` ne servent qu'à
 * l'e-mail, `text` sert de version texte brut à côté du HTML **et** de corps de
 * SMS. Fournir systématiquement le texte n'est pas une commodité : un e-mail
 * qui n'a que du HTML est pénalisé par les filtres anti-spam (notifications §6),
 * et le rappel J-1 perd son intérêt s'il finit en indésirables.
 */
export interface RenderedNotification {
  /** Objet de l'e-mail. Ignoré sur le canal SMS. */
  readonly subject: string;
  /** Corps HTML, variables échappées. Ignoré sur le canal SMS. */
  readonly html: string;
  /** Version texte brut — doublon de l'e-mail, corps du SMS. */
  readonly text: string;
}
