import { DEFAULT_LOCALE, type Locale } from '@spa/shared';

import { getTenantId } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { NotificationRenderer } from '../notification-renderer';
import type {
  NotificationReceipt,
  NotificationSender,
  NotificationSendRequest,
} from '../notification-sender';
import type { NotificationTemplatesRepository } from '../notification-templates.repository';
import type { NotificationsRepository } from '../notifications.repository';
import {
  LIVE_NOTIFICATION_STATUSES,
  type NotificationChannel,
  type NotificationClaim,
  type NotificationListQuery,
  type NotificationMessage,
  type NotificationRecord,
  type NotificationStatus,
  type NotificationTemplateSource,
  type NotificationTrace,
  type NotificationType,
  type ReminderEligibility,
  type RenderedNotification,
  type StoredNotificationTemplate,
} from '../notifications.types';
import { REMINDER_LEAD_MS, REMINDER_WINDOW_MS } from '../reminder-window';

/**
 * Doubles du module `notifications`.
 *
 * ## Ce qui est doublé, et ce qui ne l'est pas
 *
 * Le **dépôt** et l'**expéditeur**, parce que l'un parle à Prisma et l'autre à
 * AWS. Le service, lui, est exercé pour de vrai : c'est son ordre d'écriture qui
 * est l'objet du ticket, et le doubler reviendrait à tester le double.
 *
 * ## Pourquoi le dépôt doublé rejoue les deux uniques
 *
 * Un double qui se contenterait de rendre « déjà traité » quand on le lui
 * demande ne prouverait rien : il ferait passer le test quelle que soit la
 * conduite du service. Celui-ci tient une table en mémoire et y **refuse** les
 * doublons selon les deux mêmes règles que PostgreSQL :
 *
 * - `(tenant_id, dedupe_key)` — total, tous statuts confondus ;
 * - `notifications_live_once` — partiel, `PENDING` et `SENT` seulement, et
 *   porteur du **destinataire** depuis #534.
 *
 * Le tenant n'y figure pas : l'extension de scoping le pose en amont, et une
 * suite unitaire tourne dans un seul établissement. Ce que le double reproduit,
 * ce sont les **règles d'unicité**, pas le scoping — qui a ses propres suites.
 *
 * Ce que ce double ne prouve pas, et qui n'est prouvable que contre un vrai
 * moteur : que l'index existe réellement en base. C'est
 * `notifications.migration.spec.ts` qui relit le SQL, et la CI qui l'applique.
 */

/** Journal muet qui retient ce qu'on lui a dit. */
export interface RecordingLogger {
  readonly logger: StructuredLogger;
  readonly entries: { level: string; message: string; meta: unknown }[];
}

