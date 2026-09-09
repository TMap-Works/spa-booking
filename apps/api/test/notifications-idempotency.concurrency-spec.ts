import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import {
  appointmentDedupeKey,
  type NotificationChannel,
  type NotificationClaim,
  type NotificationMessage,
  type NotificationRecord,
  type NotificationType,
} from '../src/modules/notifications/notifications.types';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';
import { inTenant } from './utils/tenant-scope';

/**
 * Les **courses** sur l'idempotence des notifications, contre un vrai
 * PostgreSQL — seconde suite de la cible `npm run test:concurrency` (#493, suite
 * de #68 et #534).
 *
 * ## Ce que rien d'autre ne prouve
 *
 * Toute la chaîne d'envoi repose sur une phrase : « rejouer deux fois le même
 * message SQS produit un seul envoi ». Cette phrase n'est pas tenue par du code,
 * elle est tenue par un index — `notifications_live_once`, unique et partiel,
 * posé par `20260906120000_add_notification_idempotency` puis remplacé par
 * `20260908120000_notification_live_once_per_recipient`.
 *
 * Trois garanties existaient déjà, et aucune ne porte sur la **sérialisation** :
 *
 * - `__tests__/notifications.migration.spec.ts` relit le SQL appliqué — l'index
 *   existe, sur ces colonnes-là, dans cet ordre-là, avec ce filtre-là. C'est une
 *   preuve **structurelle** : elle dit ce qui est écrit, pas ce que le moteur en
 *   fait ;
 * - `__tests__/notifications.repository.spec.ts` exerce le dépôt réel contre un
 *   faux client Prisma qui rejoue les deux uniques. Un double ne se dispute rien
 *   avec lui-même : il prouve que le dépôt **traduit** correctement un refus
 *   qu'on lui a fabriqué ;
 * - la CI applique les migrations sur un PostgreSQL neuf, ce qui ferait échouer
 *   un `WHERE` mal formé — mais pas un index qui laisserait passer deux
 *   insertions simultanées.
 *
 * Ce qui manquait est exactement ce que le moteur de réservation prouve depuis
 * #31 pour la contrainte d'exclusion : que **PostgreSQL lui-même** refuse la
 * seconde écriture quand les deux partent en même temps. C'est le raisonnement
 * d'ADR 0002 — « la base tranche, le code traduit » — appliqué aux statuts
 * d'envoi, et il ne se vérifie que contre un vrai moteur.
 *
 * ## Ce que chaque cas établit
 *
 * 1. **N `claim()` parallèles pour la même identité** produisent exactement un
 *    `claimed` et N−1 `already-live` — le rejeu SQS nominal ;
 * 2. la même course avec N `dedupe_key` **différentes** : le cas que seul
 *    `notifications_live_once` sait arrêter, `(tenant_id, dedupe_key)` laissant
 *    passer N insertions. C'est la situation réelle de deux producteurs qui ne
 *    se coordonnent pas — l'abonné au bus d'un côté, le balayage EventBridge de
 *    l'autre ;
 * 3. une ligne passée en `FAILED` **libère** la place, et la place libérée est
 *    de nouveau arbitrée : N insertions concurrentes à clés neuves n'en laissent
 *    aboutir qu'une. C'est tout l'intérêt du filtre partiel — sans lui, la
 *    première erreur réseau condamnerait le message (notifications §4) ;
 * 3 bis. le **rejeu du même message** après cet échec passe, lui, par la
 *    transition `FAILED → PENDING` : c'est une course distincte, arbitrée par le
 *    test-et-pose de `reclaim()` et non par un index, et N rejeux n'en ranime
 *    qu'un ;
 * 4. une ligne `SENT` ne la libère **pas** : N livraisons de plus sont toutes
 *    refusées, et le message n'est pas envoyé deux fois ;
 * 5. deux établissements ne se disputent jamais la place, même sur une clé de
 *    livraison identique au caractère près — `tenant_id` est en tête des deux
 *    uniques (tenant-isolation §1).
 *
 * ## Le décor, et pourquoi il est ici plutôt que dans un harnais
 *
 * Une base jetable, migrée puis détruite, dans un PostgreSQL 16 que la suite
 * démarre elle-même (`utils/disposable-database.ts`, #274) : un démon Docker
 * joignable est le seul prérequis, et rien de ce que la machine héberge n'entre
 * dans le résultat. `appointments-exclusion.harness.ts` est partagé parce que
 * **deux** suites en dépendent ; celui-ci n'en sert qu'une, et un fichier de
 * plus n'aurait fait qu'éloigner le décor des cas qu'il sert.
 *
 * ## Chaque cas sème son propre rendez-vous
 *
 * Ce n'est pas de la précaution : l'identité que l'index arbitre porte
 * l'`appointment_id`, si bien qu'un rendez-vous par cas rend les clés
 * **disjointes**. Aucun cas ne dépend alors de ce que le précédent a laissé en
 * base, ni de l'ordre dans lequel Jest les joue — c'est la leçon de #555, où une
 * suite voisine rougissait une fois sur deux pour cette raison exacte.
 */

