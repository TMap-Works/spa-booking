import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { DEFAULT_LOCALE, type Locale } from '@spa/shared';

import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { generateAppointmentReference } from '../src/modules/appointments/appointment-reference';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import {
  appointmentDedupeKey,
  type NotificationMessage,
} from '../src/modules/notifications/notifications.types';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';
import { inTenant } from './utils/tenant-scope';

/**
 * La **langue d'un envoi**, contre un vrai PostgreSQL — #854, deuxième et
 * sixième critères d'acceptation.
 *
 * ## Ce que rien d'autre ne prouve
 *
 * La règle de résolution — « la langue préférée du destinataire, sinon celle de
 * l'établissement » — est répartie sur deux tables et deux colonnes nullables
 * différemment : `users.locale` est nullable et se lit « aucune préférence »,
 * `tenants.default_locale` est `NOT NULL` et vaut `en` par défaut (#844). Les
 * suites unitaires du module l'approchent par un double
 * (`FakeNotificationsRepository.recipientLocale`), et ce double **pose** la
 * réponse au lieu de la calculer : il prouve que l'expédition demande une langue
 * et s'en sert, jamais qu'elle obtient la bonne. `notifications.doubles.ts` le
 * dit d'ailleurs en toutes lettres — la règle « se prouve en intégration, contre
 * une vraie base ». C'est ce fichier.
 *
 * ## Ce que chaque cas établit
 *
 * 1. une préférence exprimée est **servie telle quelle**, même quand elle
 *    contredit la langue de l'établissement — c'est tout l'objet du champ ;
 * 2. une préférence absente retombe sur `tenants.default_locale`, et non sur une
 *    constante du code : deux établissements de langues différentes le montrent
 *    en même temps, ce qu'un seul salon n'aurait pas pu distinguer d'un
 *    `DEFAULT_LOCALE` écrit en dur ;
 * 3. la frontière du tenant tient **aussi** sur cette lecture : le compte du
 *    voisin est invisible depuis la portée du salon, et la résolution rend alors
 *    la langue du salon plutôt que la préférence du voisin (tenant-isolation §4
 *    — l'absence, jamais la donnée) ;
 * 4. la langue résolue est **écrite sur la ligne** que `claim()` pose : c'est la
 *    seconde moitié du deuxième critère, « la langue retenue est enregistrée sur
 *    la notification émise » ;
 * 5. une reprise `FAILED → PENDING` **réécrit** la langue. C'est le sixième
 *    critère vu depuis la base : la langue se décide à l'expédition, et une
 *    seconde tentative est un second envoi. La garder aurait figé une préférence
 *    que la cliente a pu changer entre les deux — précisément ce que l'enveloppe
 *    SQS du rappel J-1 ne doit pas transporter ;
 * 6. le vocabulaire est **borné en base** : `notifications_locale_check` refuse
 *    une langue que le contrat ne nomme pas, quand bien même le code la
 *    laisserait passer.
 *
 * ## Le décor
 *
 * Une base jetable, migrée puis détruite (`utils/disposable-database.ts`, #274),
 * comme `notifications-idempotency.concurrency-spec.ts` — dont ce fichier reprend
 * la façon de semer. Le dépôt est branché sur le client **scopé**, comme en
 * production : c'est ce qui rend le troisième cas significatif.
 */

/** Une heure, en millisecondes — la durée de la prestation semée. */
const ONE_HOUR = 3_600_000;

/** L'établissement semé, réduit à ce dont cette suite a besoin. */
interface Fixture {
  readonly tenantId: string;
  /** La cliente destinataire des messages. */
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
}

/**
 * Le créneau du prochain rendez-vous semé.
 *
 * Un curseur, et non une date fixe : deux rendez-vous du même praticien ne
 * peuvent pas se chevaucher — `appointments_no_overlap` le refuse —, et un cas
 * qui échouerait à *semer* son décor se lirait comme un défaut de résolution.
 */
let slotCursor = Date.UTC(2027, 5, 1, 9, 0, 0);

