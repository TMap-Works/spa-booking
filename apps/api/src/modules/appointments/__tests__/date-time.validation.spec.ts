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
 * 1. la **frontière** accepte l'offset ;
 * 2. elle l'accepte sous le pipe réellement monté, `whitelist` et
 *    `forbidNonWhitelisted` compris ;
 * 3. le **contrôleur** en dérive le `Date` qui descend au service, puis à
 *    `@db.Timestamptz(6)`. C'est ce `Date`-là qui est « l'instant stocké », et
 *    c'est le seul endroit où une conversion peut encore se tromper de fuseau.
 *
 * Le service est donc remplacé par un double qui **capture** l'instant reçu :
 * ce qu'on regarde n'est pas ce que la réservation produit — `appointments.service.spec.ts`
 * s'en charge —, c'est ce que la frontière lui transmet.
 *
 * ## Les deux frontières que cette suite traverse (#404, puis #510)
 *
 * Elles sont désormais **de même nature**, et c'est le changement de #510 :
 *
 * - **`book`** est validée par `bookGuestAppointmentRequestSchemaFor`, monté par
 *   `BookAppointmentBodyPipe`
 *   ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)) ;
 * - **`reschedule`** l'est par `rescheduleAppointmentRequestSchema`, monté par
 *   `rescheduleAppointmentBody`.
 *
 * Les deux passent par `offsetDateTimeSchema`, qui **normalise** l'instant dès
 * la frontière : le `new Date(...)` des contrôleurs ne convertit plus rien, il
 * relit une chaîne déjà en UTC. C'est précisément ce que cette suite continue de
 * vérifier cas par cas — la substitution devait rester sans effet visible, et
 * les mêmes chaînes doivent produire les mêmes instants qu'avant.
 *
 * Le pendant côté contrat vit dans `packages/shared/src/__tests__/schemas.spec.ts`,
 * sur la même liste de chaînes refusées.
 */

import type { AuthenticatedUser } from '../../identity/identity.types';
import type { AppointmentsService } from '../appointments.service';
import type {
  AppointmentView,
  BookAppointmentInput,
  RescheduleAppointmentInput,
} from '../appointments.types';
import type { BookAppointmentBody } from '../dto/book-appointment.dto';
import { bookAppointmentPipe } from './appointments.doubles';
import {
  type RescheduleAppointmentBody,
  rescheduleAppointmentBody,
} from '../dto/reschedule-appointment.dto';
import { PublicAppointmentsController } from '../public-appointments.controller';

/** Des coordonnées valides — le sujet du test est ailleurs. */
const CLIENT = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
};

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const SERVICE_ID = '9a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';

/**
 * L'identité que `JwtAuthGuard` aurait posée sur la requête — exigée par le
 * report public depuis #1135.
 *
 * Elle n'est pas le sujet de cette suite : sans elle, le handler ne compilerait
 * simplement plus. Ce qu'elle rappelle en passant, c'est d'où vient la cliente —
 * d'un jeton vérifié, jamais du chemin ni du corps.
 */
const CLIENTE_AUTHENTIFIEE: AuthenticatedUser = {
  userId: 'd41b7f6e-8c35-4b31-9a14-5e6f7a8b9c0d',
  tenantId: '0c9e8d7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f',
  role: 'CLIENT',
};

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
    reference: 'RDV-8F3K-27',
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

/**
 * Le corps d'erreur sérialisé, ou la chaîne vide si la frontière a laissé passer.
 *
 * `await` sur la tentative : le pipe de `book` lit le pays de l'établissement,
 * donc transforme de façon asynchrone depuis #1028. Celui de `reschedule` reste
 * synchrone, et `await` sur une valeur non promise ne change rien à son refus.
 */
async function refusalOf(attempt: () => unknown): Promise<string> {
  try {
    await attempt();

    return '';
  } catch (error) {
    return JSON.stringify((error as { getResponse: () => unknown }).getResponse());
  }
}

/** Le refus que la frontière de `reschedule` oppose à ce `startsAt`. */
function rescheduleRefusal(startsAt: string): Promise<string> {
  return refusalOf(() => rescheduleAppointmentBody.transform({ startsAt }));
}

/**
 * La frontière de `book`, **sans pays d'établissement** : le sujet de cette
 * suite est l'instant, pas le téléphone, et aucun de ses corps ne porte de
 * numéro.
 */
const bookBody = bookAppointmentPipe();

/** Corps de réservation complet, dont seul `startsAt` varie d'un cas à l'autre. */
function bookingBody(startsAt: string): Record<string, unknown> {
  // `dataConsent` est obligatoire depuis #790 : sans lui, le refus observé ici
  // serait celui du consentement manquant et non celui du `startsAt` visé.
  return { serviceId: SERVICE_ID, startsAt, client: { ...CLIENT }, dataConsent: true };
}

/** Le refus que la frontière de `book` oppose à ce `startsAt`. */
function bookingRefusal(startsAt: string): Promise<string> {
  return refusalOf(() => bookBody.transform(bookingBody(startsAt)));
}

/** L'instant que le service recevrait pour ce corps de réservation. */
async function bookedInstant(startsAt: string): Promise<string> {
  const { controller, captured } = capturingService();

  await controller.book((await bookBody.transform(bookingBody(startsAt))) as BookAppointmentBody);

  return instantOf(captured.book, 'book');
}

/** L'instant que le service recevrait pour ce corps de report. */
async function rescheduledInstant(startsAt: string): Promise<string> {
  const { controller, captured } = capturingService();

  await controller.reschedule(
    APPOINTMENT_ID,
    rescheduleAppointmentBody.transform({ startsAt }) as RescheduleAppointmentBody,
    // La cliente du jeton, exigée depuis #1135. Le sujet de cette suite reste
    // l'instant : le double de service ne juge pas la propriété du rendez-vous,
    // c'est `appointments.own-scope.spec.ts` qui l'exerce.
    CLIENTE_AUTHENTIFIEE,
  );

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
    expect(await bookingRefusal('2026-03-29T03:30:00')).toContain('offset explicite');
    expect(await rescheduleRefusal('2026-03-29T03:30:00')).toContain('offset explicite');
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
      expect(await bookingRefusal(startsAt)).toContain('offset explicite');
      expect(await rescheduleRefusal(startsAt)).toContain('offset explicite');
    }
  });
});
