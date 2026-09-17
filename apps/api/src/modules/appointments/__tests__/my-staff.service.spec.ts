import { randomUUID } from 'node:crypto';

import { MAX_APPOINTMENT_RANGE_DAYS } from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import type { StaffScheduleService } from '../../availability/staff-schedule.service';
import type { StaffTimeOffService } from '../../availability/staff-time-off.service';
import { TenantClockService } from '../../availability/tenant-clock.service';
import { AppointmentRangeTooWideError, StaffProfileNotFoundError } from '../appointments.errors';
import { MyStaffService } from '../my-staff.service';
import { FakeAppointmentsRepository } from './appointments.doubles';

/**
 * `MyStaffService` — la dérivation du praticien, et ce qu'elle projette (#811).
 *
 * Ce que cette suite prouve, et que la suite d'intégration ne peut pas :
 *
 * 1. le **décalage est recalculé par rendez-vous**. C'est la propriété la plus
 *    fragile du ticket — elle ne se voit qu'avec un fuseau à heure d'été et une
 *    fenêtre qui enjambe le changement d'heure, ce que le harnais HTTP, à `UTC`,
 *    ne peut pas montrer ;
 * 2. l'**ordre des refus** : fiche absente d'abord, fenêtre ensuite. Il est posé
 *    après deux lectures parallèles, et un `Promise.all` réordonné le ferait
 *    basculer sans qu'aucun type ne le signale ;
 * 3. l'**initiale** du nom, sur les deux cas que `charAt(0).toUpperCase()` casse.
 *
 * Les doubles de `availability` sont réduits au strict nécessaire : ce service
 * ne fait qu'appeler leurs portes, et ce qu'elles rendent est vérifié chez elles.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';

/** Paris, pour l'unique raison qui compte ici : deux décalages dans l'année. */
const PARIS = 'Europe/Paris';

function scheduleServiceDouble(): StaffScheduleService {
  return {
    forStaff: (staffId: string) =>
      Promise.resolve({
        staffId,
        timezone: PARIS,
        entries: [{ weekday: 2, startsAt: '09:00', endsAt: '18:00' }],
      }),
  } as unknown as StaffScheduleService;
}

function timeOffServiceDouble(): StaffTimeOffService {
  return { list: () => Promise.resolve([]) } as unknown as StaffTimeOffService;
}

function serviceWith(repository: FakeAppointmentsRepository): MyStaffService {
  return new MyStaffService(
    repository.asRepository(),
    new TenantClockService(),
    scheduleServiceDouble(),
    timeOffServiceDouble(),
  );
}

/** Un dépôt déjà pourvu d'un praticien rattaché au compte appelant. */
function staffedRepository(): FakeAppointmentsRepository {
  const repository = new FakeAppointmentsRepository();

  repository.seedTimeZone(TENANT, PARIS);
  repository.seedStaffProfile({
    tenantId: TENANT,
    staffId: STAFF,
    userId: USER,
    displayName: 'Camille',
  });

  return repository;
}