/**
 * Le nombre de livraisons parallèles, aligné sur `CONCURRENT_ATTEMPTS` de
 * `appointments-exclusion.harness.ts` — et pour la même raison : deux requêtes
 * peuvent se sérialiser par hasard sur un pool de connexions, et un test qui
 * passe par chance ne prouve rien.
 *
 * La constante est **redéclarée** plutôt qu'importée : le harnais d'exclusion
 * amène avec lui `AppointmentsRepository`, `CrmRepository` et le moteur de
 * disponibilité, dont cette suite n'a rien à faire. Une valeur partagée entre
 * deux suites qui ne partagent aucun décor n'aurait rien tenu ensemble.
 */
const CONCURRENT_ATTEMPTS = 8;

/** Une heure, en millisecondes — la durée de la prestation semée. */
const ONE_HOUR = 3_600_000;

/** L'établissement semé, réduit à ce dont cette suite a besoin. */
interface Fixture {
  readonly tenantId: string;
  /** Le compte destinataire des messages — la cliente du rendez-vous. */
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
}

/**
 * Le créneau du prochain rendez-vous semé.
 *
 * Un curseur, et non une date fixe : deux rendez-vous du même praticien ne
 * peuvent pas se chevaucher — `appointments_no_overlap` le refuse —, et un cas
 * qui échouerait à *semer* son décor se lirait comme un défaut d'idempotence.
 */
let slotCursor = Date.UTC(2027, 2, 1, 9, 0, 0);

/** Sème un établissement complet : une cliente, un praticien, une prestation. */
async function seedTenant(prismaUnscoped: PrismaClient, label: string): Promise<Fixture> {
  const tenantId = (
    await prismaUnscoped.tenant.create({
      data: {
        slug: `i493-${label}-${randomUUID()}`,
        name: `Établissement ${label}`,
        timezone: 'Europe/Paris',
        defaultCurrency: 'EUR',
      },
    })
  ).id;

  // Le client non scopé est le bon outil pour semer : ces lignes précèdent toute
  // requête HTTP, donc tout contexte de tenant. Le `tenantId` est écrit
  // explicitement — c'est ce que tenant-isolation §3 exige d'un accès non scopé.
  const client = await prismaUnscoped.user.create({
    data: {
      tenantId,
      email: `client-${randomUUID()}@example.test`,
      role: 'CLIENT',
      firstName: 'Alice',
      lastName: 'Martin',
    },
  });

  const staffAccount = await prismaUnscoped.user.create({
    data: {
      tenantId,
      email: `staff-${randomUUID()}@example.test`,
      role: 'STAFF',
      firstName: 'Camille',
      lastName: 'Praticien',
    },
  });
  const staff = await prismaUnscoped.staff.create({
    data: { tenantId, userId: staffAccount.id, displayName: 'Camille' },
  });

  const service = await prismaUnscoped.service.create({
    data: {
      tenantId,
      slug: `massage-60-${randomUUID().slice(0, 8)}`,
      name: 'Massage 60 min',
      durationMinutes: 60,
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    },
  });

  return { tenantId, clientId: client.id, staffId: staff.id, serviceId: service.id };
}