export function recordingLogger(): RecordingLogger {
  const entries: { level: string; message: string; meta: unknown }[] = [];

  const record =
    (level: string) =>
    (message: unknown, meta?: unknown): void => {
      entries.push({ level, message: String(message), meta });
    };

  const logger = {
    log: record('log'),
    debug: record('debug'),
    verbose: record('verbose'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as StructuredLogger;

  return { logger, entries };
}

/** Une ligne de `notifications`, telle que le double la tient. */
interface FakeRow {
  id: string;
  appointmentId: string | null;
  recipientUserId: string | null;
  type: NotificationRecord['type'];
  channel: NotificationRecord['channel'];
  status: NotificationStatus;
  /**
   * La langue dans laquelle le message est parti — #854.
   *
   * Portée par la ligne, et non déduite : le double doit pouvoir montrer qu'une
   * reprise `FAILED → PENDING` réécrit la langue plutôt que de garder celle de
   * la tentative précédente, ce qu'un champ calculé aurait masqué.
   */
  locale: Locale;
  dedupeKey: string;
  providerMessageId: string | null;
  attemptCount: number;
  failureReason: string | null;
  sentAt: Date | null;
}

const LIVE: ReadonlySet<string> = new Set(LIVE_NOTIFICATION_STATUSES);

export interface FakeNotificationsRepository {
  readonly repository: NotificationsRepository;
  /** L'état de la table, pour asserter dessus. */
  readonly rows: FakeRow[];
  /**
   * Les canaux joignables du destinataire, que la suite règle à sa guise.
   *
   * `null` fait disparaître le compte — le cas où l'établissement du contexte
   * n'est pas celui de la cliente, que le client scopé traite comme une absence.
   */
  contact: { hasEmail: boolean; hasSms: boolean } | null;
  /**
   * Ce que la relecture d'éligibilité du rappel J-1 trouve (#71).
   *
   * Par défaut un rendez-vous confirmé, situé **au milieu** de la fenêtre de
   * rappel : les suites qui ne parlent pas de la revérification n'ont ainsi rien
   * à régler, et celles qui en parlent posent l'état qu'elles veulent éprouver.
   * `null` fait disparaître le rendez-vous.
   */
  reminder: ReminderEligibility | null;
  /**
   * L'adresse du destinataire est-elle en liste de suppression ? (#73)
   *
   * `false` par défaut, qui est l'état de l'immense majorité des adresses : les
   * suites qui ne parlent pas de suppression n'ont ainsi rien à régler, et
   * celles qui en parlent posent l'état qu'elles veulent éprouver.
   *
   * Distinct de `contact.hasEmail`, et ce n'est pas une redite : le premier est
   * ce que le **producteur** consulte pour composer ses enveloppes, celui-ci ce
   * que l'**expédition** relit juste avant d'appeler le fournisseur. Le double
   * les tient séparés parce que le service les appelle à deux instants
   * différents, et que tout l'intérêt de la seconde lecture est de pouvoir dire
   * autre chose que la première.
   */
  emailSuppressed: boolean;
  /**
   * La coordonnée que l'**expéditeur** relit juste avant d'appeler SES ou SNS
   * (#799).
   *
   * Distincte de `contact`, et la distinction est tout l'intérêt : `contact` est
   * ce que le **producteur** consulte pour décider des canaux — deux booléens,
   * aucune donnée personnelle — là où celle-ci est la seule lecture du module
   * qui rende une adresse et un numéro. Les tenir séparés permet à une suite de
   * poser ce qu'aucune requête réelle ne montrerait autrement : un compte
   * joignable à la publication dont le numéro est devenu illisible à l'envoi.
   *
   * `null` fait disparaître le compte — anonymisé, ou d'un autre établissement,
   * ce que le client scopé traite de la même façon.
   */
  address: { email: string; phone: string | null } | null;
  /**
   * Le compte du praticien du rendez-vous — #72.
   *
   * `null` fait disparaître la ligne `staff`, ce que le client scopé produit
   * aussi pour un praticien d'un autre établissement : dans les deux cas il n'y
   * a personne à prévenir, et rien à divulguer.
   */
  staffUserId: string | null;
  /**
   * L'erreur que la lecture du praticien lève, quand la suite en pose une.
   *
   * `null` par défaut — la base répond. Distinct de `staffUserId: null`, et la
   * distinction est tout l'intérêt : l'absence est un fait métier, la panne est
   * un accident. Les deux doivent coûter le même prix — le praticien, et lui
   * seul.
   */
  staffLookupError: Error | null;
  /**
   * La langue que `resolveRecipientLocale` rend — #854.
   *
   * Une valeur, et non une fonction du compte : les suites qui éprouvent la
   * langue d'un envoi la posent avant l'appel, là où la **règle** de résolution
   * elle-même — préférence du compte, sinon établissement — se prouve en
   * intégration, contre une vraie base.
   */
  recipientLocale: Locale;
  /**
   * Les comptes sur lesquels la langue a été résolue, dans l'ordre.
   *
   * En lecture seule : c'est un constat du double, pas un réglage. C'est lui qui
   * prouve le sixième critère — une résolution a bien lieu à chaque expédition,
   * y compris sur un rappel J-1 dont l'enveloppe ne porte aucune langue.
   */
  readonly localeLookups: readonly string[];
}

function toRecord(row: FakeRow): NotificationRecord {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    recipientUserId: row.recipientUserId,
    type: row.type,
    channel: row.channel,
    status: row.status,
    locale: row.locale,
    dedupeKey: row.dedupeKey,
    providerMessageId: row.providerMessageId,
    attemptCount: row.attemptCount,
  };
}

export function fakeNotificationsRepository(): FakeNotificationsRepository {
  const rows: FakeRow[] = [];
  let sequence = 0;

  /**
   * La ligne vivante qui occupe la place, au sens de `notifications_live_once`.
   *
   * Le destinataire est dans la clé depuis #534
   * (`20260908120000_notification_live_once_per_recipient`) : sans lui ici, le
   * double refuserait l'avis d'annulation du praticien après celui de la
   * cliente, et une suite qui prouve que les deux partent passerait au vert en
   * prouvant le contraire de ce que la base fait.
   */
  const liveFor = (message: NotificationMessage): FakeRow | undefined =>
    rows.find(
      (row) =>
        row.appointmentId === message.appointmentId &&
        row.recipientUserId === message.recipientUserId &&
        row.type === message.type &&
        row.channel === message.channel &&
        LIVE.has(row.status),
    );

  const claim = (message: NotificationMessage, locale: Locale): Promise<NotificationClaim> => {
    const live = liveFor(message);
    if (live !== undefined) {
      return Promise.resolve({ outcome: 'already-live', notificationId: live.id });
    }

    // L'unique **total** sur la clé de livraison. La place est libre — aucune
    // ligne vivante — mais la clé peut être prise par une tentative échouée :
    // c'est alors une reprise, `FAILED → PENDING`, et non une insertion.
    const previous = rows.find((row) => row.dedupeKey === message.dedupeKey);
    if (previous !== undefined) {
      if (previous.status !== 'FAILED') {
        return Promise.resolve({ outcome: 'already-live', notificationId: previous.id });
      }
      previous.status = 'PENDING';
      previous.attemptCount += 1;
      previous.failureReason = null;
      // La reprise réécrit la langue, comme le fait l'`update` de la vraie
      // requête : la décision se prend à l'envoi, et une seconde tentative est
      // un second envoi. Garder celle de la tentative ratée aurait figé une
      // préférence que la cliente a pu changer entre les deux.
      previous.locale = locale;
      return Promise.resolve({ outcome: 'claimed', notification: toRecord(previous) });
    }

    sequence += 1;
    const row: FakeRow = {
      id: `notification-${sequence}`,
      appointmentId: message.appointmentId,
      recipientUserId: message.recipientUserId,
      type: message.type,
      channel: message.channel,
      status: 'PENDING',
      locale,
      dedupeKey: message.dedupeKey,
      providerMessageId: null,
      attemptCount: 1,
      failureReason: null,
      sentAt: null,
    };
    rows.push(row);

    return Promise.resolve({ outcome: 'claimed', notification: toRecord(row) });
  };

  const markSent = (notificationId: string, providerMessageId: string): Promise<boolean> => {
    const row = rows.find((candidate) => candidate.id === notificationId);
    if (row === undefined || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    row.status = 'SENT';
    row.providerMessageId = providerMessageId;
    row.sentAt = new Date();
    return Promise.resolve(true);
  };

  const markFailed = (notificationId: string, reason: string): Promise<boolean> => {
    const row = rows.find((candidate) => candidate.id === notificationId);
    if (row === undefined || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    row.status = 'FAILED';
    row.failureReason = reason.slice(0, 500);
    return Promise.resolve(true);
  };

  const state: {
    contact: { hasEmail: boolean; hasSms: boolean } | null;
    address: { email: string; phone: string | null } | null;
    reminder: ReminderEligibility | null;
    emailSuppressed: boolean;
    staffUserId: string | null;
    staffLookupError: Error | null;
    recipientLocale: Locale;
    localeLookups: string[];
  } = {
    contact: { hasEmail: true, hasSms: true },
    // La langue que la résolution rend, et la trace des comptes sur lesquels on
    // l'a interrogée — #854. La trace est ce qui permet à une suite de prouver
    // que la langue est lue **à l'envoi** : un rappel J-1 dont l'enveloppe ne
    // porte rien doit s'y présenter, et une reprise doit s'y présenter deux fois.
    recipientLocale: DEFAULT_LOCALE,
    localeLookups: [],
    // Une adresse et un numéro composable, cohérents avec le `contact` par
    // défaut : les suites qui ne parlent pas de coordonnées n'ont rien à régler.
    address: { email: 'cliente@example.test', phone: '+261341234567' },
    emailSuppressed: false,
    staffUserId: 'staff-user',
    staffLookupError: null,
    // Au milieu de la fenêtre : `reminderTiming` rendra `due` quel que soit le
    // temps que la suite met à s'exécuter.
    reminder: {
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + REMINDER_LEAD_MS + REMINDER_WINDOW_MS / 2),
    },
  };

  const findRecipientContact = (): Promise<{ hasEmail: boolean; hasSms: boolean } | null> =>
    Promise.resolve(state.contact);

  const findRecipientAddress = (): Promise<{ email: string; phone: string | null } | null> =>
    Promise.resolve(state.address);

  const findReminderEligibility = (): Promise<ReminderEligibility | null> =>
    Promise.resolve(state.reminder);

  const isEmailSuppressed = (): Promise<boolean> => Promise.resolve(state.emailSuppressed);

  const findStaffRecipient = (): Promise<string | null> =>
    state.staffLookupError === null
      ? Promise.resolve(state.staffUserId)
      : Promise.reject(state.staffLookupError);

  const resolveRecipientLocale = (userId: string): Promise<Locale> => {
    state.localeLookups.push(userId);
    return Promise.resolve(state.recipientLocale);
  };

  const repository = {
    claim,
    markSent,
    markFailed,
    findRecipientContact,
    findRecipientAddress,
    findReminderEligibility,
    isEmailSuppressed,
    findStaffRecipient,
    resolveRecipientLocale,
  } as unknown as NotificationsRepository;

  return {
    repository,
    rows,
    get contact() {
      return state.contact;
    },
    set contact(value) {
      state.contact = value;
    },
    get address() {
      return state.address;
    },
    set address(value) {
      state.address = value;
    },
    get reminder() {
      return state.reminder;
    },
    set reminder(value) {
      state.reminder = value;
    },
    get emailSuppressed() {
      return state.emailSuppressed;
    },
    set emailSuppressed(value) {
      state.emailSuppressed = value;
    },
    get staffUserId() {
      return state.staffUserId;
    },
    set staffUserId(value) {
      state.staffUserId = value;
    },
    get staffLookupError() {
      return state.staffLookupError;
    },
    set staffLookupError(value) {
      state.staffLookupError = value;
    },
    get recipientLocale() {
      return state.recipientLocale;
    },
    set recipientLocale(value) {
      state.recipientLocale = value;
    },
    get localeLookups() {
      return state.localeLookups;
    },
  };
}

/** Le contenu que `stubRenderer` rend par défaut. */
export const RENDERED: RenderedNotification = {
  subject: 'objet',
  html: '<p>corps</p>',
  text: 'corps',
};

/**
 * Rendu bouchonné — le contenu est un détail pour les suites qui n'en testent
 * pas la composition.
 *
 * Les modèles eux-mêmes sont des fonctions pures, exercées directement par
 * `notification-content.spec.ts` : les rejouer ici n'apprendrait rien et
 * ferait dépendre l'ordre d'écriture de la mise en forme d'une date.
 *
 * @param outcome le contenu rendu, ou l'erreur à lever — un modèle manquant et
 * un rendez-vous disparu sont deux échecs de rendu que le service doit inscrire
 * en `FAILED` avant de les relever.
 */
export function stubRenderer(outcome: RenderedNotification | Error = RENDERED): {
  readonly renderer: NotificationRenderer;
  readonly calls: NotificationMessage[];
  /**
   * Les langues demandées au rendu, dans l'ordre des appels — #854.
   *
   * Séparée de `calls` plutôt qu'ajoutée dedans : `calls` est typée
   * `NotificationMessage`, et c'est précisément ce que ce ticket ne doit pas
   * changer — l'enveloppe ne porte aucune langue, faute de quoi le rappel J-1 la
   * figerait à la planification. La langue est un **argument** du rendu, et le
   * double la relève comme tel.
   */
  readonly locales: Locale[];
} {
  const calls: NotificationMessage[] = [];
  const locales: Locale[] = [];

  const renderer: NotificationRenderer = {
    render(message: NotificationMessage, locale: Locale): Promise<RenderedNotification> {
      calls.push(message);
      locales.push(locale);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };

  return { renderer, calls, locales };
}

/** Une trace semée dans le double du journal, tenant compris. */
export interface StoredNotification {
  readonly tenantId: string;
  readonly id: string;
  readonly appointmentId: string | null;
  readonly recipientUserId?: string | null;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  /**
   * La langue de l'envoi — facultative dans la graine, obligatoire dans la trace
   * rendue (#854).
   *
   * Facultative ici parce qu'aucune des suites antérieures à ce ticket n'a
   * d'opinion dessus : les faire toutes déclarer une langue pour lire un statut
   * aurait été du bruit. Absente, c'est `DEFAULT_LOCALE` — le même parti que la
   * colonne, qui est `NOT NULL`.
   */
  readonly locale?: Locale;
  readonly sentAt?: Date | null;
  readonly failureReason?: string | null;
  readonly createdAt: Date;
  /**
   * Le **compte** du praticien à qui ce rendez-vous revient — #1200.
   *
   * C'est ce que le prédicat du dépôt traverse en base
   * (`notifications → appointment → staff → userId`) ; le double le porte à plat
   * plutôt que de rejouer deux jointures qu'il n'a pas.
   *
   * Facultatif : une graine qui ne le déclare pas ne relève du périmètre de
   * personne, et sort donc du journal dès qu'une portée `:own` est posée. C'est
   * la conduite sûre — rien, plutôt que le salon entier — et c'est aussi celle
   * que la base tient pour un envoi sans rendez-vous.
   */
  readonly staffUserId?: string | null;
}

/**
 * Échec du double quand aucune portée de tenant n'est ouverte.
 *
 * Le pendant de `MissingTenantContextError` de l'extension de scoping : le
 * **défaut fermé** est ce qu'une suite d'isolation doit constater, et un double
 * qui lirait tout en l'absence de portée ferait passer une garde défaillante.
 */
export class FakeMissingTenantContextError extends Error {
  public constructor(operation: string) {
    super(`aucune portée de tenant ouverte pour ${operation}`);
  }
}

/**
 * Le journal d'envois, en mémoire — pour les suites d'intégration et
 * d'isolation de `GET /notifications` (#70).
 *
 * Il reproduit les deux propriétés qui décident du verdict de ces suites :
 *
 * 1. le **filtrage par le vrai contexte de tenant**, celui que l'extension
 *    Prisma consulte. Une garde qui n'ouvrirait pas la portée, ou qui
 *    l'ouvrirait sur le mauvais établissement, fait donc rougir les suites — ce
 *    qu'un double indexé sur un tenant passé en argument n'aurait pas su voir ;
 * 2. le **défaut fermé** — sans portée résolue, aucune lecture.
 *
 * Il reproduit aussi l'ordre (du plus récent au plus ancien) et le plafond,
 * parce que ce sont des promesses du contrat que la suite d'intégration vérifie.
 *
 * Depuis #1200 il reproduit une troisième propriété : la **portée de lecture**,
 * `ownedByUserId`. Un double qui l'ignorerait rendrait le salon entier à un
 * praticien tout en laissant la suite verte — précisément le faux vert qu'une
 * suite d'autorisation ne peut pas se permettre.
 */
export class FakeNotificationsJournal {
  private readonly stored: StoredNotification[] = [];

  /**
   * La dernière requête reçue — ce qui permet à une suite d'affirmer *quelle*
   * portée la route a posée, et pas seulement ce qu'elle a rendu.
   *
   * Utile parce que le harnais signe ses jetons sur un compte tiré au hasard :
   * sans cela, aucune suite ne saurait dire si la liste vide qu'elle observe
   * vient d'une portée correctement bornée ou d'une graine mal posée.
   */
  public lastQuery: NotificationListQuery | null = null;

  public seed(notification: StoredNotification): void {
    this.stored.push(notification);
  }

  public list(query: NotificationListQuery): Promise<readonly NotificationTrace[]> {
    const tenantId = this.requireScope('notification.findMany');

    this.lastQuery = query;

    const matches = this.stored
      .filter((row) => row.tenantId === tenantId)
      // La portée `:own` d'abord : elle ne se surcharge pas d'un filtre de
      // requête, elle les borne tous. Un envoi sans rendez-vous — donc sans
      // praticien — en sort, comme le `is` du prédicat réel l'écarte en base.
      .filter(
        (row) =>
          query.ownedByUserId === null ||
          (row.staffUserId !== undefined &&
            row.staffUserId !== null &&
            row.staffUserId === query.ownedByUserId),
      )
      .filter((row) => query.appointmentId === undefined || row.appointmentId === query.appointmentId)
      .filter((row) => query.type === undefined || row.type === query.type)
      .filter((row) => query.channel === undefined || row.channel === query.channel)
      .filter((row) => query.statuses === undefined || query.statuses.includes(row.status))
      .sort((left, right) => {
        const byDate = right.createdAt.getTime() - left.createdAt.getTime();
        return byDate === 0 ? right.id.localeCompare(left.id) : byDate;
      })
      .slice(0, query.limit)
      .map(
        (row): NotificationTrace => ({
          id: row.id,
          appointmentId: row.appointmentId,
          recipientUserId: row.recipientUserId ?? null,
          type: row.type,
          channel: row.channel,
          status: row.status,
          locale: row.locale ?? DEFAULT_LOCALE,
          scheduledFor: null,
          sentAt: row.sentAt ?? null,
          attemptCount: 1,
          failureReason: row.failureReason ?? null,
          createdAt: row.createdAt,
        }),
      );

    return Promise.resolve(matches);
  }

  /** Hors portée, on échoue plutôt que de lire le journal de tous les salons. */
  private requireScope(operation: string): string {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new FakeMissingTenantContextError(operation);
    }

    return tenantId;
  }
}

/** Expéditeur qui compte ses appels — la mesure du rejeu. */
export interface CountingSender {
  readonly sender: NotificationSender;
  readonly calls: NotificationSendRequest[];
}

/**
 * Ce que rend un appel : une chaîne devient l'accusé du fournisseur, une `Error`
 * est levée telle quelle, et `{ reject }` lève **n'importe quelle valeur** — un
 * pilote AWS ne lève pas toujours une `Error`, et c'est précisément le cas que
 * `describe()` a à traiter sans recopier de charge utile en base.
 */
export type SendBehaviour = string | Error | { readonly reject: unknown };

/** @param behaviour ce que rend chaque appel, dans l'ordre. */
export function countingSender(behaviour: readonly SendBehaviour[] = []): CountingSender {
  const calls: NotificationSendRequest[] = [];

  const sender: NotificationSender = {
    send(request: NotificationSendRequest): Promise<NotificationReceipt> {
      const outcome = behaviour[calls.length] ?? `ses-message-${calls.length + 1}`;
      calls.push(request);

      if (typeof outcome === 'string') {
        return Promise.resolve({ providerMessageId: outcome });
      }
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      return Promise.reject(outcome.reject);
    },
  };

  return { sender, calls };
}

/** Une personnalisation semée dans le double des modèles, tenant compris. */
export interface StoredTemplateRow {
  readonly tenantId: string;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  /**
   * La langue de la personnalisation — #854.
   *
   * **Obligatoire**, et la facultativité a été essayée avant d'être écartée :
   * une graine sans langue retombait sur `DEFAULT_LOCALE`, c'est-à-dire `'en'`
   * (#844), pendant que les suites antérieures au ticket rendaient en `'fr'`.
   * Le double servait alors un modèle de plateforme là où la suite croyait
   * éprouver la personnalisation du salon — un test vert qui ne vérifie plus
   * rien, ce qui est pire qu'un test rouge.
   *
   * La langue étant désormais le quatrième membre de l'unique, une graine qui ne
   * la nomme pas ne désigne aucune ligne : l'exiger n'ajoute pas de cérémonie,
   * elle rend visible une coordonnée qui l'était déjà en base.
   */
  readonly locale: Locale;
  readonly source: NotificationTemplateSource;
  readonly updatedAt?: Date;
}

/**
 * Les modèles par établissement, en mémoire — pour les suites du service, du
 * renderer et des routes de #69.
 *
 * ## Ce qu'il reproduit, et pourquoi cela suffit
 *
 * Deux propriétés, et ce sont celles dont dépendent les verdicts :
 *
 * - le **scoping** : il lit le vrai contexte de tenant, celui que l'extension
 *   Prisma consulte, et **échoue** s'il n'y en a aucun. Un double qui lirait tout
 *   hors portée ferait passer au vert une garde défaillante — c'est le même
 *   défaut fermé que `FakeNotificationsJournal` ;
 * - l'**unicité** `(tenant_id, type, channel, locale)` : `save` remplace la ligne
 *   du quadruplet au lieu d'en empiler une seconde, ce qui est la conduite que
 *   l'`updateMany`-puis-`create` du vrai dépôt produit. La langue y est entrée
 *   avec #854, et c'est ce qui fait qu'écrire l'anglais d'un message ne touche
 *   pas son français.
 *
 * Ce qu'il ne prouve pas — que l'unique existe réellement en base — appartient à
 * `notifications.migration.spec.ts`, qui relit le SQL, et à la CI, qui l'applique.
 */
export class FakeNotificationTemplates {
  private readonly stored: StoredTemplateRow[] = [];

  public seed(row: StoredTemplateRow): void {
    this.stored.push(row);
  }

  public findAll(): Promise<readonly StoredNotificationTemplate[]> {
    const tenantId = this.requireScope('notificationTemplate.findMany');

    return Promise.resolve(
      this.stored
        .filter((row) => row.tenantId === tenantId)
        .sort(
          (left, right) =>
            left.type.localeCompare(right.type) ||
            left.channel.localeCompare(right.channel) ||
            left.locale.localeCompare(right.locale),
        )
        .map((row) => toStoredTemplate(row)),
    );
  }

  public find(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
  ): Promise<StoredNotificationTemplate | null> {
    const tenantId = this.requireScope('notificationTemplate.findFirst');
    const found = this.rowFor(tenantId, type, channel, locale);

    return Promise.resolve(found === undefined ? null : toStoredTemplate(found));
  }

  public save(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
    source: NotificationTemplateSource,
  ): Promise<StoredNotificationTemplate> {
    const tenantId = this.requireScope('notificationTemplate.save');
    const existing = this.rowFor(tenantId, type, channel, locale);

    if (existing !== undefined) {
      this.stored.splice(this.stored.indexOf(existing), 1);
    }

    const row: StoredTemplateRow = {
      tenantId,
      type,
      channel,
      locale,
      source,
      updatedAt: new Date(),
    };
    this.stored.push(row);

    return Promise.resolve(toStoredTemplate(row));
  }

  public remove(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
  ): Promise<boolean> {
    const tenantId = this.requireScope('notificationTemplate.deleteMany');
    const existing = this.rowFor(tenantId, type, channel, locale);

    if (existing === undefined) {
      return Promise.resolve(false);
    }

    this.stored.splice(this.stored.indexOf(existing), 1);

    return Promise.resolve(true);
  }

  /** Le double, dans la forme que Nest injecte. */
  public get repository(): NotificationTemplatesRepository {
    return this as unknown as NotificationTemplatesRepository;
  }

  private rowFor(
    tenantId: string,
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
  ): StoredTemplateRow | undefined {
    return this.stored.find(
      (row) =>
        row.tenantId === tenantId &&
        row.type === type &&
        row.channel === channel &&
        row.locale === locale,
    );
  }

  /** Hors portée, on échoue plutôt que de lire les modèles de tous les salons. */
  private requireScope(operation: string): string {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new FakeMissingTenantContextError(operation);
    }

    return tenantId;
  }
}

function toStoredTemplate(row: StoredTemplateRow): StoredNotificationTemplate {
  return {
    type: row.type,
    channel: row.channel,
    locale: row.locale,
    source: row.source,
    updatedAt: row.updatedAt ?? new Date('2026-09-07T10:00:00Z'),
  };
}
