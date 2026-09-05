import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import {
  BUFFER_BEFORE_MINUTES,
  SERVICE_DURATION_MINUTES,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';

/**
 * `GET /api/v1/appointments` — l'agenda du back-office (#444).
 *
 * Ce que cette suite exerce, et que les tests unitaires ne peuvent pas prouver :
 *
 * 1. la route est **servie**. C'est la raison d'être du ticket : les contrats
 *    étaient publiés depuis longtemps, l'appel rendait `404 Cannot GET
 *    /api/v1/appointments` — un contrôleur qui compile et passe ses tests
 *    unitaires peut parfaitement ne répondre à rien ;
 * 2. le **DTO de requête** est appliqué : un champ non déclaré est refusé, un
 *    statut hors du vocabulaire du contrat aussi, et la forme répétée de
 *    `statuses` est lue comme un tableau ;
 * 3. la **garde** tient : `STAFF` au minimum, jamais le parcours client ;
 * 4. la réponse porte l'intervalle **facturé** et les trois *summaries*.
 *
 * La frontière inter-tenant, elle, a sa propre suite
 * (`appointments-agenda.isolation-spec.ts`).
 */

const AGENDA_PATH = '/api/v1/appointments';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** L'intervalle **occupé** d'un soin qui commence à `billedStart`. */
function occupied(billedStart: Date): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(billedStart.getTime() - BUFFER_BEFORE_MINUTES * MINUTE_MS),
    endsAt: new Date(billedStart.getTime() + (SERVICE_DURATION_MINUTES + 10) * MINUTE_MS),
  };
}

/** La date civile d'un instant — le harnais est à `UTC`, voir son en-tête. */
function calendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Dix heures du matin, `offsetDays` jours plus tard — l'ancre de tous les soins
 * semés ici.
 *
 * **Ancrée sur minuit, jamais sur `Date.now()` décalé.** Un `now + 24 h` porte
 * l'heure du jour où la suite tourne : lancée à 22 h 30, la ligne « demain
 * + 2 h » bascule sur le jour suivant, sort de la journée interrogée, et la
 * suite rougit une fois sur treize sans qu'une ligne de production ait bougé.
 * Dix heures laissent de la marge des deux côtés — le tampon de cabine recule le
 * début, la durée et le tampon d'après repoussent la fin, et tout tient dans la
 * journée civile visée.
 *
 * L'agenda ne filtre pas le passé : une journée courante ancrée à 10 h se sert
 * donc aussi bien à 8 h qu'à 23 h.
 */
function billedAt(offsetDays: number, hourUtc = 10): Date {
  const day = new Date(Date.now() + offsetDays * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);

  return new Date(day.getTime() + hourUtc * HOUR_MS);
}

interface AgendaRow {
  readonly id: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly client: { readonly id: string; readonly firstName: string; readonly lastName: string };
  readonly staff: { readonly id: string; readonly displayName: string };
  readonly service: { readonly id: string; readonly name: string; readonly durationMinutes: number };
  readonly staffNote?: string;
  readonly createdAt: string;
}