/** Sème un rendez-vous de plus dans cet établissement, sur un créneau libre. */
async function seedAppointment(
  prismaUnscoped: PrismaClient,
  fixture: Fixture,
): Promise<string> {
  const startsAt = new Date(slotCursor);
  slotCursor += ONE_HOUR;

  const appointment = await prismaUnscoped.appointment.create({
    data: {
      tenantId: fixture.tenantId,
      clientId: fixture.clientId,
      staffId: fixture.staffId,
      serviceId: fixture.serviceId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + ONE_HOUR),
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    },
  });

  return appointment.id;
}

/**
 * La livraison que le consommateur SQS présenterait — un rappel J-1 par e-mail,
 * sauf mention contraire.
 *
 * `dedupeKey` vaut par défaut la clé canonique du message, celle que
 * `appointmentDedupeKey` compose : c'est ce qu'un producteur unique écrirait, et
 * donc ce que deux réceptions du **même** message SQS portent toutes les deux.
 */
function delivery(
  fixture: Fixture,
  appointmentId: string,
  overrides: Partial<NotificationMessage> = {},
): NotificationMessage {
  const type: NotificationType = 'REMINDER_24H';
  const channel: NotificationChannel = 'EMAIL';

  return {
    tenantId: fixture.tenantId,
    dedupeKey: appointmentDedupeKey(appointmentId, type, channel),
    appointmentId,
    recipientUserId: fixture.clientId,
    type,
    channel,
    scheduledFor: null,
    ...overrides,
  };
}

/**
 * La ligne réservée, ou une erreur qui nomme ce qui s'est passé à la place.
 *
 * Un `expect` ne dit rien au compilateur : sans ce détour, chaque lecture de
 * `claim.notification` demanderait une garde de type que l'assertion voisine
 * rend déjà vraie. La levée n'est pas défensive — elle est la façon d'écrire
 * l'assertion **et** de la faire valoir au typage.
 */
function claimedRecord(claim: NotificationClaim): NotificationRecord {
  if (claim.outcome !== 'claimed') {
    throw new Error(`prise de droit attendue, obtenu « ${claim.outcome} »`);
  }

  return claim.notification;
}

/** Les issues d'une course, réparties par ce qu'elles autorisent l'appelant à faire. */
function partition(outcomes: readonly NotificationClaim[]): {
  claimed: readonly Extract<NotificationClaim, { outcome: 'claimed' }>[];
  refused: readonly Extract<NotificationClaim, { outcome: 'already-live' }>[];
} {
  return {
    claimed: outcomes.filter(
      (outcome): outcome is Extract<NotificationClaim, { outcome: 'claimed' }> =>
        outcome.outcome === 'claimed',
    ),
    refused: outcomes.filter(
      (outcome): outcome is Extract<NotificationClaim, { outcome: 'already-live' }> =>
        outcome.outcome === 'already-live',
    ),
  };
}

