/**
 * La frontière des dates du module `appointments` (#297).
 *
 * ## Ce que cette suite prouve, et que rien d'autre ne prouve
 *
 * Le critère de #297 porte sur un trajet, pas sur un format : « un `+02:00`
 * entrant est accepté **et stocké au bon instant UTC** ». Trois maillons le
 * composent, et un test qui n'en regarderait qu'un laisserait les deux autres
 * libres de diverger :
 *
 * 1. le **DTO** accepte l'offset — `@IsOffsetDateTime()` ;
 * 2. le `ValidationPipe` réellement monté dans `app.module.ts` le laisse passer,
 *    avec `whitelist` et `forbidNonWhitelisted` ;
 * 3. le **contrôleur** en dérive le `Date` qui descend au service, puis à
 *    `@db.Timestamptz(6)`. C'est ce `Date`-là qui est « l'instant stocké », et
 *    c'est le seul endroit où une conversion peut encore se tromper de fuseau.
 *
 * Le service est donc remplacé par un double qui **capture** l'instant reçu :
 * ce qu'on regarde n'est pas ce que la réservation produit — `appointments.service.spec.ts`
 * s'en charge —, c'est ce que la frontière lui transmet.
 *
 * Le pendant côté contrat vit dans `packages/shared/src/__tests__/schemas.spec.ts` :
 * `createAppointmentRequestSchema` et `rescheduleAppointmentRequestSchema` y
 * normalisent les mêmes chaînes. Les deux suites doivent rester d'accord — c'est
 * la seule frontière, écrite deux fois en attendant #26.
 */

import { ValidationPipe } from '@nestjs/common';

import type { AppointmentsService } from '../appointments.service';
import type {
  AppointmentView,
  BookAppointmentInput,
  RescheduleAppointmentInput,
} from '../appointments.types';
import { BookAppointmentDto } from '../dto/book-appointment.dto';
import { RescheduleAppointmentDto } from '../dto/reschedule-appointment.dto';
import { PublicAppointmentsController } from '../public-appointments.controller';

/** Le pipe tel qu'`app.module.ts` le monte pour toute l'application. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

/** Des coordonnées valides — le sujet du test est ailleurs. */
const CLIENT = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
};

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const SERVICE_ID = '9a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';

/**
 * Le service, réduit à ce qui nous intéresse : l'instant qu'il a reçu.
 *
 * Rendre un `AppointmentView` plausible n'a aucune importance ici — le
 * contrôleur le recopie tel quel — mais il faut bien en rendre un, sans quoi le
 * handler échouerait avant l'assertion.
 */
function capturingService(): {
  readonly controller: PublicAppointmentsController;
  readonly captured: Record<'book' | 'reschedule', Date | null>;
} {
  const captured: Record<'book' | 'reschedule', Date | null> = { book: null, reschedule: null };

  const double = {
    book: (input: BookAppointmentInput): Promise<AppointmentView> => {
      captured.book = input.startsAt;

      return Promise.resolve(view());
    },
    reschedule: (input: RescheduleAppointmentInput): Promise<AppointmentView> => {
      captured.reschedule = input.startsAt;

      return Promise.resolve(view());
    },
  };

  return {
    controller: new PublicAppointmentsController(double as unknown as AppointmentsService),
    captured,
  };
}

/** L'instant capturé, ou l'échec explicite si la frontière n'a rien laissé passer. */
function instantOf(captured: Date | null, method: string): string {
  if (captured === null) {
    throw new Error(`${method} n’a pas été appelé — la frontière a refusé la requête.`);
  }

  return captured.toISOString();
}

function view(): AppointmentView {
  return {
    id: APPOINTMENT_ID,
    status: 'PENDING',
    serviceId: SERVICE_ID,
    staffId: APPOINTMENT_ID,
    clientId: APPOINTMENT_ID,
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };
}

/** Fait franchir au corps brut le pipe global, puis le DTO. */
async function validate<T>(type: new () => T, body: unknown): Promise<T> {
  return (await pipe.transform(body, { type: 'body', metatype: type })) as T;
}

async function refusalFor(type: new () => unknown, body: unknown): Promise<string> {
  try {
    await validate(type, body);

    return '';
  } catch (error) {
    return JSON.stringify((error as { getResponse: () => unknown }).getResponse());
  }
}

/** Corps de réservation complet, dont seul `startsAt` varie d'un cas à l'autre. */
function bookingBody(startsAt: string): Record<string, unknown> {
  return { serviceId: SERVICE_ID, startsAt, client: { ...CLIENT } };
}

/** L'instant que le service recevrait pour ce corps de réservation. */
async function bookedInstant(startsAt: string): Promise<string> {
  const { controller, captured } = capturingService();

  await controller.book(await validate(BookAppointmentDto, bookingBody(startsAt)));

  return instantOf(captured.book, 'book');
}