describe('GET /api/v1/appointments', () => {
  let harness: AppointmentsHarness;

  /** Le soin de demain, dix heures du matin — l'ancre de toute cette suite. */
  const demainBillé = billedAt(1);

  let clientId: string;
  let demain: string;
  let apresDemain: string;
  let annule: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();

    // La fiche cliente est semée **avant** les rendez-vous, et son identifiant
    // sert de clé : c'est ce qui fait que la jointure de `listAgenda` a quelque
    // chose à trouver, et que la réponse porte un nom plutôt qu'un défaut.
    clientId = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'camille@example.test',
      firstName: 'Camille',
      lastName: 'Durand',
    }).id;

    const seed = (
      billedStart: Date,
      overrides: Parameters<AppointmentsHarness['appointments']['seedAppointment']>[0] extends infer T
        ? Partial<Omit<T, 'tenantId' | 'staffId' | 'startsAt' | 'endsAt'>>
        : never = {},
    ): string =>
      harness.appointments.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staffId,
        serviceId: harness.a.serviceId,
        clientId,
        ...occupied(billedStart),
        display: {
          staffDisplayName: 'Camille',
          serviceName: 'Massage 60 min',
          serviceDurationMinutes: SERVICE_DURATION_MINUTES,
          serviceBufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
        },
        ...overrides,
      }).id;

    demain = seed(demainBillé, { staffNote: 'cabine sans musique' });
    apresDemain = seed(new Date(demainBillé.getTime() + DAY_MS));
    annule = seed(new Date(demainBillé.getTime() + 2 * HOUR_MS), { status: 'CANCELLED' });
  });

  afterEach(async () => {
    await harness.close();
  });

  const bearer = async (role: UserRole = 'STAFF'): Promise<string> => {
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId: randomUUID(), tenantId: harness.a.tenant.id, role });
    return `Bearer ${token}`;
  };

  const rows = (body: unknown): readonly AgendaRow[] => body as readonly AgendaRow[];
  const ids = (body: unknown): string[] => rows(body).map((row) => row.id);

  it('sert la plage demandée, du plus tôt au plus tard', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${calendarDate(demainBillé)}&to=${calendarDate(demainBillé)}`)
      .set('Authorization', await bearer())
      .expect(200);

    // La journée de demain porte le soin du matin et celui, annulé, de deux
    // heures plus tard — un agenda montre aussi les créneaux libérés.
    expect(ids(response.body).sort()).toEqual([demain, annule].sort());
    expect(ids(response.body)).not.toContain(apresDemain);
  });

  it('rend une ligne complète — *summaries*, intervalle facturé, note interne', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${calendarDate(demainBillé)}&statuses=pending`)
      .set('Authorization', await bearer())
      .expect(200);

    const [row] = rows(response.body);

    expect(row?.id).toBe(demain);
    expect(row?.client).toEqual({ id: clientId, firstName: 'Camille', lastName: 'Durand' });
    expect(row?.staff).toEqual({ id: harness.a.staffId, displayName: 'Camille' });
    expect(row?.service.id).toBe(harness.a.serviceId);
    expect(row?.service.durationMinutes).toBe(SERVICE_DURATION_MINUTES);
    // L'intervalle **facturé** : la base porte l'occupé, tampons compris.
    expect(row?.startsAt).toBe(demainBillé.toISOString());
    expect(new Date(row?.endsAt ?? 0).getTime() - demainBillé.getTime()).toBe(
      SERVICE_DURATION_MINUTES * MINUTE_MS,
    );
    // La « sortie distincte, gardée par un rôle » qu'annonçait #317 : la note
    // interne ne franchit cette frontière-ci et aucune autre.
    expect(row?.staffNote).toBe('cabine sans musique');
    expect(row?.createdAt).toEqual(expect.any(String));
  });

  it('lit la forme répétée de `statuses` comme un tableau', async () => {
    // `?statuses=pending&statuses=cancelled` est ce qu'`URLSearchParams.append`
    // produit, et la seule forme qu'un tableau prenne dans une chaîne de requête.
    const response = await request(harness.server())
      .get(
        `${AGENDA_PATH}?from=${calendarDate(demainBillé)}&statuses=pending&statuses=cancelled`,
      )
      .set('Authorization', await bearer())
      .expect(200);

    expect(ids(response.body).sort()).toEqual([demain, annule].sort());
  });

  it('sert la journée courante quand la plage est absente', async () => {
    const aujourdhui = harness.appointments.seedAppointment({
      tenantId: harness.a.tenant.id,
      staffId: harness.a.staffId,
      serviceId: harness.a.serviceId,
      clientId,
      // Dix heures **aujourd'hui**, et non « dans une heure » : l'agenda ne
      // filtre pas le passé, et une ligne posée à l'heure qu'il est bascule sur
      // demain dès que la suite tourne en fin de journée.
      ...occupied(billedAt(0)),
    }).id;

    const response = await request(harness.server())
      .get(AGENDA_PATH)
      .set('Authorization', await bearer())
      .expect(200);

    // Un agenda sans plage est l'écran d'ouverture du comptoir : la journée du
    // salon, et rien d'autre.
    expect(ids(response.body)).toContain(aujourdhui);
    expect(ids(response.body)).not.toContain(apresDemain);
  });

  it('refuse une plage trop large en 422, sans rien servir', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=2026-03-01&to=2026-05-01`)
      .set('Authorization', await bearer())
      .expect(422);

    expect(response.body.code).toBe('APPOINTMENT_RANGE_TOO_WIDE');
    expect(response.body.details).toMatchObject({ from: '2026-03-01', to: '2026-05-01' });
  });

  it('refuse une date civile inexistante en 400, en nommant le champ', async () => {
    // `2026-02-31` satisfait le motif et ne satisfait pas le calendrier. Sans ce
    // contrôle, la fenêtre glisserait de deux jours en silence.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=2026-02-31`)
      .set('Authorization', await bearer())
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).toContain('from');
  });

  it('refuse un statut hors du vocabulaire du contrat', async () => {
    // `PENDING` est la casse de l'énumération PostgreSQL, pas celle du contrat :
    // le front envoie `pending`, et accepter les deux aurait fait diverger la
    // requête de ce que `appointmentStatusSchema` déclare.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?statuses=PENDING`)
      .set('Authorization', await bearer())
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('refuse tout champ que le DTO ne déclare pas', async () => {
    // `ValidationPipe` est en `forbidNonWhitelisted` : un `tenantId` glissé dans
    // la chaîne de requête est nommé et refusé, jamais ignoré en silence — donc
    // jamais interprété comme un filtre (tenant-isolation §2).
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?tenantId=${harness.b.tenant.id}`)
      .set('Authorization', await bearer())
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('refuse la lecture sans jeton', async () => {
    const response = await request(harness.server()).get(AGENDA_PATH).expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('refuse la lecture au parcours client', async () => {
    // Le deuxième critère du ticket : l'agenda est une surface de back-office.
    // Une cliente a `/appointments/mine`, qui ne lui montre que les siens.
    const response = await request(harness.server())
      .get(AGENDA_PATH)
      .set('Authorization', await bearer('CLIENT'))
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect(JSON.stringify(response.body)).not.toContain(demain);
  });

  it('l’ouvre au rang le plus bas autorisé — `STAFF`', async () => {
    // Sans ce cas, une garde trop haute — `MANAGER` — ferait verdir tous les
    // refus ci-dessus sans que personne ne puisse ouvrir son agenda.
    await request(harness.server())
      .get(AGENDA_PATH)
      .set('Authorization', await bearer('STAFF'))
      .expect(200);
  });
});
