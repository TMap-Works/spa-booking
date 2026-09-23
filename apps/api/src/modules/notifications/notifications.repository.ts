import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@spa/shared';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type { AppointmentCancelledBy } from '../appointments/appointment-status';
import {
  LIVE_NOTIFICATION_STATUSES,
  isDialableNumber,
  type AppointmentMessageContext,
  type NotificationClaim,
  type NotificationListQuery,
  type NotificationMessage,
  type NotificationRecord,
  type NotificationTrace,
  type PasswordResetMessageContext,
  type ReminderEligibility,
} from './notifications.types';

/**
 * Accès Prisma du module `notifications` — le seul fichier qui connaisse le
 * schéma (api-module §2).
 *
 * ## Ce qu'il porte, et qui n'est pas de la plomberie
 *
 * `claim()` est l'unique raison d'être de ce fichier. Ce n'est pas une écriture :
 * c'est une **prise de droit**. Elle répond à « ai-je le droit d'appeler SES pour
 * ce message-là ? », et sa réponse est celle de PostgreSQL, pas la nôtre.
 *
 * SQS garantit au-moins-une-fois. Deux consommateurs peuvent donc traiter le
 * même message **en même temps**, et la conduite naïve — « existe-t-il déjà une
 * notification ? sinon, en créer une » — est structurellement fausse sous
 * concurrence : les deux lectures répondent non, les deux insertions passent, la
 * cliente reçoit deux SMS. C'est le même défaut que la vérification applicative
 * de disponibilité qu'ADR 0002 interdit au moteur de réservation, et il se règle
 * de la même façon : la base tranche, le code traduit.
 *
 * L'insertion **est** donc le verrou. Deux livraisons concurrentes se sérialisent
 * sur `notifications_live_once` — l'index unique partiel posé par
 * `20260906120000_add_notification_idempotency` : la première valide, la seconde
 * est refusée en `P2002`. Aucune fenêtre entre une lecture et une écriture, parce
 * qu'il n'y a pas de lecture.
 *
 * ## Pourquoi un `create` sous `try`, ici, alors que `payments` s'y refuse
 *
 * `stripe-webhook.repository.ts` emploie `createMany({ skipDuplicates })` et
 * explique pourquoi : un `INSERT` en conflit avorte la **transaction**
 * PostgreSQL entière, et tout ce qui la suivrait échouerait sur « current
 * transaction is aborted ».
 *
 * L'argument ne s'applique pas ici, et c'est structurel : cette prise de droit
 * n'est **pas** dans une transaction, et ne peut pas l'être. Ce qui la suit est
 * un appel réseau à SES ou SNS, qu'aucune transaction de base ne saurait
 * englober — la tenir ouverte pendant un appel fournisseur immobiliserait une
 * connexion du pool pour la durée d'un aller-retour AWS. Le `create` sous `try`
 * est donc lisible et sans effet de bord, et il rend la ligne créée, ce que
 * `createMany` ne fait pas.
 *
 * ## La reprise après échec, et pourquoi elle est une mise à jour
 *
 * Un envoi `FAILED` sort de `notifications_live_once` : la place est libre
 * (notifications §4). Mais `(tenant_id, dedupe_key)`, lui, couvre tous les
 * statuts — la seconde insertion serait donc refusée. La reprise est par
 * conséquent une **transition** `FAILED → PENDING` sur la ligne existante, et
 * c'est aussi la seule forme qui donne un sens à `attempt_count` : un compteur
 * qui repartirait de zéro à chaque essai ne compterait rien.
 *
 * La transition est un test-et-pose atomique (`WHERE status = 'FAILED'`), pour la
 * même raison que tout le reste de ce fichier : deux reprises concurrentes ne
 * doivent pas ranimer deux fois la même ligne.
 *
 * ## Ce qu'il n'écrit pas
 *
 * Aucune coordonnée, aucun contenu de message. La table désigne un compte
 * destinataire ; l'adresse se relit dessus au moment de l'envoi, et le journal ne
 * garde que l'identifiant de la notification et celui du fournisseur
 * (CDC §5.1, notifications §7).
 */

/** Code Prisma d'une violation d'unicité — `23505` côté PostgreSQL. */
const UNIQUE_VIOLATION = 'P2002';

/** Largeur de `notifications.failure_reason`, telle que le schéma la déclare. */
const FAILURE_REASON_MAX_LENGTH = 500;

/** Une minute en millisecondes — les tampons d'une prestation sont en minutes. */
const MINUTE_MS = 60_000;

