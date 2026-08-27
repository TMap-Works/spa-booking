import type { ArgumentsHost } from '@nestjs/common';

import { DomainError } from '../../../common/errors';
import {
  DomainExceptionFilter,
  type ErrorResponseBody,
} from '../../../common/filters/domain-exception.filter';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { APPOINTMENTS_ERROR_CODES, SlotNoLongerAvailableError } from '../appointments.errors';

/**
 * `SlotNoLongerAvailableError` — et sa traduction en **409**, jamais 500.
 *
 * Le critère d'acceptation de #31 ne s'arrête pas à la classe d'erreur : il dit
 * « puis en HTTP 409 ». La classe seule ne prouve rien de ce trajet, et c'est
 * pourquoi cette suite fait réellement tourner `DomainExceptionFilter` — le
 * filtre global que `configureApp` monte — plutôt que d'affirmer que 409 est
 * bien la valeur du champ `status`.
 *
 * Le filtre n'a aucune connaissance de ce module : il traduit ce que porte
 * l'erreur. C'est exactement ce qui doit être vérifié — qu'une erreur bien
 * formée suffit, sans que rien n'ait à être ajouté au filtre.
 */

interface Captured {
  status: number;
  body: ErrorResponseBody;
}

/** Le filtre, exercé comme Nest l'exerce — même contrat que #29. */
function runFilter(exception: unknown): {
  captured: Captured;
  logger: { error: jest.Mock; debug: jest.Mock; warn: jest.Mock };
} {
  const captured: Captured = { status: 0, body: { code: '', message: '', details: {} } };
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: ErrorResponseBody) {
      captured.body = payload;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', path: '/api/v1/appointments' }),
    }),
  } as unknown as ArgumentsHost;

  const logger = { error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  new DomainExceptionFilter(logger as unknown as StructuredLogger).catch(exception, host);

  return { captured, logger };
}

const STAFF_ID = '3f0d2a6e-6f5e-4a2b-9d1c-2f7c8b4e1a55';
const STARTS_AT = new Date('2026-09-01T09:00:00.000Z');

describe('SlotNoLongerAvailableError', () => {
  it('est une erreur de domaine, jamais une `HttpException`', () => {
    // Un service qui lèverait une `HttpException` deviendrait intestable sans
    // HTTP et lierait le métier au transport (api-module §5).
    expect(new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT)).toBeInstanceOf(DomainError);
  });

  it('porte le code stable du contrat et le statut 409', () => {
    const error = new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT);

    expect(error.code).toBe(APPOINTMENTS_ERROR_CODES.SLOT_NO_LONGER_AVAILABLE);
    // La valeur, en clair : c'est elle qui voyage jusqu'au front, et le front
    // branche son comportement dessus. Un renommage se verrait ici.
    expect(error.code).toBe('SLOT_NO_LONGER_AVAILABLE');
    expect(error.status).toBe(409);
  });

  it('ne rend de l’état du monde que ce que l’appelant a lui-même envoyé', () => {
    const error = new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT);

    expect(error.details).toEqual({ staffId: STAFF_ID, startsAt: '2026-09-01T09:00:00.000Z' });
  });

  it('date le créneau en ISO 8601 avec fuseau explicite', () => {
    // Une heure murale traverserait l'API sans dire de quel fuseau elle vient,
    // et un rendez-vous mal fuseau-horairé est un bug de sévérité haute.
    const details = new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT).details;

    expect(details['startsAt']).toMatch(/Z$/);
  });
});

describe('SlotNoLongerAvailableError — traduction HTTP', () => {
  it('devient un 409, et non un 500', () => {
    const { captured } = runFilter(new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT));

    expect(captured.status).toBe(409);
  });

  it('rend le corps d’erreur stable `{ code, message, details }`', () => {
    const { captured } = runFilter(new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT));

    expect(Object.keys(captured.body).sort()).toEqual(['code', 'details', 'message']);
    expect(captured.body.code).toBe('SLOT_NO_LONGER_AVAILABLE');
    expect(captured.body.details).toEqual({
      staffId: STAFF_ID,
      startsAt: '2026-09-01T09:00:00.000Z',
    });
  });

  it('ne laisse fuir aucun détail du rendez-vous concurrent', () => {
    // Le message de PostgreSQL cite la ligne en conflit — établissement,
    // praticien, bornes exactes. Le remonter ferait de la réservation une sonde
    // d'agenda : qui peut réserver pourrait cartographier les rendez-vous d'un
    // praticien en tirant sur tous les créneaux.
    const { captured } = runFilter(new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT));
    const serialised = JSON.stringify(captured.body);

    expect(serialised).not.toContain('conflicting key value');
    expect(serialised).not.toContain('appointments_no_overlap');
    expect(serialised).not.toContain('23P01');
    expect(serialised).not.toContain('tenant_id');
  });

  it('journalise en `debug` et non en `error` — un créneau pris n’est pas un incident', () => {
    // Compter une course perdue comme un incident noierait les vrais 5xx sous le
    // bruit d'un agenda partagé, et fausserait toute alarme assise sur ce palier.
    const { logger } = runFilter(new SlotNoLongerAvailableError(STAFF_ID, STARTS_AT));

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
