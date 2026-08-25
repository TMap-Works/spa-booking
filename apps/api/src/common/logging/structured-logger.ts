import { Injectable, type LoggerService } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import type { LogLevelName } from '../../config/env.schema';
import { redact, redactString } from './redaction';

/**
 * Journalisation structurée : une ligne JSON par événement sur la sortie
 * standard, telle que l'attend CloudWatch Logs (une ligne = un événement
 * indexable, `level` et `context` filtrables).
 *
 * Deux invariants :
 *
 * 1. **Aucune donnée personnelle client n'entre dans un log** (CDC §5.1). Tout
 *    ce qui traverse ce logger passe par `redact`/`redactString` — message
 *    compris, car une erreur applicative recopie volontiers l'entrée fautive
 *    dans son message.
 * 2. **Rien n'est écrit via `console`**. `process.stdout.write` n'ajoute ni
 *    couleur ni préfixe, et n'est pas remplacé par les outils de test.
 */

const LEVEL_SEVERITY: Readonly<Record<LogLevelName, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevelName;
  message: string;
  context?: string;
  stack?: string;
  meta?: Record<string, unknown>;
}

/**
 * Sépare les paramètres variadiques de Nest. `LoggerService` les passe en vrac :
 * `logger.error(message, stack, context)` pour une erreur, `logger.log(message,
 * context)` sinon, et le code applicatif y ajoute des objets de contexte.
 *
 * Convention retenue : la **dernière** chaîne est le `context` (c'est ce que fait
 * Nest), une chaîne multi-lignes est une pile, les objets sont fusionnés dans
 * `meta`.
 */
export function splitLogParams(params: readonly unknown[]): {
  context?: string;
  stack?: string;
  meta?: Record<string, unknown>;
} {
  let context: string | undefined;
  let stack: string | undefined;
  let meta: Record<string, unknown> | undefined;

  for (const param of params) {
    if (typeof param === 'string') {
      if (param.includes('\n')) {
        stack = param;
      } else {
        context = param;
      }
      continue;
    }
    if (param instanceof Error) {
      stack = param.stack ?? `${param.name}: ${param.message}`;
      continue;
    }
    if (param !== null && typeof param === 'object' && !Array.isArray(param)) {
      meta = { ...(meta ?? {}), ...(param as Record<string, unknown>) };
    }
  }

  return {
    ...(context === undefined ? {} : { context }),
    ...(stack === undefined ? {} : { stack }),
    ...(meta === undefined ? {} : { meta }),
  };
}

/** Rend un message de n'importe quelle forme en chaîne, sans jamais lever. */
function stringifyMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return `${message.name}: ${message.message}`;
  }
  if (message === null || message === undefined) {
    return String(message);
  }
  if (typeof message === 'object') {
    try {
      return JSON.stringify(redact(message));
    } catch {
      return '[objet non sérialisable]';
    }
  }
  return String(message);
}

@Injectable()
export class StructuredLogger implements LoggerService {
  private threshold: number;

  public constructor(config: AppConfigService) {
    this.threshold = LEVEL_SEVERITY[config.logLevel];
  }

  /** Sortie testable : surchargée dans les tests unitaires. */
  protected emit(line: string): void {
    process.stdout.write(`${line}\n`);
  }

  public log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  public error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  public warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  public debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  /** `verbose` de Nest n'a pas de palier propre ici : il descend avec `debug`. */
  public verbose(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  public fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  public isLevelEnabled(level: LogLevelName): boolean {
    return LEVEL_SEVERITY[level] >= this.threshold;
  }

  private write(level: LogLevelName, message: unknown, params: readonly unknown[]): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const { context, stack, meta } = splitLogParams(params);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactString(stringifyMessage(message)),
      ...(context === undefined ? {} : { context }),
      // La pile cite des chemins de fichiers, jamais une valeur métier — mais
      // elle contient parfois le message de l'erreur d'origine.
      ...(stack === undefined ? {} : { stack: redactString(stack) }),
      ...(meta === undefined ? {} : { meta: redact(meta) as Record<string, unknown> }),
    };

    try {
      this.emit(JSON.stringify(entry));
    } catch {
      // Un log ne fait jamais tomber la requête qu'il observe.
      this.emit(
        JSON.stringify({
          timestamp: entry.timestamp,
          level,
          message: '[entrée de journal non sérialisable]',
        }),
      );
    }
  }
}