/**
 * `true` si l'écriture a été refusée par un des deux uniques de la table.
 *
 * Volontairement **indifférent à celui qui a refusé**. Distinguer
 * `notifications_live_once` de `notifications_tenant_id_dedupe_key_key` par le
 * `meta` de Prisma serait fragile — le connecteur y range tantôt le nom de
 * l'index, tantôt la liste des champs — et surtout inutile : la conduite qui suit
 * est la même dans les deux cas, et c'est la relecture qui établit laquelle des
 * deux situations on tient. Le seul fait qui compte ici est « la base a refusé le
 * doublon », et il est acquis.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/**
 * Les colonnes par lesquelles `notifications_live_once` identifie un message —
 * en un seul endroit, parce que deux endroits finiraient par diverger.
 *
 * ## Pourquoi cette fonction existe
 *
 * Deux lectures s'en servent, et toutes deux se déclenchent **après** un refus
 * de la base : `resolveRefusal` cherche la ligne vivante qui occupe la place,
 * `findReclaimable` cherche la ligne échouée qui l'occupait. L'une comme l'autre
 * doivent regarder par les mêmes colonnes que l'index, faute de quoi le dépôt et
 * le moteur ne diraient plus la même chose — et le désaccord se manifesterait
 * de la pire façon : un message tenu pour un doublon, acquitté auprès de SQS,
 * jamais parti.
 *
 * ## Le destinataire en fait partie depuis #534
 *
 * L'index le porte, en queue de ses colonnes. Sans lui ici, `resolveRefusal`
 * trouverait l'avis d'annulation de la cliente en cherchant celui du praticien —
 * ils partagent l'établissement, le rendez-vous, le type et le canal — et
 * rendrait `already-live` sur un message que la base venait d'accepter.
 *
 * ## `null` se cherche par `IS NULL`, et cela coïncide avec le `COALESCE`
 *
 * Prisma traduit `recipientUserId: null` en `recipient_user_id IS NULL`, là où
 * l'index compare `COALESCE(recipient_user_id, '000…0')`. Les deux désignent
 * exactement les mêmes lignes : le sentinelle est l'UUID nul, qu'aucune ligne de
 * `users` ne porte — `uuid()` produit une v4, dont le 13ᵉ chiffre hexadécimal
 * vaut toujours `4`.
 */
function liveIdentity(
  message: NotificationMessage,
): Pick<Prisma.NotificationWhereInput, 'appointmentId' | 'recipientUserId' | 'type' | 'channel'> {
  return {
    appointmentId: message.appointmentId,
    recipientUserId: message.recipientUserId,
    type: message.type,
    channel: message.channel,
  };
}

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `payments.repository.ts` et
 * `appointments.repository.ts` : le type généré exige `tenantId` — la colonne est
 * `NOT NULL` — alors que le repository ne doit justement pas le fournir. C'est
 * l'extension de scoping qui le pose depuis le contexte, et qui écrase ce qui s'y
 * trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * La projection lue par ce dépôt — et rien de plus.
 *
 * `tenant_id` n'en fait pas partie : le domaine n'en a pas l'usage, et ce qui ne
 * sort pas ne peut pas fuiter (tenant-isolation §4).
 */
const NOTIFICATION_SELECT = {
  id: true,
  appointmentId: true,
  recipientUserId: true,
  type: true,
  channel: true,
  status: true,
  locale: true,
  dedupeKey: true,
  providerMessageId: true,
  attemptCount: true,
} as const;

interface NotificationRow {
  id: string;
  appointmentId: string | null;
  recipientUserId: string | null;
  type: string;
  channel: string;
  status: string;
  locale: string;
  dedupeKey: string;
  providerMessageId: string | null;
  attemptCount: number;
}

/**
 * La projection du journal d'envois — ce que le back-office lit.
 *
 * Plus large que `NOTIFICATION_SELECT` de trois colonnes (`scheduled_for`,
 * `failure_reason`, `created_at`) et plus étroite de deux (`dedupe_key`,
 * `provider_message_id`) : ce sont deux besoins différents, et une projection
 * unique aurait servi au domaine des colonnes dont il n'a que faire, ou à
 * l'écran une mécanique d'idempotence qu'il n'a pas à connaître.
 *
 * `tenant_id` n'y est pas davantage : ce qui ne sort pas ne peut pas fuiter
 * (tenant-isolation §4).
 */
const NOTIFICATION_TRACE_SELECT = {
  id: true,
  appointmentId: true,
  recipientUserId: true,
  type: true,
  channel: true,
  status: true,
  locale: true,
  scheduledFor: true,
  sentAt: true,
  attemptCount: true,
  failureReason: true,
  createdAt: true,
} as const;

interface NotificationTraceRow {
  id: string;
  appointmentId: string | null;
  recipientUserId: string | null;
  type: string;
  channel: string;
  status: string;
  locale: string;
  scheduledFor: Date | null;
  sentAt: Date | null;
  attemptCount: number;
  failureReason: string | null;
  createdAt: Date;
}

/**
 * Le prédicat « les envois de ses rendez-vous à lui », ou rien du tout — #1200.
 *
 * ## Ce qu'il traverse, et pourquoi en une seule requête
 *
 * `notifications` → `appointment` → `staff` → `userId`. Les deux relations sont
 * celles que le schéma déclare, et le filtre s'écrit donc sans jointure
 * explicite ni seconde lecture. Résoudre d'abord la fiche praticien du compte
 * aurait ajouté une requête **et** une lecture de `staff` là où le module n'en
 * a besoin que pour expédier — c'est le parti qu'a pris `crm` en #812
 * (`ownedByPredicate` de `crm.repository.ts`), et il n'y a aucune raison d'en
 * prendre un autre ici.
 *
 * ## `is`, et ce qu'il écarte au passage
 *
 * `appointment` est une relation **facultative** : le journal porte aussi des
 * envois qui n'annoncent aucun rendez-vous — la réinitialisation de mot de passe
 * (#809). `is` ne retient que les lignes dont le rendez-vous existe *et*
 * satisfait le filtre, si bien que ces envois-là sortent du journal d'un
 * praticien. C'est la bonne réponse : ils ne relèvent pas de son périmètre, et
 * ils ne lui apprendraient que le va-et-vient des comptes de ses collègues.
 *
 * ## Aucun `tenantId` ici, et ce n'est pas un oubli
 *
 * L'extension de scoping le pose sur le `where` de la lecture principale, et les
 * clés étrangères composites `(tenant_id, id)` du schéma interdisent qu'une
 * notification d'un salon désigne le rendez-vous d'un autre : la traversée ne
 * peut pas sortir de l'établissement courant (tenant-isolation §1 et §3).
 *
 * ## Tous les statuts comptent, annulations comprises
 *
 * La question à laquelle ce prédicat répond est « cet envoi concerne-t-il un de
 * mes rendez-vous ? », et une annulation ne le retire pas de la journée de qui
 * devait le donner — l'avis d'annulation est précisément l'envoi dont le
 * praticien a besoin de vérifier qu'il est parti.
 */