describe('Courses sur l’idempotence des notifications — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  /** Le dépôt sous test, branché sur le client **scopé**, comme en production. */
  let repository: NotificationsRepository;
  let salon: Fixture;
  /** L'établissement voisin — la frontière ne se prouve qu'à deux. */
  let voisin: Fixture;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
      // que le schéma est en place. Une base joignable mais vide produirait
      // sinon une erreur bien plus loin, où elle se lirait comme un défaut du
      // dépôt.
      await prismaUnscoped.tenant.count();
    } catch (error: unknown) {
      // La déconnexion est sous filet, la destruction ne l'est pas : c'est
      // l'erreur d'origine qui doit remonter, et un `$disconnect()` qui échoue
      // ne doit pas emporter avec lui le `drop()` qui arrête le conteneur.
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    repository = new NotificationsRepository(createScopedPrismaClient(prismaUnscoped));
    salon = await seedTenant(prismaUnscoped, 'salon');
    voisin = await seedTenant(prismaUnscoped, 'voisin');
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    // Le ménage tient en une ligne : la base entière disparaît. La déconnexion
    // d'abord, mais sous `finally` — une déconnexion qui échoue sauterait sinon
    // le `drop()` et laisserait le conteneur vivant après l'`afterAll`.
    try {
      await prismaUnscoped.$disconnect();
    } finally {
      await database.drop();
    }
  });

  /** Ce que la base porte vraiment pour cette identité — la preuve directe. */
  const storedFor = async (
    fixture: Fixture,
    appointmentId: string,
  ): Promise<{ id: string; status: string; dedupeKey: string; attemptCount: number }[]> =>
    prismaUnscoped.notification.findMany({
      where: {
        tenantId: fixture.tenantId,
        appointmentId,
        recipientUserId: fixture.clientId,
        type: 'REMINDER_24H',
        channel: 'EMAIL',
      },
      select: { id: true, status: true, dedupeKey: true, attemptCount: true },
      orderBy: { createdAt: 'asc' },
    });

  describe(`${CONCURRENT_ATTEMPTS} livraisons parallèles du même message`, () => {
    it(`n’en laisse aboutir qu’une et refuse les ${CONCURRENT_ATTEMPTS - 1} autres`, async () => {
      // Le rejeu SQS nominal : la même Lambda relancée, le même message reçu
      // deux fois, la même clé de livraison. Deux `claimed` voudraient dire deux
      // appels à SES, donc deux rappels chez la cliente.
      const appointmentId = await seedAppointment(prismaUnscoped, salon);
      const message = delivery(salon, appointmentId);

      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => repository.claim(message)),
        ),
      );

      const { claimed, refused } = partition(outcomes);
      expect(claimed).toHaveLength(1);
      expect(refused).toHaveLength(CONCURRENT_ATTEMPTS - 1);

      // Et chaque perdante désigne la gagnante : un `already-live` qui ne
      // saurait pas dire *laquelle* occupe la place signalerait que la relecture
      // de `resolveRefusal` regarde par d'autres colonnes que l'index.
      const winner = claimed[0]?.notification.id;
      for (const outcome of refused) {
        expect(outcome.notificationId).toBe(winner);
      }

      // La preuve directe, sans passer par ce que les promesses ont bien voulu
      // dire : la base ne porte qu'une ligne, et elle est vivante.
      const stored = await storedFor(salon, appointmentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: winner, status: 'PENDING', attemptCount: 1 });
    });

    /**
     * La même course, mais avec **N clés de livraison différentes** — le cœur du
     * ticket.
     *
     * C'est le seul cas où les deux uniques de la table ne disent pas la même
     * chose. `(tenant_id, dedupe_key)` laisserait passer les huit insertions :
     * les huit clés sont distinctes, et il n'a rien à y redire. Ce qui les
     * sérialise est `notifications_live_once`, et lui seul.
     *
     * La situation n'a rien de théorique : deux producteurs qui ne se
     * coordonnent pas composent deux clés différentes pour un même rappel —
     * l'abonné au bus d'`appointments` d'un côté, le balayage EventBridge de
     * l'autre. Un doublon né de là ne serait rattrapé par aucune convention de
     * nommage, seulement par l'index.
     */
    it('n’en laisse aboutir qu’une même quand les clés de livraison diffèrent toutes', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);

      // Les clés sont **listées**, pas seulement composées : c'est cette liste
      // que l'assertion finale relit. Une reconnaissance par motif serait à
      // refaire au premier `CONCURRENT_ATTEMPTS` à deux chiffres.
      const keys = Array.from(
        { length: CONCURRENT_ATTEMPTS },
        (_unused, index) => `producteur-${index}:${appointmentId}:REMINDER_24H:EMAIL`,
      );

      const outcomes = await Promise.all(
        keys.map((dedupeKey) =>
          inTenant(salon.tenantId, () =>
            repository.claim(delivery(salon, appointmentId, { dedupeKey })),
          ),
        ),
      );

      const { claimed, refused } = partition(outcomes);
      expect(claimed).toHaveLength(1);
      expect(refused).toHaveLength(CONCURRENT_ATTEMPTS - 1);

      const winner = claimed[0]?.notification.id;
      for (const outcome of refused) {
        expect(outcome.notificationId).toBe(winner);
      }

      // Une seule ligne, et sa clé de livraison est l'une des huit — c'est ce
      // qui établit que l'arbitre n'était pas `(tenant_id, dedupe_key)` : les
      // sept autres clés n'existent nulle part en base.
      const stored = await storedFor(salon, appointmentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.id).toBe(winner);
      expect(keys).toContain(stored[0]?.dedupeKey);
    });
  });

  describe('ce qu’un statut terminal fait de la place', () => {
    /**
     * `FAILED` la libère — et la place libérée est **de nouveau arbitrée**.
     *
     * C'est tout l'intérêt du filtre partiel `WHERE status IN ('PENDING',
     * 'SENT')` : un échec transitoire — throttling SES, panne fournisseur — doit
     * pouvoir se réessayer, sans quoi la première erreur réseau condamnerait le
     * rappel pour de bon (notifications §4).
     *
     * La reprise est jouée en parallèle plutôt qu'une fois, parce que c'est
     * ainsi qu'elle arrive : SQS rejoue en rafale après un échec. Une place
     * libérée qui laisserait passer huit insertions n'aurait fait que déplacer
     * le doublon d'un cran.
     */
    it('une ligne FAILED rouvre la place, qu’une seule reprise concurrente obtient', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);

      const failedId = claimedRecord(
        await inTenant(salon.tenantId, () => repository.claim(delivery(salon, appointmentId))),
      ).id;

      expect(
        await inTenant(salon.tenantId, () =>
          repository.markFailed(failedId, 'SES indisponible'),
        ),
      ).toBe(true);

      // Des clés de livraison neuves : ce sont donc de véritables **insertions**
      // qui se présentent, et non la transition `FAILED → PENDING` que
      // `reclaim()` sert à la même clé. Ce que le cas doit établir est que la
      // base accepte une insertion là où elle en refusait une, puis qu'elle
      // recommence à n'en accepter qu'une.
      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.claim(
              delivery(salon, appointmentId, {
                dedupeKey: `reprise-${index}:${appointmentId}:REMINDER_24H:EMAIL`,
              }),
            ),
          ),
        ),
      );

      const { claimed, refused } = partition(outcomes);
      expect(claimed).toHaveLength(1);
      expect(refused).toHaveLength(CONCURRENT_ATTEMPTS - 1);
      // La place a bien été rendue : la gagnante est une ligne **neuve**, pas
      // celle que l'échec avait laissée.
      expect(claimed[0]?.notification.id).not.toBe(failedId);

      // Deux lignes en tout : l'échouée, qui garde sa trace au journal du
      // back-office, et la vivante qui a repris la place.
      const stored = await storedFor(salon, appointmentId);
      expect(stored).toHaveLength(2);
      expect(stored.map((row) => row.status)).toEqual(['FAILED', 'PENDING']);
    });

    /**
     * La reprise **à la même clé de livraison** — le rejeu SQS réel, et le seul
     * chemin qui passe par `reclaim()`.
     *
     * Le cas précédent présente des clés neuves : ce sont des insertions, et
     * c'est `notifications_live_once` qui les arbitre. Un message SQS rejoué
     * après un échec, lui, revient **à l'identique** : il bute sur l'unique
     * total `(tenant_id, dedupe_key)`, ne trouve aucune ligne vivante, et tombe
     * sur la transition `FAILED → PENDING`. Cette transition a sa propre course,
     * que rien ne prouvait : `updateMany WHERE status = 'FAILED'` est un
     * test-et-pose, et huit reprises simultanées doivent en voir aboutir une.
     * Sans elle, l'échec d'un rappel produirait autant d'envois que la file a de
     * livraisons en vol.
     *
     * `notificationId` est admis nul chez les perdantes, et ce n'est pas une
     * tolérance de confort : une reprise qui relit après que la gagnante a
     * ranimé la ligne ne trouve ni vivante — sa lecture précédait la
     * transition — ni échouée, et `resolveRefusal` documente exactement ce
     * `null`. Ce qui doit tenir est le compte, pas l'identifiant rendu.
     */
    it('une seule reprise aboutit quand le même message est rejoué en rafale', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);
      const message = delivery(salon, appointmentId);

      const failedId = claimedRecord(
        await inTenant(salon.tenantId, () => repository.claim(message)),
      ).id;

      expect(
        await inTenant(salon.tenantId, () => repository.markFailed(failedId, 'SES indisponible')),
      ).toBe(true);

      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => repository.claim(message)),
        ),
      );

      const { claimed, refused } = partition(outcomes);
      expect(claimed).toHaveLength(1);
      expect(refused).toHaveLength(CONCURRENT_ATTEMPTS - 1);
      // Une reprise, pas une insertion : c'est la ligne échouée qui repart, et
      // son compteur de tentatives le dit.
      expect(claimed[0]?.notification).toMatchObject({
        id: failedId,
        status: 'PENDING',
        attemptCount: 2,
      });
      for (const outcome of refused) {
        expect([failedId, null]).toContain(outcome.notificationId);
      }

      // Une seule ligne, et elle a bien été ranimée une fois : un second
      // `reclaim()` abouti l'aurait portée à trois.
      const stored = await storedFor(salon, appointmentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: failedId, status: 'PENDING', attemptCount: 2 });
    });

    /**
     * `SENT` ne la libère pas — l'autre moitié du filtre partiel.
     *
     * C'est la garantie qui empêche le rejeu tardif : un message SQS peut
     * revenir une heure après avoir été envoyé, et une place rendue par `SENT`
     * ferait partir un second rappel à la cliente.
     */
    it('une ligne SENT garde la place, et refuse toutes les livraisons suivantes', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);

      const sentId = claimedRecord(
        await inTenant(salon.tenantId, () => repository.claim(delivery(salon, appointmentId))),
      ).id;

      expect(
        await inTenant(salon.tenantId, () => repository.markSent(sentId, 'ses-0100000000000000')),
      ).toBe(true);

      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.claim(
              delivery(salon, appointmentId, {
                dedupeKey: `tardif-${index}:${appointmentId}:REMINDER_24H:EMAIL`,
              }),
            ),
          ),
        ),
      );

      const { claimed, refused } = partition(outcomes);
      expect(claimed).toHaveLength(0);
      expect(refused).toHaveLength(CONCURRENT_ATTEMPTS);
      // Toutes désignent la ligne partie : c'est elle qui occupe la place, et
      // l'appelant n'a rien à envoyer.
      for (const outcome of refused) {
        expect(outcome.notificationId).toBe(sentId);
      }

      const stored = await storedFor(salon, appointmentId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: sentId, status: 'SENT' });
    });
  });

  /**
   * La frontière de l'établissement, sous concurrence.
   *
   * `tenant_id` est en tête des **deux** uniques de la table, et c'est ce qui
   * fait qu'un salon ne peut pas priver un autre de ses envois. Le cas est
   * exercé sur une clé de livraison **identique au caractère près** dans les
   * deux établissements : c'est la seule forme qui distingue « la clé porte
   * l'établissement » de « l'index le porte ». `appointmentDedupeKey` ne recopie
   * délibérément pas le tenant — la colonne est déjà dans l'unique —, et ce test
   * est ce qui rend cette décision sûre.
   *
   * Sans `tenant_id` en tête, la moitié de ces seize livraisons repartirait avec
   * `already-live` sur un message qu'aucun salon n'a envoyé.
   */
  it('deux établissements ne se disputent jamais la place, même sur la même clé de livraison', async () => {
    const [chezSalon, chezVoisin] = await Promise.all([
      seedAppointment(prismaUnscoped, salon),
      seedAppointment(prismaUnscoped, voisin),
    ]);

    // La même chaîne des deux côtés : ni l'un ni l'autre n'y met son
    // établissement.
    const partagee = `rappel-partage:REMINDER_24H:EMAIL:${randomUUID()}`;

    const outcomes = await Promise.all([
      ...Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        inTenant(salon.tenantId, () =>
          repository.claim(delivery(salon, chezSalon, { dedupeKey: partagee })),
        ),
      ),
      ...Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        inTenant(voisin.tenantId, () =>
          repository.claim(delivery(voisin, chezVoisin, { dedupeKey: partagee })),
        ),
      ),
    ]);

    // Un succès de chaque côté, et un seul : les deux salons sont servis, et
    // aucun ne l'est deux fois.
    expect(partition(outcomes).claimed).toHaveLength(2);

    const [ligneSalon, ligneVoisin] = await Promise.all([
      storedFor(salon, chezSalon),
      storedFor(voisin, chezVoisin),
    ]);
    expect(ligneSalon).toHaveLength(1);
    expect(ligneVoisin).toHaveLength(1);
    expect(ligneSalon[0]?.id).not.toBe(ligneVoisin[0]?.id);
  });
});
