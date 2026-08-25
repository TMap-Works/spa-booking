import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { DomainError } from '../errors';
import { redact, redactString } from '../logging/redaction';
import { StructuredLogger } from '../logging/structured-logger';

/**
 * Traduit toute exception en une réponse HTTP de forme unique (api-module §5) :
 *
 * ```json
 * { "code": "SLOT_NO_LONGER_AVAILABLE", "message": "…", "details": {} }
 * ```
 *
 * Trois familles d'entrée :
 *
 * - une **erreur de domaine** porte déjà son `code` et son `status` ;
 * - une **`HttpException`** vient du framework — `ValidationPipe`, route absente,
 *   garde d'authentification — et son code se déduit du statut ;
 * - **tout le reste** est un défaut de programmation : 500, message générique,
 *   trace complète dans le log et **rien** de l'erreur d'origine dans le corps.
 *   Une exception non prévue cite volontiers une requête SQL ou une URL de
 *   connexion ; c'est exactement ce qu'un client ne doit jamais lire.
 */

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

const INTERNAL_ERROR_MESSAGE = 'Une erreur interne est survenue.';

export interface ErrorResponseBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? `HTTP_${status}`;
}

/**
 * `ValidationPipe` répond `{ statusCode, error, message: string[] }`. Les
 * messages sont produits par class-validator et citent des **noms de champs**,
 * pas des valeurs — ils sont donc exposables tels quels, une fois expurgés par
 * sécurité.
 */
function bodyFromHttpException(exception: HttpException): ErrorResponseBody {
  const status = exception.getStatus();
  const payload: unknown = exception.getResponse();

  if (typeof payload === 'string') {
    return { code: codeForStatus(status), message: payload, details: {} };
  }

  if (payload === null || typeof payload !== 'object') {
    return { code: codeForStatus(status), message: exception.message, details: {} };
  }

  const record = payload as Record<string, unknown>;
  const rawMessage = record['message'];

  if (Array.isArray(rawMessage)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'La requête est invalide.',
      details: { violations: rawMessage.map((item) => String(item)) },
    };
  }

  const code = typeof record['code'] === 'string' ? record['code'] : codeForStatus(status);
  const message = typeof rawMessage === 'string' ? rawMessage : exception.message;
  const details =
    record['details'] !== null &&
    typeof record['details'] === 'object' &&
    !Array.isArray(record['details'])
      ? (record['details'] as Record<string, unknown>)
      : {};

  return { code, message, details };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  public constructor(private readonly logger: StructuredLogger) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { status, body } = this.describe(exception);
    const safeBody: ErrorResponseBody = {
      code: body.code,
      // Expurgé même sur un message que nous écrivons : une règle métier peut
      // citer l'entrée fautive, et un corps d'erreur finit dans les logs du front.
      message: redactString(body.message),
      details: redact(body.details) as Record<string, unknown>,
    };

    this.report(exception, status, request, safeBody);
    response.status(status).json(safeBody);
  }

  private describe(exception: unknown): { status: number; body: ErrorResponseBody } {
    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          code: exception.code,
          message: exception.message,
          details: { ...exception.details },
        },
      };
    }

    if (exception instanceof HttpException) {
      return { status: exception.getStatus(), body: bodyFromHttpException(exception) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE, details: {} },
    };
  }

  /**
   * Un 5xx est un incident : trace complète, niveau `error`. Un 4xx est le
   * fonctionnement normal d'une API publique — le journaliser en `error`
   * noierait les vrais incidents sous le bruit des sondes et des robots.
   */
  private report(
    exception: unknown,
    status: number,
    request: Request,
    body: ErrorResponseBody,
  ): void {
    // `request.route` est absent sur une route inconnue ; `path` ne porte pas la
    // query string, qui pourrait contenir un e-mail de recherche.
    const meta = {
      method: request.method,
      path: request.path,
      status,
      code: body.code,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(
        exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
        ...(stack === undefined ? [] : [stack]),
        meta,
        DomainExceptionFilter.name,
      );
      return;
    }

    this.logger.debug(body.message, meta, DomainExceptionFilter.name);
  }
}