function ownedByPredicate(userId: string | null): Prisma.NotificationWhereInput {
  if (userId === null) {
    return {};
  }

  return { appointment: { is: { staff: { userId } } } };
}

function toNotificationTrace(row: NotificationTraceRow): NotificationTrace {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    recipientUserId: row.recipientUserId,
    type: row.type as NotificationTrace['type'],
    channel: row.channel as NotificationTrace['channel'],
    status: row.status as NotificationTrace['status'],
    locale: toLocale(row.locale),
    scheduledFor: row.scheduledFor,
    sentAt: row.sentAt,
    attemptCount: row.attemptCount,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    recipientUserId: row.recipientUserId,
    // Les trois énumérations du schéma sont reprises telles quelles : le témoin
    // de `notifications.types.ts` garantit que les libellés coïncident.
    type: row.type as NotificationRecord['type'],
    channel: row.channel as NotificationRecord['channel'],
    status: row.status as NotificationRecord['status'],
    locale: toLocale(row.locale),
    dedupeKey: row.dedupeKey,
    providerMessageId: row.providerMessageId,
    attemptCount: row.attemptCount,
  };
}

/**
 * La langue d'une colonne, ramenée au vocabulaire du contrat — #854.
 *
 * ## Pourquoi un prédicat et non une assertion
 *
 * Les énumérations du schéma sont reprises par assertion (`as`) dans tout ce
 * fichier, et c'est légitime : PostgreSQL ne peut rien y mettre d'autre, un
 * `CREATE TYPE` est une garantie de la base. La langue n'en est pas une — c'est
 * une `VARCHAR(5)` bornée par une contrainte `CHECK`, ce que #844 a délibérément
 * préféré à un type énuméré pour ne pas rouvrir la conversion de casse des rôles
 * (#510).
 *
 * Une contrainte `CHECK` protège tout aussi bien, mais elle ne se lit pas dans le
 * type généré par Prisma : le champ est un `string` nu. Affirmer `as Locale` y
 * serait donc un pari sur une contrainte qu'un `ALTER TABLE` d'exploitation peut
 * lever, et le pari se paierait par un `Intl.DateTimeFormat` levant
 * `RangeError` au milieu d'une expédition. Le repli sur `DEFAULT_LOCALE` fait
 * partir le message dans la langue par défaut du système plutôt que de ne rien
 * envoyer.
 */
function toLocale(value: string): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * L'adresse postale du salon, sur une ligne — ou `null` si elle est incomplète.
 *
 * Les quatre champs sont facultatifs au schéma. Une adresse partielle est
 * rendue telle quelle : « 12 rue des Lilas, Paris » vaut mieux qu'aucune adresse
 * du tout dans une confirmation, et le code postal manquant se voit.
 */
function postalAddress(tenant: {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
}): string | null {
  const parts = [
    tenant.addressLine1,
    tenant.addressLine2,
    [tenant.postalCode, tenant.city].filter((part) => part !== null).join(' '),
  ].filter((part): part is string => part !== null && part.length > 0);

  return parts.length === 0 ? null : parts.join(', ');
}