describe('MyStaffService', () => {
  describe('profile', () => {
    it('rend la fiche du compte, sans le compte', async () => {
      const repository = staffedRepository();

      const profile = await runWithTenant(TENANT, async () =>
        serviceWith(repository).profile(USER),
      );

      expect(profile).toEqual({ id: STAFF, displayName: 'Camille', isActive: true });
    });

    it('omet `bio` plutôt que de la rendre à `null`', async () => {
      const repository = new FakeAppointmentsRepository();
      repository.seedStaffProfile({
        tenantId: TENANT,
        staffId: STAFF,
        userId: USER,
        bio: null,
      });

      const profile = await runWithTenant(TENANT, async () =>
        serviceWith(repository).profile(USER),
      );

      expect(profile).not.toHaveProperty('bio');
    });

    it('rend la biographie quand elle est renseignée', async () => {
      const repository = new FakeAppointmentsRepository();
      repository.seedStaffProfile({
        tenantId: TENANT,
        staffId: STAFF,
        userId: USER,
        bio: 'Dix ans de shiatsu.',
      });

      const profile = await runWithTenant(TENANT, async () =>
        serviceWith(repository).profile(USER),
      );

      expect(profile.bio).toBe('Dix ans de shiatsu.');
    });

    it('refuse un compte sans fiche', async () => {
      const repository = staffedRepository();

      await expect(
        runWithTenant(TENANT, async () => serviceWith(repository).profile(randomUUID())),
      ).rejects.toBeInstanceOf(StaffProfileNotFoundError);
    });

    /**
     * Une fiche **désactivée** est rendue, et son agenda avec.
     *
     * C'est une décision, et elle se perd sans témoin : ajouter `isActive: true`
     * au `where` de `findStaffByUserId` est le geste le plus naturel du monde,
     * il ne casse aucune autre suite, et il ferait basculer en 404 tout
     * praticien qu'on vient de désactiver — y compris sur sa semaine passée,
     * qu'il reste seul à pouvoir relire. Les rendez-vous déjà pris, eux, restent
     * à honorer. `isActive` voyage donc jusqu'à l'écran, qui a de quoi le dire.
     */
    it('rend la fiche d’un praticien désactivé, et son agenda avec', async () => {
      const repository = new FakeAppointmentsRepository();
      repository.seedTimeZone(TENANT, PARIS);
      repository.seedStaffProfile({
        tenantId: TENANT,
        staffId: STAFF,
        userId: USER,
        displayName: 'Camille',
        isActive: false,
      });
      repository.seedAppointment({
        tenantId: TENANT,
        staffId: STAFF,
        startsAt: new Date('2026-10-20T08:00:00.000Z'),
        endsAt: new Date('2026-10-20T09:00:00.000Z'),
      });

      const service = serviceWith(repository);

      await expect(runWithTenant(TENANT, async () => service.profile(USER))).resolves.toMatchObject(
        { id: STAFF, isActive: false },
      );
      await expect(
        runWithTenant(TENANT, async () =>
          service.agenda({ userId: USER, from: '2026-10-20', to: '2026-10-20' }),
        ),
      ).resolves.toMatchObject({ staffId: STAFF });
    });
  });

  describe('agenda', () => {
    /**
     * Deux soins de part et d'autre du dernier dimanche d'octobre 2026 — la
     * nuit où Paris repasse de `+02:00` à `+01:00`.
     *
     * C'est le cas que booking-engine §4 désigne comme obligatoire : un décalage
     * mémorisé au niveau de la réponse aurait donné le même offset aux deux, et
     * l'écran aurait annoncé une des deux séances une heure à côté.
     */
    it('recalcule le décalage pour chaque rendez-vous', async () => {
      const repository = staffedRepository();

      // 2026-10-20 08:00Z → 10:00 à Paris (+02:00, heure d'été).
      repository.seedAppointment({
        tenantId: TENANT,
        staffId: STAFF,
        startsAt: new Date('2026-10-20T08:00:00.000Z'),
        endsAt: new Date('2026-10-20T09:00:00.000Z'),
      });
      // 2026-11-03 09:00Z → 10:00 à Paris (+01:00, heure d'hiver).
      repository.seedAppointment({
        tenantId: TENANT,
        staffId: STAFF,
        startsAt: new Date('2026-11-03T09:00:00.000Z'),
        endsAt: new Date('2026-11-03T10:00:00.000Z'),
      });

      const agenda = await runWithTenant(TENANT, async () =>
        serviceWith(repository).agenda({ userId: USER, from: '2026-10-20', to: '2026-11-03' }),
      );

      expect(agenda.timezone).toBe(PARIS);
      expect(agenda.appointments.map((row) => row.utcOffsetMinutes)).toEqual([120, 60]);
    });

    it('réduit la cliente à son prénom et à l’initiale de son nom', async () => {
      const repository = staffedRepository();
      const client = repository.seedClient({
        tenantId: TENANT,
        email: 'camille@example.test',
        firstName: 'Camille',
        lastName: 'ßeck',
      });

      repository.seedAppointment({
        tenantId: TENANT,
        staffId: STAFF,
        clientId: client.id,
        startsAt: new Date('2026-10-20T08:00:00.000Z'),
        endsAt: new Date('2026-10-20T09:00:00.000Z'),
      });

      const agenda = await runWithTenant(TENANT, async () =>
        serviceWith(repository).agenda({ userId: USER, from: '2026-10-20', to: '2026-10-20' }),
      );

      // `'ß'.toUpperCase()` rend `'SS'` : un caractère au plus, jamais deux.
      expect(agenda.appointments[0]?.client).toEqual({ firstName: 'Camille', lastInitial: 'S' });
    });

    it('complète la borne haute par la borne basse', async () => {
      const repository = staffedRepository();

      const agenda = await runWithTenant(TENANT, async () =>
        serviceWith(repository).agenda({ userId: USER, from: '2026-10-20', to: null }),
      );

      expect(agenda).toMatchObject({ from: '2026-10-20', to: '2026-10-20' });
    });

    it('complète la borne basse par la borne haute, jamais par aujourd’hui', async () => {
      const repository = staffedRepository();

      const agenda = await runWithTenant(TENANT, async () =>
        serviceWith(repository).agenda({ userId: USER, from: null, to: '2026-10-20' }),
      );

      expect(agenda).toMatchObject({ from: '2026-10-20', to: '2026-10-20' });
    });

    it('sert la journée **du salon**, et non celle de la machine', async () => {
      const repository = staffedRepository();

      // 22 h 30 UTC le 19 octobre, c'est déjà le 20 à Paris (+02:00).
      const agenda = await runWithTenant(TENANT, async () =>
        serviceWith(repository).agenda(
          { userId: USER, from: null, to: null },
          new Date('2026-10-19T22:30:00.000Z'),
        ),
      );

      expect(agenda).toMatchObject({ from: '2026-10-20', to: '2026-10-20' });
    });

    it('refuse une fenêtre inversée', async () => {
      const repository = staffedRepository();

      await expect(
        runWithTenant(TENANT, async () =>
          serviceWith(repository).agenda({ userId: USER, from: '2026-10-20', to: '2026-10-19' }),
        ),
      ).rejects.toBeInstanceOf(AppointmentRangeTooWideError);
    });

    /**
     * `calendarDaysBetween` compte les jours **bornes comprises** : du 1er au
     * 31 janvier fait trente et un jours, et non trente. La borne porte donc sur
     * le nombre de journées servies, pas sur l'écart entre deux dates — c'est ce
     * que la vue mois d'un calendrier demande, et c'est exactement la règle de
     * l'agenda du comptoir.
     */
    it(`accepte ${String(MAX_APPOINTMENT_RANGE_DAYS)} journées et refuse la trente-deuxième`, async () => {
      const repository = staffedRepository();
      const service = serviceWith(repository);

      await expect(
        runWithTenant(TENANT, async () =>
          service.agenda({ userId: USER, from: '2026-01-01', to: '2026-01-31' }),
        ),
      ).resolves.toMatchObject({ to: '2026-01-31' });

      await expect(
        runWithTenant(TENANT, async () =>
          service.agenda({ userId: USER, from: '2026-01-01', to: '2026-02-01' }),
        ),
      ).rejects.toBeInstanceOf(AppointmentRangeTooWideError);
    });

    it('refuse la fiche absente **avant** de juger la fenêtre', async () => {
      const repository = staffedRepository();

      await expect(
        runWithTenant(TENANT, async () =>
          serviceWith(repository).agenda({
            userId: randomUUID(),
            from: '2026-01-01',
            to: '2026-12-31',
          }),
        ),
      ).rejects.toBeInstanceOf(StaffProfileNotFoundError);
    });

    it('rend 404 d’établissement quand le fuseau manque', async () => {
      const repository = staffedRepository();
      repository.seedTimeZone(TENANT, null);

      await expect(
        runWithTenant(TENANT, async () =>
          serviceWith(repository).agenda({ userId: USER, from: null, to: null }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('schedule', () => {
    it('assemble horaires, absences et jours de fermeture', async () => {
      const repository = staffedRepository();
      repository.seedClosedWeekdays(TENANT, [7, 1]);

      const schedule = await runWithTenant(TENANT, async () =>
        serviceWith(repository).schedule({ userId: USER, from: '2026-10-20', to: '2026-10-26' }),
      );

      expect(schedule).toMatchObject({
        staffId: STAFF,
        timezone: PARIS,
        from: '2026-10-20',
        to: '2026-10-26',
      });
      expect(schedule.entries).toEqual([{ weekday: 2, startsAt: '09:00', endsAt: '18:00' }]);
      expect(schedule.timeOff).toEqual([]);
      // Triés à la lecture — un écran ne trie pas une semaine.
      expect(schedule.closedWeekdays).toEqual([1, 7]);
    });

    it('refuse un compte sans fiche', async () => {
      const repository = staffedRepository();

      await expect(
        runWithTenant(TENANT, async () =>
          serviceWith(repository).schedule({ userId: randomUUID(), from: null, to: null }),
        ),
      ).rejects.toBeInstanceOf(StaffProfileNotFoundError);
    });
  });
});