/** L'instant que le service recevrait pour ce corps de report. */
async function rescheduledInstant(startsAt: string): Promise<string> {
  const { controller, captured } = capturingService();

  await controller.reschedule(APPOINTMENT_ID, await validate(RescheduleAppointmentDto, { startsAt }));

  return instantOf(captured.reschedule, 'reschedule');
}

describe('début de rendez-vous entrant', () => {
  it('accepte un instant UTC suffixé Z sans le déplacer', async () => {
    expect(await bookedInstant('2026-09-01T09:00:00Z')).toBe('2026-09-01T09:00:00.000Z');
    expect(await rescheduledInstant('2026-09-01T09:00:00Z')).toBe('2026-09-01T09:00:00.000Z');
  });

  it('accepte l’offset du salon et le normalise en UTC avant le service', async () => {
    // 11:30 à Paris le 3 mars, heure d'hiver. Le front n'a pas à convertir : il
    // le ferait avec le fuseau du navigateur, qui n'est pas celui du salon dès
    // qu'on réserve en voyage.
    expect(await bookedInstant('2026-03-03T11:30:00+01:00')).toBe('2026-03-03T10:30:00.000Z');
    expect(await rescheduledInstant('2026-03-03T11:30:00+01:00')).toBe('2026-03-03T10:30:00.000Z');
  });

  it('lit au bon instant la nuit du passage à l’heure d’été', async () => {
    // L'horloge de Paris saute de 02:00 à 03:00 : `03:30+02:00` est le premier
    // instant de la nouvelle heure, soit `01:30Z`. Une conversion faite avec
    // l'offset d'hiver le placerait à `02:30Z` — la cliente arriverait une heure
    // après son rendez-vous, et le praticien aurait attendu pour rien.
    expect(await bookedInstant('2026-03-29T03:30:00+02:00')).toBe('2026-03-29T01:30:00.000Z');
    expect(await rescheduledInstant('2026-03-29T03:30:00+02:00')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('distingue les deux 02:30 de la nuit du passage à l’heure d’hiver', async () => {
    // `02:30` sonne deux fois à Paris le 25 octobre, à une heure réelle d'écart.
    // C'est l'offset porté par la chaîne — et lui seul — qui dit laquelle des
    // deux : `tenants.timezone` ne saurait pas trancher, et c'est exactement
    // pourquoi la frontière exige un offset explicite plutôt qu'une date-heure
    // nue rapportée au fuseau du salon.
    expect(await bookedInstant('2026-10-25T02:30:00+02:00')).toBe('2026-10-25T00:30:00.000Z');
    expect(await bookedInstant('2026-10-25T02:30:00+01:00')).toBe('2026-10-25T01:30:00.000Z');
  });

  it('accepte un offset négatif et conserve la fraction de seconde', async () => {
    expect(await bookedInstant('2026-03-28T15:30:00.500-10:00')).toBe('2026-03-29T01:30:00.500Z');
  });

  it('refuse une date-heure nue — le serveur n’a pas à deviner le fuseau', async () => {
    expect(await refusalFor(BookAppointmentDto, bookingBody('2026-03-29T03:30:00'))).toContain(
      'offset explicite',
    );
    expect(await refusalFor(RescheduleAppointmentDto, { startsAt: '2026-03-29T03:30:00' })).toContain(
      'offset explicite',
    );
  });

  it('refuse une date civile seule, un epoch, une heure hors journée, un 31 février', async () => {
    // Cette liste est reprise **mot pour mot** par le pendant côté contrat,
    // `packages/shared/src/__tests__/schemas.spec.ts` : c'est ce qui rend la
    // double écriture de la frontière vérifiable. Une liste plus courte d'un
    // côté laisserait la copie d'en face bouger seule sans qu'aucune des deux
    // suites ne rougisse.
    //
    // Deux cas méritent leur mot. `24:00` n'est pas du RFC 3339 et `new Date` le
    // reporterait sans un mot au lendemain. `2026-02-31T10:00:00Z` satisfait le
    // motif, et `Date.parse` le ramènerait au 3 mars — un rendez-vous déplacé de
    // deux jours par une faute de frappe.
    const refused = [
      '2026-03-29T03:30:00',
      '2026-03-29',
      '2026-03-29T24:00:00Z',
      '2026-02-31T10:00:00Z',
      '1774743000',
      '2026-03-29T03:30:00+0200',
      '',
    ];

    for (const startsAt of refused) {
      expect(await refusalFor(BookAppointmentDto, bookingBody(startsAt))).toContain(
        'offset explicite',
      );
      expect(await refusalFor(RescheduleAppointmentDto, { startsAt })).toContain(
        'offset explicite',
      );
    }
  });
});
