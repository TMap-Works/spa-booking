import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { AvailabilityCacheService } from '../../availability/availability-cache';
import type { AvailabilityService } from '../../availability/availability.service';
import { TenantClockService } from '../../availability/tenant-clock.service';
import type { ServicesService } from '../../catalog/services.service';
import { AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { AppointmentRangeTooWideError, MAX_APPOINTMENT_RANGE_DAYS } from '../appointments.errors';
import { AppointmentsService } from '../appointments.service';
import type { AgendaAppointmentView } from '../appointments.types';
import {
  APPOINTMENT_STATUS_FILTERS,
  toAgendaInput,
  type AppointmentListQueryDto,
} from '../dto/list-appointments.dto';
import { AppointmentEvents } from '../events/appointment-events';
import type { SlotLockService } from '../slot-lock.service';
import { FakeAppointmentsRepository } from './appointments.doubles';

/**
 * L'agenda du back-office — `AppointmentsService.listAgenda` (#444).
 *
 * Ce que cette suite tient, et qui ne se voit dans aucune autre :
 *
 * 1. la **journée par défaut** est celle du salon, pas celle de la machine ;
 * 2. la fenêtre lue est une **intersection**, si bien qu'un soin à cheval sur
 *    minuit apparaît des deux côtés ;
 * 3. les bornes sont **jugées avant toute lecture**, et le refus est un 422 ;
 * 4. la réponse suit `appointmentSchema` du contrat — intervalle facturé, champs
 *    facultatifs **absents** plutôt que nuls, note interne servie.
 *
 * ## Les collaborateurs inutilisés sont laissés nus, et c'est délibéré
 *
 * `listAgenda` n'emprunte que le dépôt et l'horloge. Les cinq autres arguments du
 * constructeur sont passés sans double : la moindre lecture les ferait échouer
 * **bruyamment**, là où un double aurait laissé passer en silence un agenda qui
 * se serait mis à interroger le catalogue ligne par ligne.
 */

const TENANT = randomUUID();
const STAFF = randomUUID();
const OTHER_STAFF = randomUUID();
const SERVICE = randomUUID();
const OTHER_SERVICE = randomUUID();

const MINUTE_MS = 60_000;

/** Le tampon avant de la prestation semée — l'écart entre occupé et facturé. */
const BUFFER_BEFORE_MINUTES = 10;
const DURATION_MINUTES = 60;

/**
 * Ce que `listAgenda` n'emprunte pas.
 *
 * Volontairement non typé en double : voir l'en-tête. Le transtypage est le seul
 * moyen de dire « ce collaborateur ne doit pas être touché » au compilateur,
 * puisqu'il n'y a rien à implémenter.
 */
function untouched<T>(): T {
  return undefined as unknown as T;
}

function agendaService(repository: FakeAppointmentsRepository): AppointmentsService {
  return new AppointmentsService(
    repository.asRepository(),
    untouched<ServicesService>(),
    untouched<AvailabilityService>(),
    // Le seul « vrai » collaborateur superflu : `AppointmentEvents` est construit
    // parce qu'il exige un journal, pas parce que l'agenda l'appelle.
    untouched<AppointmentEvents>(),
    new AppointmentLifecycleService(),
    untouched<AvailabilityCacheService>(),
    untouched<SlotLockService>(),
    new TenantClockService(),
  );
}

/** L'intervalle **occupé** d'un soin qui commence à `billedStart`. */
function occupied(billedStart: Date): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(billedStart.getTime() - BUFFER_BEFORE_MINUTES * MINUTE_MS),
    endsAt: new Date(billedStart.getTime() + (DURATION_MINUTES + 10) * MINUTE_MS),
  };
}

const DISPLAY = {
  staffDisplayName: 'Camille',
  serviceName: 'Massage 60 min',
  serviceDurationMinutes: DURATION_MINUTES,
  serviceBufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
  servicePriceAmountMinor: 8000,
  servicePriceCurrency: 'EUR',
};