@Injectable()
export class NotificationsRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * La langue dans laquelle écrire à ce compte — **résolue à l'instant de
   * l'envoi** (#854, deuxième et sixième critères).
   *
   * ## La règle, dans l'ordre
   *
   * La préférence du destinataire (`users.locale`) si son compte en porte une ;
   * la langue de l'établissement (`tenants.default_locale`) sinon. `NULL` sur un
   * compte se lit « aucune préférence enregistrée », jamais « français » — c'est
   * l'invariant que #844 a posé, et c'est lui qui rend la seconde branche
   * atteignable.
   *
   * ## Une seule lecture dans le cas nominal
   *
   * Le défaut de l'établissement est lu **par la jointure**, sur le compte
   * lui-même : la question « quelle langue pour cette personne » n'a pas à coûter
   * deux allers-retours. La seconde lecture ne sert qu'au compte introuvable —
   * anonymisé, ou d'un autre établissement, ce que le client scopé traite de la
   * même façon —, et elle rend alors la langue du salon, qui est la seule chose
   * qu'on sache encore.
   *
   * ## Pourquoi ici, et pourquoi pas dans l'enveloppe
   *
   * Parce qu'« une décision d'envoi se prend à l'envoi », exactement comme
   * l'éligibilité du rappel J-1 et la suppression d'adresse. Entre la
   * planification d'un rappel et sa livraison il y a jusqu'à une heure, une file
   * et cinq réceptions possibles : une cliente qui bascule son compte en anglais
   * dans cet intervalle doit recevoir l'anglais. Figer la langue dans le message
   * SQS aurait rendu ce critère intenable, et c'est pourquoi
   * `NotificationMessage` n'en porte aucune.
   *
   * Rend toujours une langue : sans établissement lisible — cas qui ne se produit
   * pas, la portée de tenant étant ouverte —, c'est `DEFAULT_LOCALE`. Un message
   * part toujours ; il ne reste pas en attente d'une préférence.
   */
  public async resolveRecipientLocale(userId: string): Promise<Locale> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { locale: true, tenant: { select: { defaultLocale: true } } },
    });

    if (user !== null) {
      return user.locale === null ? toLocale(user.tenant.defaultLocale) : toLocale(user.locale);
    }

    const tenant = await this.prisma.tenant.findFirst({ select: { defaultLocale: true } });

    return tenant === null ? DEFAULT_LOCALE : toLocale(tenant.defaultLocale);
  }

  /**
   * Réserve le droit d'envoyer ce message, une fois et une seule.
   *
   * À appeler **dans une portée de tenant déjà résolue** : tout passe par le
   * client scopé, et l'extension refuse la moindre opération sans contexte.
   *
   * Rend `claimed` — l'appelant détient la ligne en `PENDING` et doit la clore —
   * ou `already-live`, auquel cas il n'y a **rien** à envoyer.
   *
   * `locale` est **passée** et non relue : c'est la même valeur qui choisira le
   * modèle, et deux résolutions séparées auraient pu se contredire si la cliente
   * changeait sa préférence entre les deux (#854).
   */
  public async claim(message: NotificationMessage, locale: Locale): Promise<NotificationClaim> {
    try {
      const created = await this.prisma.notification.create({
        data: withScopedTenant<Prisma.NotificationUncheckedCreateInput>({
          appointmentId: message.appointmentId,
          recipientUserId: message.recipientUserId,
          type: message.type,
          channel: message.channel,
          status: 'PENDING',
          locale,
          dedupeKey: message.dedupeKey,
          scheduledFor: message.scheduledFor,
          // La ligne naît à sa première tentative, pas à zéro : elle *est* la
          // tentative en cours, et l'incrément de la reprise part donc de 1.
          attemptCount: 1,
        }),
        select: NOTIFICATION_SELECT,
      });

      return { outcome: 'claimed', notification: toNotificationRecord(created) };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // Hors du `try` : ce qui suit ne doit pas voir ses propres erreurs avalées
    // par le filtre d'unicité posé pour l'insertion.
    return this.resolveRefusal(message, locale);
  }

  /**
   * Le journal d'envois de l'établissement, filtré — la lecture du back-office.
   *
   * Trié du plus récent au plus ancien : la question qu'un comptoir se pose est
   * « qu'est-ce qui vient de partir ? », jamais « qu'est-ce qui est parti en
   * premier ». `id` départage à égalité de `created_at`, faute de quoi deux
   * lignes créées dans la même milliseconde — les deux canaux d'une même
   * confirmation, précisément — s'ordonneraient au gré du planificateur.
   *
   * Le plafond vient du service et n'a pas de défaut ici : une lecture non
   * bornée est un déni de service à une requête sur un établissement actif.
   */
  public async list(query: NotificationListQuery): Promise<readonly NotificationTrace[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        ...(query.appointmentId === undefined ? {} : { appointmentId: query.appointmentId }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.channel === undefined ? {} : { channel: query.channel }),
        ...(query.statuses === undefined ? {} : { status: { in: [...query.statuses] } }),
        ...ownedByPredicate(query.ownedByUserId),
      },
      select: NOTIFICATION_TRACE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });

    return rows.map(toNotificationTrace);
  }

  /**
   * Sur quels canaux ce compte est joignable — sans rendre la moindre
   * coordonnée.
   *
   * Deux booléens, pas une adresse ni un numéro. L'appelant décide des canaux, il
   * n'a besoin de rien d'autre, et ce qui ne sort pas ne peut ni fuiter dans un
   * journal ni finir dans un message de file (notifications §7).
   *
   * Rend `null` si le compte n'existe pas ou appartient à un autre
   * établissement — le client scopé ne fait pas la différence, et c'est bien
   * ainsi.
   */
  public async findRecipientContact(
    userId: string,
  ): Promise<{ hasEmail: boolean; hasSms: boolean } | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { email: true, phone: true, emailSuppressedAt: true },
    });

    if (user === null) {
      return null;
    }

    return {
      // Une adresse supprimée n'est **pas** un canal (#73). C'est le premier des
      // trois endroits où la suppression agit, et le plus en amont : le
      // producteur ne compose alors aucune enveloppe e-mail, si bien qu'aucun
      // message n'est publié, aucune ligne n'est écrite, et rien n'apparaît au
      // journal du back-office comme un envoi qui aurait échoué. Rien ne s'est
      // passé, ce qui est exactement la vérité.
      //
      // `email` reste lu et compté : la colonne est `NOT NULL`, mais une chaîne
      // vide n'est pas une adresse, et les deux refus ne se disent pas
      // autrement l'un que l'autre du point de vue de l'appelant.
      hasEmail: user.email.length > 0 && user.emailSuppressedAt === null,
      hasSms: isDialableNumber(user.phone),
    };
  }

  /**
   * La coordonnée du destinataire — **au moment d'envoyer**, et pour lui seul
   * (#799).
   *
   * ## La seule lecture du module qui rende une donnée personnelle
   *
   * `findRecipientContact` rend deux booléens, `findStaffRecipient` un
   * identifiant, et tout le reste du module désigne ses destinataires par leur
   * compte : c'est la règle de notifications §7 — « une coordonnée ne se recopie
   * pas, sans quoi une demande RGPD devrait l'effacer à deux endroits, et c'est
   * toujours la seconde copie qu'on oublie ».
   *
   * Cette méthode est l'exception qui rend la règle tenable. Il faut bien que
   * l'adresse sorte de la base **une fois**, à l'instant d'appeler SES ou SNS ;
   * ce que la règle interdit, c'est qu'elle sorte plus tôt — dans une enveloppe
   * SQS, dans un contexte de rendu, dans un journal. Elle est donc appelée par
   * l'expéditeur, et par personne d'autre : le message n'en porte rien, et ce
   * qu'elle rend ne persiste nulle part.
   *
   * ## Elle est relue à chaque tentative, jamais mémorisée
   *
   * Un message de file survit à sa file. Une cliente qui corrige son adresse
   * entre la publication et le rejeu doit recevoir sur la nouvelle — et une
   * cliente anonymisée ne doit recevoir sur aucune.
   *
   * Rend `null` si le compte n'existe pas ou appartient à un autre
   * établissement — le client scopé ne fait pas la différence, et c'est bien
   * ainsi (tenant-isolation §4).
   */
  public async findRecipientAddress(
    userId: string,
  ): Promise<{ email: string; phone: string | null } | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { email: true, phone: true },
    });

    return user === null ? null : { email: user.email, phone: user.phone };
  }

  /**
   * Cette adresse a-t-elle cessé d'être sollicitée — **au moment d'envoyer** ?
   * (#73)
   *
   * ## Pourquoi une lecture de plus, alors que `findRecipientContact` le dit déjà
   *
   * Parce que ce n'est pas le même instant. `findRecipientContact` sert le
   * **producteur** : il décide des canaux au moment de composer les enveloppes.
   * Entre cette décision et l'appel à SES il y a une publication SQS, une
   * invocation de Lambda, un appel HTTP, et jusqu'à cinq réceptions avant la file
   * d'attente morte — le rappel J-1 chiffre le même écart à une heure. Un rebond
   * peut tomber pendant cet intervalle, et c'est même le cas le plus probable :
   * un rebond arrive toujours après un envoi, donc en pleine activité de la
   * chaîne.
   *
   * Le critère du ticket dit « n'est plus **jamais** sollicitée ». Un contrôle
   * qui ne serait fait qu'à la publication ne le tiendrait pas — c'est la même
   * raison qui a fait déplacer la revérification du rappel J-1 du producteur vers
   * l'expédition (#71) : une décision d'envoi se prend à l'envoi.
   *
   * ## Ce qu'elle coûte, et à qui
   *
   * Une lecture indexée sur la clé primaire, une colonne, et **seulement sur le
   * canal e-mail** : le SMS n'a pas de suppression à consulter, SES ne dit rien
   * d'un numéro. C'est le même ordre de grandeur que
   * `findReminderEligibility`, et pour un enjeu du même ordre.
   *
   * ## Rend `false` sur un compte introuvable, délibérément
   *
   * Ni `true`, ni une erreur. Un compte disparu — anonymisé, ou d'un autre
   * établissement, ce que le client scopé traite de la même façon — n'est pas une
   * adresse supprimée : c'est un message dont l'objet a disparu, et c'est au
   * rendu d'en décider (`NotificationContextGoneError`). Répondre `true` ici
   * aurait fait acquitter en silence un message que le rendu aurait su nommer.
   */
  public async isEmailSuppressed(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { emailSuppressedAt: true },
    });

    return user !== null && user.emailSuppressedAt !== null;
  }

  /**
   * Tout ce qu'un message rattaché à un rendez-vous a besoin de dire.
   *
   * ## Pourquoi `notifications` lit `appointments` et `users` ici
   *
   * api-module §3 interdit d'importer le **repository** d'un autre module, pas
   * de lire une table. La distinction tient : ce qui est proscrit, c'est de
   * dépendre des décisions d'un autre module — ses projections, ses règles de
   * cycle de vie —, et rien de tel n'est en jeu dans une lecture de rendu.
   * `crm.module.ts` le prévoit d'ailleurs explicitement : « `notifications`
   * joindra un destinataire par la ligne `users` que `identity` connaît déjà ».
   *
   * Passer par un appel de service aurait fait dépendre l'expédition d'un
   * message de la disponibilité d'`AppointmentsModule` **et** de `CrmModule`
   * **et** de `CatalogModule`, pour une lecture que le client scopé fait en une
   * requête.
   *
   * ## Rendre `null` plutôt que lever
   *
   * Un rendez-vous introuvable n'est pas une anomalie de ce dépôt : c'est un
   * message dont l'objet a disparu — anonymisation RGPD, suppression — et c'est
   * au renderer d'en décider. Le client scopé rend `null` de la même façon pour
   * un rendez-vous d'un **autre** établissement, ce qui est la bonne conduite :
   * il n'y a rien à annoncer, et rien à divulguer.
   *
   * ## L'intervalle rendu est le **facturé**, jamais l'occupé
   *
   * `appointments.starts_at` et `ends_at` portent l'intervalle **occupé** —
   * tampons compris — parce que c'est lui que la contrainte d'exclusion
   * compare. Le soin, lui, commence `buffer_before_minutes` plus tard et dure
   * `duration_minutes`. Annoncer la ligne telle quelle avancerait le
   * rendez-vous de la cliente du temps de préparation de la cabine, et lui
   * donnerait une fin qui inclut le ménage : c'est exactement ce que
   * `appointment-created.event.ts` interdit d'écrire dans une confirmation.
   * `AppointmentsService.billedView` fait la même dérivation pour l'API.
   */
  public async loadAppointmentContext(
    appointmentId: string,
  ): Promise<AppointmentMessageContext | null> {
    const [appointment, tenant] = await Promise.all([
      this.prisma.appointment.findFirst({
        where: { id: appointmentId },
        select: {
          // La référence citable — #796. C'est le seul chemin de retour vers le
          // salon que l'e-mail donnait jusque-là : `{{lien_annulation}}`, qui
          // ouvre l'espace client. Une cliente qui téléphone n'a plus à décrire
          // son rendez-vous, elle lit son code.
          reference: true,
          startsAt: true,
          priceAmountMinor: true,
          priceCurrency: true,
          // L'origine de l'annulation — #72. `cancellation_reason` n'est **pas**
          // lu : c'est un texte libre écrit par un humain, et il n'a rien à faire
          // dans un message composé par un modèle de salon (CDC §5.1).
          cancelledBy: true,
          // `id` sert au rendu, jamais au message : c'est lui qui dit si l'avis
          // part vers la cliente ou vers le praticien (#534).
          client: { select: { id: true, firstName: true, lastName: true } },
          service: {
            select: { name: true, durationMinutes: true, bufferBeforeMinutes: true },
          },
          staff: { select: { displayName: true } },
        },
      }),
      // Le seul enregistrement que l'extension de scoping puisse rendre : elle
      // borne `tenants` sur l'identifiant du contexte.
      this.prisma.tenant.findFirst({
        select: {
          name: true,
          slug: true,
          timezone: true,
          addressLine1: true,
          addressLine2: true,
          postalCode: true,
          city: true,
          contactPhone: true,
        },
      }),
    ]);

    if (appointment === null || tenant === null) {
      return null;
    }

    const billedStart = new Date(
      appointment.startsAt.getTime() + appointment.service.bufferBeforeMinutes * MINUTE_MS,
    );

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantTimeZone: tenant.timezone,
      tenantAddress: postalAddress(tenant),
      tenantPhone: tenant.contactPhone,
      appointmentReference: appointment.reference,
      clientId: appointment.client.id,
      clientFirstName: appointment.client.firstName,
      clientLastName: appointment.client.lastName,
      serviceName: appointment.service.name,
      staffName: appointment.staff.displayName,
      startsAt: billedStart,
      endsAt: new Date(
        billedStart.getTime() + appointment.service.durationMinutes * MINUTE_MS,
      ),
      priceAmountMinor: appointment.priceAmountMinor,
      priceCurrency: appointment.priceCurrency,
      // L'énumération du schéma est reprise telle quelle, comme les trois
      // autres de ce fichier : `appointment-status.spec.ts` tient le témoin qui
      // garantit que les libellés coïncident.
      cancelledBy: appointment.cancelledBy as AppointmentCancelledBy | null,
    };
  }

  /**
   * Le **compte** du praticien d'un rendez-vous — #72.
   *
   * ## Pourquoi une lecture de plus, et pas `staffId` directement
   *
   * Parce que `notifications.recipient_user_id` référence `users`, jamais
   * `staff`. Les deux tables ne portent pas la même chose : `staff` décrit un
   * praticien dans un salon — son nom d'affichage, sa biographie, son activité —
   * là où `users` porte l'**adresse** et le numéro, c'est-à-dire les deux seules
   * choses dont un envoi ait besoin. Passer `staff.id` en destinataire aurait
   * écrit une clé étrangère qui ne résout rien et rendu injoignable le seul
   * message du MVP qui s'adresse au personnel.
   *
   * ## Elle ne rend qu'un identifiant
   *
   * Ni nom, ni adresse, ni numéro : le module désigne ses destinataires par le
   * compte, et la coordonnée se relit à l'envoi (notifications §7). C'est la
   * même discipline que `findRecipientContact`, qui ne rend que deux booléens.
   *
   * Rend `null` si le praticien n'existe plus — ou appartient à un autre
   * établissement, ce que le client scopé traite de la même façon. Il n'y a
   * alors personne à prévenir, et rien à divulguer.
   */
  public async findStaffRecipient(staffId: string): Promise<string | null> {
    const staff = await this.prisma.staff.findFirst({
      where: { id: staffId },
      select: { userId: true },
    });

    return staff === null ? null : staff.userId;
  }

  /**
   * Ce qu'il faut savoir d'un compte pour lui écrire son lien de
   * réinitialisation — #809.
   *
   * ## Ce n'est pas `loadAppointmentContext` avec moins de jointures
   *
   * Les deux composent un message, mais pas le même objet : celui-là part d'un
   * **rendez-vous** et joint tout ce qui l'entoure ; celui-ci part d'un
   * **compte** et ne joint que son établissement. Il n'y a ni heure à
   * convertir, ni montant à formater, ni fuseau à nommer — ce message n'annonce
   * rien de daté.
   *
   * ## Le rôle et l'activité sortent, les coordonnées non
   *
   * `role` décide du chemin du lien (quatrième critère) et `isActive` décide si
   * le message part (sixième critère). Ni `email`, ni `phone`, ni les noms : le
   * modèle ne salue personne — voir `PASSWORD_RESET_EMAIL` — et l'adresse se
   * relit à l'envoi, comme pour les trois autres messages (notifications §7).
   *
   * ## La relecture de `isActive` **au moment d'envoyer**
   *
   * `identity` a déjà refusé d'armer un jeton sur un compte désactivé. La
   * relecture n'est pas une redite : entre l'armement et l'envoi il y a un bus,
   * une file, une Lambda et jusqu'à cinq réceptions, et une suspension tombée
   * dans cet intervalle n'aurait été vue par personne. C'est exactement le
   * raisonnement de `reminderStillDue` et d'`emailSuppressed` — « une décision
   * d'envoi se prend à l'envoi ».
   *
   * Rend `null` si le compte n'existe plus, ou s'il appartient à un autre
   * établissement : le client scopé ne fait pas la différence, et c'est ce qui
   * fait qu'une enveloppe nommant le salon A ne peut rien lire du salon B.
   */
  public async loadPasswordResetContext(
    userId: string,
  ): Promise<PasswordResetMessageContext | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: {
        role: true,
        isActive: true,
        tenant: { select: { slug: true, name: true } },
      },
    });

    if (user === null) {
      return null;
    }

    return {
      role: user.role,
      isActive: user.isActive,
      tenantSlug: user.tenant.slug,
      tenantName: user.tenant.name,
    };
  }

  /**
   * L'état du rendez-vous **au moment d'envoyer** son rappel — #71.
   *
   * Deux colonnes, pas une de plus : le statut et l'heure de début. C'est ce
   * qu'il faut, et exactement ce qu'il faut, pour répondre aux deux questions
   * que notifications §3 pose avant tout envoi de rappel — « le rendez-vous
   * existe-t-il encore ? » et « le rappel est-il encore à l'heure ? ». Le
   * verdict, lui, n'est pas ici : il appartient à `reminder-window.ts` et à
   * `appointment-status.ts`, qui sont des fonctions pures.
   *
   * ## Ce n'est pas une redite de `loadAppointmentContext`
   *
   * Celui-là compose un **message** : il joint la cliente, la prestation, le
   * praticien et l'établissement, et il dérive l'intervalle facturé. Celui-ci
   * prend une **décision d'envoi** : il lit deux colonnes de la seule table
   * `appointments`, avant même la prise de droit, et il doit rester bon marché —
   * il s'exécute sur chaque rappel, y compris ceux qui ne partiront pas.
   *
   * L'heure rendue est celle de la **ligne d'agenda** — tampons compris —, la
   * même que celle sur laquelle le balayage sélectionne. Les deux bouts de la
   * chaîne comparent ainsi la même valeur : dériver l'intervalle facturé d'un
   * côté et pas de l'autre aurait fait diverger la fenêtre de quelques minutes,
   * juste assez pour que les rendez-vous du bas de la fenêtre soient tenus pour
   * en retard.
   *
   * Rend `null` si le rendez-vous n'existe plus — ou s'il appartient à un autre
   * établissement, ce que le client scopé traite de la même façon. Dans les deux
   * cas il n'y a rien à annoncer, et rien à divulguer.
   */
  public async findReminderEligibility(
    appointmentId: string,
  ): Promise<ReminderEligibility | null> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId },
      select: { status: true, startsAt: true },
    });

    return appointment === null
      ? null
      : { status: appointment.status, startsAt: appointment.startsAt };
  }

  /**
   * Clôt l'envoi : `PENDING → SENT`, avec l'accusé du fournisseur.
   *
   * Le filtre de statut est un test-et-pose : une ligne qui ne serait plus
   * `PENDING` n'est pas réécrite. Rend `true` si la transition a eu lieu.
   */
  public async markSent(notificationId: string, providerMessageId: string): Promise<boolean> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, status: 'PENDING' },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId },
    });

    return count === 1;
  }

  /**
   * Clôt l'échec : `PENDING → FAILED`, avec le motif.
   *
   * La ligne quitte ainsi `notifications_live_once` et redevient reprenable —
   * c'est tout l'intérêt du filtre partiel de l'index. `provider_message_id`
   * reste nul : rien n'est parti.
   *
   * Le motif est tronqué à la largeur de la colonne. Un message de pilote AWS
   * dépasse volontiers 500 caractères, et la troncature vaut mieux qu'une
   * seconde erreur au moment d'enregistrer la première.
   */
  public async markFailed(notificationId: string, reason: string): Promise<boolean> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, status: 'PENDING' },
      data: { status: 'FAILED', failureReason: reason.slice(0, FAILURE_REASON_MAX_LENGTH) },
    });

    return count === 1;
  }

  /**
   * Établit **laquelle** des deux situations le refus recouvre, et agit.
   *
   * Deux uniques ont pu refuser, et ils ne veulent pas dire la même chose :
   *
   * 1. un message **vivant** occupe déjà la place — c'est le rejeu nominal, il
   *    n'y a rien à envoyer ;
   * 2. une tentative précédente a **échoué** — la place est libre, mais la clé de
   *    livraison est prise : la reprise est une transition, pas une insertion.
   *
   * L'ordre des lectures n'est pas indifférent : la recherche du vivant passe
   * d'abord, parce qu'elle est le cas courant et parce que c'est elle qui décide
   * de ne rien envoyer. La ligne à ranimer se cherche ensuite — voir
   * `findReclaimable`, qui doit regarder par les deux uniques et non par le seul
   * qui a nommé le message.
   */
  private async resolveRefusal(
    message: NotificationMessage,
    locale: Locale,
  ): Promise<NotificationClaim> {
    const live = await this.prisma.notification.findFirst({
      where: { ...liveIdentity(message), status: { in: [...LIVE_NOTIFICATION_STATUSES] } },
      select: { id: true },
    });

    if (live !== null) {
      return { outcome: 'already-live', notificationId: live.id };
    }

    const failed = await this.findReclaimable(message);

    if (failed === null) {
      // Ni vivante, ni échouée : la ligne a changé d'état entre le refus et la
      // relecture — une reprise concurrente l'a ranimée. Elle est donc vivante
      // pour quelqu'un d'autre, et il n'y a rien à envoyer.
      return { outcome: 'already-live', notificationId: null };
    }

    return this.reclaim(failed, locale);
  }

  /**
   * La ligne `FAILED` que cette livraison doit ranimer, s'il y en a une.
   *
   * Deux regards, parce que **deux uniques** ont pu refuser l'insertion et
   * qu'ils ne désignent pas la même ligne :
   *
   * 1. la clé de livraison — le cas nominal de la reprise après échec, et il
   *    passe en premier parce qu'il désigne exactement notre message ;
   * 2. l'identité que porte `notifications_live_once`. Le refus a pu venir de
   *    cet index-là, dont la clé n'est pas la clé de livraison : la ligne qui
   *    bloquait porte alors une **autre** `dedupe_key` — deux producteurs qui ne
   *    se coordonnent pas en composent deux différentes — et elle a pu tomber en
   *    `FAILED` entre le refus et cette relecture. Sans ce second regard, le
   *    premier ne trouverait rien, la livraison serait tenue pour un doublon, et
   *    le message serait acquitté auprès de SQS sans que rien ne soit parti.
   */
  private async findReclaimable(message: NotificationMessage): Promise<NotificationRecord | null> {
    const byDeliveryKey = await this.prisma.notification.findFirst({
      where: { dedupeKey: message.dedupeKey, status: 'FAILED' },
      select: NOTIFICATION_SELECT,
    });

    if (byDeliveryKey !== null) {
      return toNotificationRecord(byDeliveryKey);
    }

    const byIdentity = await this.prisma.notification.findFirst({
      where: { ...liveIdentity(message), status: 'FAILED' },
      select: NOTIFICATION_SELECT,
    });

    return byIdentity === null ? null : toNotificationRecord(byIdentity);
  }

  /**
   * Ranime une ligne `FAILED` pour une nouvelle tentative.
   *
   * Deux garde-fous, et chacun ferme une course réelle :
   *
   * - `WHERE status = 'FAILED'` — une reprise concurrente a pu passer avant
   *   nous ; le compte de zéro le dit, et personne n'envoie deux fois ;
   * - le rattrapage de la violation d'unicité — un envoi **neuf** a pu prendre la
   *   place entre notre relecture et cette écriture ; c'est
   *   `notifications_live_once` qui l'arrête, et lui seul le pouvait.
   *
   * ## La langue est réécrite, et elle doit l'être — #854
   *
   * Une reprise est un **second envoi**, séparé du premier par une file, un
   * backoff, et jusqu'à plusieurs heures. `NotificationDispatchService` vient de
   * résoudre la langue à neuf et c'est elle qui choisira le modèle : laisser la
   * colonne porter celle de la tentative ratée ferait dire au journal du
   * back-office une langue qui n'est pas celle du message effectivement parti —
   * précisément ce que le deuxième critère d'acceptation interdit.
   */
  private async reclaim(failed: NotificationRecord, locale: Locale): Promise<NotificationClaim> {
    try {
      const { count } = await this.prisma.notification.updateMany({
        where: { id: failed.id, status: 'FAILED' },
        data: {
          status: 'PENDING',
          attemptCount: { increment: 1 },
          locale,
          // Le motif de l'échec précédent n'a plus cours : le laisser ferait
          // lire « échoué parce que … » sur une ligne en cours d'envoi.
          failureReason: null,
        },
      });

      if (count === 0) {
        return { outcome: 'already-live', notificationId: failed.id };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { outcome: 'already-live', notificationId: null };
      }
      throw error;
    }

    return {
      outcome: 'claimed',
      notification: {
        ...failed,
        status: 'PENDING',
        locale,
        attemptCount: failed.attemptCount + 1,
      },
    };
  }
}