/**
 * Sème un établissement complet, dans la langue demandée.
 *
 * `defaultLocale` est un **paramètre** et non une constante : le deuxième cas ne
 * vaut que si les deux salons diffèrent, faute de quoi un repli écrit en dur sur
 * `DEFAULT_LOCALE` passerait au vert.
 */
async function seedTenant(
  prismaUnscoped: PrismaClient,
  label: string,
  defaultLocale: Locale,
  clientLocale: Locale | null,
): Promise<Fixture> {
  const tenantId = (
    await prismaUnscoped.tenant.create({
      data: {
        slug: `i854-${label}-${randomUUID()}`,
        name: `Établissement ${label}`,
        timezone: 'Europe/Paris',
        defaultCurrency: 'EUR',
        defaultLocale,
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
      locale: clientLocale,
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
async function seedAppointment(prismaUnscoped: PrismaClient, fixture: Fixture): Promise<string> {
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
      // `NOT NULL` depuis #796 : ce semis écrit hors du repository.
      reference: generateAppointmentReference(),
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    },
  });

  return appointment.id;
}

/** La livraison qu'un consommateur SQS présenterait — un rappel J-1 par e-mail. */
function delivery(fixture: Fixture, appointmentId: string): NotificationMessage {
  return {
    tenantId: fixture.tenantId,
    dedupeKey: appointmentDedupeKey(appointmentId, 'REMINDER_24H', 'EMAIL'),
    appointmentId,
    recipientUserId: fixture.clientId,
    type: 'REMINDER_24H',
    channel: 'EMAIL',
    scheduledFor: null,
  };
}

describe('La langue d’un envoi — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  /** Le dépôt sous test, branché sur le client **scopé**, comme en production. */
  let repository: NotificationsRepository;
  /** Le salon francophone, dont la cliente n'a exprimé aucune préférence. */
  let salon: Fixture;
  /** Le voisin anglophone, dont la cliente a choisi le français. */
  let voisin: Fixture;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
      // que le schéma est en place.
      await prismaUnscoped.tenant.count();
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    repository = new NotificationsRepository(createScopedPrismaClient(prismaUnscoped));
    // Les deux salons sont délibérément **croisés** : le francophone a une
    // cliente sans préférence, l'anglophone une cliente qui a choisi le
    // français. Aucun des deux cas ne peut alors passer par coïncidence.
    salon = await seedTenant(prismaUnscoped, 'salon', 'fr', null);
    voisin = await seedTenant(prismaUnscoped, 'voisin', 'en', 'fr');
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    try {
      await prismaUnscoped.$disconnect();
    } finally {
      await database.drop();
    }
  });

  describe('la résolution', () => {
    it('sert la préférence du compte quand il en a une', async () => {
      const resolved = await inTenant(voisin.tenantId, () =>
        repository.resolveRecipientLocale(voisin.clientId),
      );

      // La cliente a choisi le français ; son établissement sert l'anglais. Le
      // compte gagne — c'est l'ordre que le deuxième critère fixe.
      expect(resolved).toBe('fr');
    });

    it('retombe sur la langue de l’établissement quand le compte n’en a pas', async () => {
      const resolved = await inTenant(salon.tenantId, () =>
        repository.resolveRecipientLocale(salon.clientId),
      );

      // `fr`, la langue de *ce* salon — et non `DEFAULT_LOCALE`, qui vaut `en`
      // depuis #844. C'est cette distinction qu'un seul établissement n'aurait
      // pas su montrer.
      expect(resolved).toBe('fr');
      expect(resolved).not.toBe(DEFAULT_LOCALE);
    });

    it('ne traverse pas la frontière du tenant pour lire une préférence', async () => {
      // Le compte du voisin, demandé depuis la portée du salon. Le client scopé
      // ne le trouve pas — c'est une absence, jamais une donnée
      // (tenant-isolation §4) —, et la résolution retombe donc sur la langue du
      // salon courant.
      const resolved = await inTenant(salon.tenantId, () =>
        repository.resolveRecipientLocale(voisin.clientId),
      );

      expect(resolved).toBe('fr');
    });

    it('ne rend jamais la langue du voisin sur un identifiant inconnu', async () => {
      // Le pendant du cas précédent sur un identifiant qui n'existe nulle part :
      // le repli est celui de l'établissement courant, jamais celui d'un autre.
      const resolved = await inTenant(voisin.tenantId, () =>
        repository.resolveRecipientLocale(randomUUID()),
      );

      expect(resolved).toBe('en');
    });
  });

  describe('l’enregistrement sur la ligne', () => {
    it('écrit la langue résolue sur la notification émise', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);
      const message = delivery(salon, appointmentId);

      const claim = await inTenant(salon.tenantId, async () => {
        const locale = await repository.resolveRecipientLocale(salon.clientId);
        return repository.claim(message, locale);
      });

      expect(claim.outcome).toBe('claimed');

      const stored = await prismaUnscoped.notification.findFirst({
        where: { tenantId: salon.tenantId, dedupeKey: message.dedupeKey },
        select: { locale: true, status: true },
      });

      expect(stored).toEqual({ locale: 'fr', status: 'PENDING' });
    });

    it('réécrit la langue à la reprise d’un envoi échoué', async () => {
      const appointmentId = await seedAppointment(prismaUnscoped, salon);
      const message = delivery(salon, appointmentId);

      const first = await inTenant(salon.tenantId, () => repository.claim(message, 'fr'));
      expect(first.outcome).toBe('claimed');

      if (first.outcome !== 'claimed') {
        throw new Error('prise de droit attendue');
      }
      await inTenant(salon.tenantId, () =>
        repository.markFailed(first.notification.id, 'SES indisponible'),
      );

      // La place est libre : le rejeu repasse la ligne en `PENDING`. La cliente
      // a changé sa langue entre-temps, et c'est celle de la **seconde**
      // expédition qui doit être inscrite.
      const retry = await inTenant(salon.tenantId, () => repository.claim(message, 'en'));
      expect(retry.outcome).toBe('claimed');

      const stored = await prismaUnscoped.notification.findFirst({
        where: { tenantId: salon.tenantId, dedupeKey: message.dedupeKey },
        select: { locale: true, status: true, attemptCount: true },
      });

      expect(stored).toEqual({ locale: 'en', status: 'PENDING', attemptCount: 2 });
    });

    it('n’écrit pas deux fois la même langue sur un message déjà vivant', async () => {
      // L'idempotence reste ce qu'elle était : une seconde livraison du même
      // message ne pose pas de seconde ligne, et la langue de la première reste
      // celle du journal. #854 ajoute une colonne, il ne relâche aucun index.
      const appointmentId = await seedAppointment(prismaUnscoped, salon);
      const message = delivery(salon, appointmentId);

      const first = await inTenant(salon.tenantId, () => repository.claim(message, 'fr'));
      const second = await inTenant(salon.tenantId, () => repository.claim(message, 'en'));

      expect(first.outcome).toBe('claimed');
      expect(second.outcome).toBe('already-live');

      const rows = await prismaUnscoped.notification.findMany({
        where: { tenantId: salon.tenantId, dedupeKey: message.dedupeKey },
        select: { locale: true },
      });

      expect(rows).toEqual([{ locale: 'fr' }]);
    });
  });

  describe('le vocabulaire, borné en base', () => {
    it('refuse une langue que le contrat ne nomme pas', async () => {
      // `notifications_locale_check`. La garantie est celle d'ADR 0002 — « la
      // base tranche, le code traduit » : une écriture qui contournerait le
      // typage doit échouer au moteur, et non produire une ligne inexploitable.
      const appointmentId = await seedAppointment(prismaUnscoped, salon);

      await expect(
        prismaUnscoped.notification.create({
          data: {
            tenantId: salon.tenantId,
            appointmentId,
            recipientUserId: salon.clientId,
            type: 'REMINDER_24H',
            channel: 'EMAIL',
            status: 'PENDING',
            locale: 'de',
            dedupeKey: `hors-vocabulaire-${randomUUID()}`,
            attemptCount: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