/** La requête telle que le contrôleur la passe, tous filtres vides. */
function query(overrides: Partial<AppointmentListQueryDto> = {}): AppointmentListQueryDto {
  return { ...overrides };
}

async function listAgenda(
  repository: FakeAppointmentsRepository,
  overrides: Partial<AppointmentListQueryDto> = {},
  now = new Date('2026-03-04T12:00:00.000Z'),
): Promise<AgendaAppointmentView[]> {
  return runWithTenant(TENANT, () =>
    agendaService(repository).listAgenda(toAgendaInput(query(overrides)), now),
  );
}

describe('AppointmentsService.listAgenda', () => {
  let repository: FakeAppointmentsRepository;

  beforeEach(() => {
    repository = new FakeAppointmentsRepository();
  });

  /** Un rendez-vous du salon courant, au créneau **facturé** demandé. */
  const seed = (
    billedStart: string,
    overrides: Parameters<FakeAppointmentsRepository['seedAppointment']>[0] extends infer T
      ? Partial<Omit<T, 'tenantId' | 'startsAt' | 'endsAt'>>
      : never = {},
  ): string =>
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF,
      serviceId: SERVICE,
      ...occupied(new Date(billedStart)),
      display: DISPLAY,
      ...overrides,
    }).id;

  it('rend les rendez-vous de la plage, du plus tôt au plus tard', async () => {
    const mercredi = seed('2026-03-04T10:00:00.000Z');
    const lundi = seed('2026-03-02T09:00:00.000Z');
    const dimanche = seed('2026-03-08T15:00:00.000Z');
    // Hors plage des deux côtés : la veille et le lendemain de la fenêtre.
    seed('2026-03-01T10:00:00.000Z');
    seed('2026-03-09T10:00:00.000Z');

    const agenda = await listAgenda(repository, { from: '2026-03-02', to: '2026-03-08' });

    expect(agenda.map((row) => row.id)).toEqual([lundi, mercredi, dimanche]);
  });

  it('départage deux rendez-vous du même instant par identifiant', async () => {
    // Deux praticiens à 10 h est le cas le plus banal d'un salon. Sans le second
    // critère de tri, la grille réordonnerait ses colonnes d'un rafraîchissement
    // à l'autre.
    const first = seed('2026-03-04T10:00:00.000Z');
    const second = seed('2026-03-04T10:00:00.000Z', { staffId: OTHER_STAFF });

    const agenda = await listAgenda(repository, { from: '2026-03-04', to: '2026-03-04' });

    expect(agenda.map((row) => row.id)).toEqual([first, second].sort((a, b) => a.localeCompare(b)));
  });

  it('rend l’intervalle facturé, jamais l’intervalle occupé de la base', async () => {
    seed('2026-03-04T10:00:00.000Z');

    const [row] = await listAgenda(repository, { from: '2026-03-04', to: '2026-03-04' });

    // La base porte 09:50 → 11:10 ; la cliente a réservé 10:00 → 11:00. Servir
    // l'occupé ferait annoncer au comptoir dix minutes trop tôt, et lui ferait
    // lire la cadence interne du salon comme une heure de rendez-vous.
    expect(row?.startsAt).toBe('2026-03-04T10:00:00.000Z');
    expect(row?.endsAt).toBe('2026-03-04T11:00:00.000Z');
  });

  it('sert la journée courante **du salon** quand la plage est absente', async () => {
    // Kiritimati est à UTC+14 : à 12 h UTC le 4 mars, il y est déjà le 5. Un
    // agenda qui prendrait la journée du serveur montrerait au salon la veille
    // de ce qu'il vit.
    repository.seedTimeZone(TENANT, 'Pacific/Kiritimati');
    const aujourdhuiLaBas = seed('2026-03-04T20:00:00.000Z'); // 5 mars 10 h local
    seed('2026-03-04T06:00:00.000Z'); // 4 mars 20 h local — hier, là-bas

    const agenda = await listAgenda(repository);

    expect(agenda.map((row) => row.id)).toEqual([aujourdhuiLaBas]);
  });

  it('fait valoir `to` = `from` quand seule la borne basse est donnée', async () => {
    const mercredi = seed('2026-03-04T10:00:00.000Z');
    seed('2026-03-05T10:00:00.000Z');

    const agenda = await listAgenda(repository, { from: '2026-03-04' });

    expect(agenda.map((row) => row.id)).toEqual([mercredi]);
  });

  it('fait valoir `from` = `to` quand seule la borne haute est donnée', async () => {
    // Symétrique du cas précédent, et `appointmentListQuerySchema` déclare les
    // deux valides. Compléter `from` par « aujourd'hui » aurait rendu 422 toute
    // borne haute passée — une plage inversée pour une requête que le contrat
    // annonce.
    const mercredi = seed('2026-03-04T10:00:00.000Z');
    seed('2026-03-05T10:00:00.000Z');

    const agenda = await listAgenda(repository, { to: '2026-03-04' });

    expect(agenda.map((row) => row.id)).toEqual([mercredi]);
  });

  it('trie sur l’instant facturé, jamais sur l’occupé que la base indexe', async () => {
    // Deux tampons avant différents suffisent à séparer les deux ordres : le soin
    // de 10:30 occupe la cabine dès 10:00, donc **avant** celui de 10:15 qui n'a
    // pas de tampon. Trier sur ce que la base indexe rendait alors 10:30 puis
    // 10:15 — une grille qui affiche ses lignes dans le désordre.
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF,
      serviceId: SERVICE,
      startsAt: new Date('2026-03-04T10:00:00.000Z'),
      endsAt: new Date('2026-03-04T11:30:00.000Z'),
      display: { ...DISPLAY, serviceBufferBeforeMinutes: 30 },
    });
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: OTHER_STAFF,
      serviceId: OTHER_SERVICE,
      startsAt: new Date('2026-03-04T10:15:00.000Z'),
      endsAt: new Date('2026-03-04T11:15:00.000Z'),
      display: { ...DISPLAY, serviceBufferBeforeMinutes: 0 },
    });

    const agenda = await listAgenda(repository, { from: '2026-03-04' });

    expect(agenda.map((row) => row.startsAt)).toEqual([
      '2026-03-04T10:15:00.000Z',
      '2026-03-04T10:30:00.000Z',
    ]);
  });

  it('montre des deux côtés le soin à cheval sur minuit', async () => {
    // L'intervalle **occupé** commence la veille à 23:55 — le tampon de cabine —
    // pour un soin de 00:05. Un filtre sur le seul début de ligne l'aurait fait
    // disparaître de la journée où le comptoir l'attend.
    const cheval = seed('2026-03-05T00:05:00.000Z');

    const veille = await listAgenda(repository, { from: '2026-03-04', to: '2026-03-04' });
    const jour = await listAgenda(repository, { from: '2026-03-05', to: '2026-03-05' });

    expect(veille.map((row) => row.id)).toEqual([cheval]);
    expect(jour.map((row) => row.id)).toEqual([cheval]);
  });

  it('refuse une plage inversée avant même de lire', async () => {
    await expect(listAgenda(repository, { from: '2026-03-08', to: '2026-03-02' })).rejects.toThrow(
      AppointmentRangeTooWideError,
    );
  });

  it(`accepte exactement ${String(MAX_APPOINTMENT_RANGE_DAYS)} jours et refuse le suivant`, async () => {
    // Bornes comprises : du 1er au 31 mars, c'est trente et une journées.
    await expect(listAgenda(repository, { from: '2026-03-01', to: '2026-03-31' })).resolves.toEqual(
      [],
    );
    await expect(listAgenda(repository, { from: '2026-03-01', to: '2026-04-01' })).rejects.toThrow(
      AppointmentRangeTooWideError,
    );
  });

  it('rend 404 quand l’établissement n’existe plus', async () => {
    // `tenants.timezone` est `NOT NULL` : l'absence ne peut venir que d'un jeton
    // signé sur une portée disparue.
    repository.seedTimeZone(TENANT, null);

    await expect(listAgenda(repository)).rejects.toThrow(NotFoundError);
  });

  describe('filtres', () => {
    let deStaff: string;
    let deService: string;

    beforeEach(() => {
      deStaff = seed('2026-03-04T09:00:00.000Z');
      deService = seed('2026-03-04T11:00:00.000Z', {
        staffId: OTHER_STAFF,
        serviceId: OTHER_SERVICE,
      });
    });

    it('restreint à un praticien', async () => {
      const agenda = await listAgenda(repository, { from: '2026-03-04', staffId: STAFF });

      expect(agenda.map((row) => row.id)).toEqual([deStaff]);
    });

    it('restreint à une prestation', async () => {
      const agenda = await listAgenda(repository, {
        from: '2026-03-04',
        serviceId: OTHER_SERVICE,
      });

      expect(agenda.map((row) => row.id)).toEqual([deService]);
    });

    it('restreint à une fiche cliente', async () => {
      const cliente = randomUUID();
      const sien = seed('2026-03-04T14:00:00.000Z', { clientId: cliente });

      const agenda = await listAgenda(repository, { from: '2026-03-04', clientId: cliente });

      expect(agenda.map((row) => row.id)).toEqual([sien]);
    });

    it('restreint aux statuts demandés, dans le vocabulaire du contrat', async () => {
      const annule = seed('2026-03-04T16:00:00.000Z', { status: 'CANCELLED' });

      // Le front envoie `pending` / `cancelled` — la casse d'`appointmentStatusSchema`
      // de `@spa/shared` —, jamais celle de l'énumération PostgreSQL.
      const agenda = await listAgenda(repository, {
        from: '2026-03-04',
        statuses: ['cancelled'],
      });

      expect(agenda.map((row) => row.id)).toEqual([annule]);
    });

    it('sert tous les statuts quand aucun n’est demandé', async () => {
      seed('2026-03-04T16:00:00.000Z', { status: 'CANCELLED' });

      const agenda = await listAgenda(repository, { from: '2026-03-04' });

      // Un agenda montre aussi ce qui a été annulé : c'est le créneau libéré que
      // le comptoir cherche à revendre.
      expect(agenda).toHaveLength(3);
    });

    it('rend une liste vide, jamais une erreur, sur un identifiant inconnu', async () => {
      // Un `staffId` d'un autre établissement tombe exactement ici : rien ne le
      // distingue d'un identifiant qui n'existe nulle part, et c'est le propos —
      // une erreur ferait de cette route une sonde d'annuaire
      // (tenant-isolation §4).
      await expect(
        listAgenda(repository, { from: '2026-03-04', staffId: randomUUID() }),
      ).resolves.toEqual([]);
    });
  });

  describe('la ligne servie', () => {
    it('imbrique la cliente, le praticien et la prestation', async () => {
      const cliente = repository.seedClient({
        tenantId: TENANT,
        email: 'camille@example.test',
        firstName: 'Camille',
        lastName: 'Durand',
      });
      seed('2026-03-04T10:00:00.000Z', { clientId: cliente.id, priceAmountMinor: 7500 });

      const [row] = await listAgenda(repository, { from: '2026-03-04' });

      expect(row?.client).toEqual({ id: cliente.id, firstName: 'Camille', lastName: 'Durand' });
      expect(row?.staff).toEqual({ id: STAFF, displayName: 'Camille' });
      expect(row?.service).toEqual({
        id: SERVICE,
        name: 'Massage 60 min',
        durationMinutes: DURATION_MINUTES,
        // Le tarif **courant** du catalogue…
        price: { amountMinor: 8000, currency: 'EUR' },
      });
      // …à ne pas confondre avec le prix figé à la réservation, qui est celui que
      // cette cliente-là doit. Les deux diffèrent dès que le salon a changé ses
      // tarifs, et le comptoir a besoin des deux.
      expect(row?.price).toEqual({ amountMinor: 7500, currency: 'EUR' });
    });

    it('sert la note interne du praticien — la sortie de back-office de #317', async () => {
      seed('2026-03-04T10:00:00.000Z', { staffNote: 'cabine sans musique' });

      const [row] = await listAgenda(repository, { from: '2026-03-04' });

      expect(row?.staffNote).toBe('cabine sans musique');
    });

    it('omet les champs facultatifs plutôt que de les poser à `null`', async () => {
      seed('2026-03-04T10:00:00.000Z');

      const [row] = await listAgenda(repository, { from: '2026-03-04' });

      // `appointmentSchema` les déclare `.optional()` et non `.nullable()` : un
      // `null` explicite y échouerait, et c'est tout l'agenda qui cesserait de se
      // lire pour une note absente.
      for (const field of [
        'clientNote',
        'staffNote',
        'cancelledAt',
        'cancellationReason',
        'rescheduledFromId',
      ] as const) {
        expect(row).not.toHaveProperty(field);
      }
    });

    it('n’expose jamais le tenant ni l’auteur de l’annulation', async () => {
      seed('2026-03-04T10:00:00.000Z');

      const [row] = await listAgenda(repository, { from: '2026-03-04' });

      // Le premier n'apprend rien à l'appelant et invite aux essais
      // (tenant-isolation §4) ; le second n'est pas dans `appointmentSchema` —
      // « vous avez annulé » est une question du parcours public.
      expect(JSON.stringify(row)).not.toContain(TENANT);
      expect(row).not.toHaveProperty('cancelledBy');
    });

    it('rend la trace d’annulation quand il y en a une', async () => {
      const annule = seed('2026-03-04T10:00:00.000Z');
      await runWithTenant(TENANT, () =>
        repository.cancel({
          appointmentId: annule,
          cancelledAt: new Date('2026-03-03T08:00:00.000Z'),
          cancelledBy: 'STAFF',
          reason: 'cliente injoignable',
        }),
      );

      const [row] = await listAgenda(repository, { from: '2026-03-04' });

      expect(row?.cancelledAt).toBe('2026-03-03T08:00:00.000Z');
      // Le motif ne sort **que** par cette route : `AppointmentView` le refuse
      // délibérément au parcours public (#40).
      expect(row?.cancellationReason).toBe('cliente injoignable');
    });
  });
});

describe('toAgendaInput', () => {
  it('traduit les statuts du contrat vers le vocabulaire du domaine', () => {
    expect(toAgendaInput({ statuses: ['pending', 'no_show'] }).statuses).toEqual([
      'PENDING',
      'NO_SHOW',
    ]);
  });

  it('accepte les cinq statuts du contrat, et eux seuls', () => {
    // Le témoin de la dérivation : la liste que la requête accepte est celle du
    // domaine, en minuscules. Un sixième statut ajouté d'un côté sans l'autre
    // ferait refuser en 400 une requête que la réponse peut pourtant rendre.
    expect([...APPOINTMENT_STATUS_FILTERS]).toEqual([
      'pending',
      'confirmed',
      'completed',
      'cancelled',
      'no_show',
    ]);
  });

  it('rend `null` — et non un tableau vide — pour un filtre absent', () => {
    // La distinction porte tout le sens : `null` veut dire « aucun filtre »,
    // un tableau vide voudrait dire « aucun statut acceptable », donc une
    // réponse toujours vide.
    expect(toAgendaInput({})).toEqual({
      from: null,
      to: null,
      staffId: null,
      clientId: null,
      serviceId: null,
      statuses: null,
    });
  });
});
