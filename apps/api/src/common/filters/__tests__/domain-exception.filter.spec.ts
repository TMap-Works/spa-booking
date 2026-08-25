import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

import type { StructuredLogger } from '../../logging/structured-logger';
import { REDACTED } from '../../logging/redaction';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../errors';
import { DomainExceptionFilter, type ErrorResponseBody } from '../domain-exception.filter';

interface Captured {
  status: number;
  body: ErrorResponseBody;
}

function runFilter(exception: unknown, request: { method?: string; path?: string } = {}) {
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
      getRequest: () => ({ method: request.method ?? 'GET', path: request.path ?? '/api/v1/x' }),
    }),
  } as unknown as ArgumentsHost;

  const logger = { error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  new DomainExceptionFilter(logger as unknown as StructuredLogger).catch(exception, host);

  return { captured, logger };
}

describe('DomainExceptionFilter', () => {
  describe('erreurs de domaine', () => {
    it.each([
      { error: new NotFoundError('Rendez-vous introuvable.'), status: 404, code: 'NOT_FOUND' },
      { error: new ForbiddenError(), status: 403, code: 'FORBIDDEN' },
      { error: new ConflictError(), status: 409, code: 'CONFLICT' },
      {
        error: new BusinessRuleError('Délai de prévenance non respecté.'),
        status: 422,
        code: 'BUSINESS_RULE_VIOLATION',
      },
      {
        error: new InvalidStateTransitionError('cancelled', 'confirmed'),
        status: 422,
        code: 'INVALID_STATE_TRANSITION',
      },
    ])('traduit une erreur de domaine en $status / $code', ({ error, status, code }) => {
      const { captured } = runFilter(error);

      expect(captured.status).toBe(status);
      expect(captured.body.code).toBe(code);
      expect(Object.keys(captured.body).sort()).toEqual(['code', 'details', 'message']);
    });

    it('reporte les détails du domaine dans le corps', () => {
      const { captured } = runFilter(
        new NotFoundError('Service introuvable.', { resource: 'service', id: 'svc-1' }),
      );

      expect(captured.body.details).toEqual({ resource: 'service', id: 'svc-1' });
    });

    it('journalise un 4xx en debug, pas en error', () => {
      const { logger } = runFilter(new NotFoundError());

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  describe('exceptions HTTP du framework', () => {
    it('convertit le rapport de ValidationPipe en VALIDATION_ERROR', () => {
      const { captured } = runFilter(
        new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: ['startsAt must be a valid ISO 8601 date string', 'property foo should not exist'],
        }),
      );

      expect(captured.status).toBe(400);
      expect(captured.body.code).toBe('VALIDATION_ERROR');
      expect(captured.body.details['violations']).toHaveLength(2);
    });

    it('déduit le code du statut pour une route inconnue', () => {
      const { captured } = runFilter(new NotFoundException());

      expect(captured.status).toBe(404);
      expect(captured.body.code).toBe('NOT_FOUND');
    });

    it('accepte un corps déjà au format du domaine', () => {
      const { captured } = runFilter(
        new HttpException({ code: 'PAYMENT_DECLINED', message: 'Refusé.', details: { try: 1 } }, 402),
      );

      expect(captured.body).toEqual({
        code: 'PAYMENT_DECLINED',
        message: 'Refusé.',
        details: { try: 1 },
      });
    });

    it('retombe sur HTTP_<statut> pour un statut non cartographié', () => {
      const { captured } = runFilter(new HttpException('Payment Required', 402));

      expect(captured.body.code).toBe('HTTP_402');
    });
  });

  describe('exceptions non prévues', () => {
    it('répond 500 sans rien dire de l’erreur d’origine', () => {
      const { captured } = runFilter(
        new Error('relation "appointments" does not exist — postgresql://spa:s3cret@db:5432/spa'),
      );

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Une erreur interne est survenue.',
        details: {},
      });
      expect(JSON.stringify(captured.body)).not.toContain('s3cret');
      expect(JSON.stringify(captured.body)).not.toContain('appointments');
    });

    it('journalise le 500 en error, avec sa pile', () => {
      const { logger } = runFilter(new Error('boum'));

      expect(logger.error).toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('survit à une valeur levée qui n’est pas une Error', () => {
      const { captured } = runFilter('chaîne levée telle quelle');

      expect(captured.status).toBe(500);
      expect(captured.body.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('expurgation du corps sortant', () => {
    it('masque une adresse e-mail citée par une règle métier', () => {
      const { captured } = runFilter(
        new BusinessRuleError('Le compte marie.dupont@example.com est déjà pris.'),
      );

      expect(captured.body.message).not.toContain('marie.dupont@example.com');
      expect(captured.body.message).toContain(REDACTED);
    });

    it('masque une donnée personnelle glissée dans les détails', () => {
      const { captured } = runFilter(
        new BusinessRuleError('Doublon.', { clientEmail: 'marie@example.com', tenantId: 't-1' }),
      );

      expect(captured.body.details['clientEmail']).toBe(REDACTED);
      expect(captured.body.details['tenantId']).toBe('t-1');
    });
  });
});
