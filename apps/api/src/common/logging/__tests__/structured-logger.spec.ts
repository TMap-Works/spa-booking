import type { AppConfigService } from '../../../config/app-config.service';
import type { LogLevelName } from '../../../config/env.schema';
import { REDACTED } from '../redaction';
import { StructuredLogger, splitLogParams } from '../structured-logger';

/** Capture les lignes au lieu de les écrire sur la sortie standard. */
class CapturingLogger extends StructuredLogger {
  public readonly lines: string[] = [];

  protected override emit(line: string): void {
    this.lines.push(line);
  }

  public entries(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function loggerAt(level: LogLevelName): CapturingLogger {
  // Seul `logLevel` est lu par le logger : bouchonner le service entier ne
  // ferait qu'ajouter du bruit.
  return new CapturingLogger({ logLevel: level } as unknown as AppConfigService);
}

describe('splitLogParams', () => {
  it('prend la dernière chaîne simple pour contexte', () => {
    expect(splitLogParams(['AppointmentsService'])).toEqual({ context: 'AppointmentsService' });
  });

  it('reconnaît une pile à ses retours à la ligne', () => {
    const result = splitLogParams(['Error: boum\n    at foo', 'Ctx']);

    expect(result.context).toBe('Ctx');
    expect(result.stack).toContain('at foo');
  });

  it('fusionne les objets dans meta', () => {
    expect(splitLogParams([{ a: 1 }, { b: 2 }]).meta).toEqual({ a: 1, b: 2 });
  });

  it('extrait la pile d’une Error passée en paramètre', () => {
    expect(splitLogParams([new Error('boum')]).stack).toContain('boum');
  });
});

describe('StructuredLogger', () => {
  it('écrit une ligne JSON par événement', () => {
    const logger = loggerAt('info');
    logger.log('API démarrée', 'Bootstrap');

    const [entry] = logger.entries();
    expect(entry).toMatchObject({ level: 'info', message: 'API démarrée', context: 'Bootstrap' });
    expect(typeof entry?.['timestamp']).toBe('string');
  });

  it('filtre sous le seuil configuré', () => {
    const logger = loggerAt('warn');
    logger.debug('bruit');
    logger.log('bruit');
    logger.warn('attention');
    logger.error('incident');

    expect(logger.entries().map((entry) => entry['level'])).toEqual(['warn', 'error']);
  });

  it('descend verbose au niveau debug et remonte fatal au niveau error', () => {
    const logger = loggerAt('debug');
    logger.verbose('trace');
    logger.fatal('arrêt');

    expect(logger.entries().map((entry) => entry['level'])).toEqual(['debug', 'error']);
  });

  it('expurge la donnée personnelle du message', () => {
    const logger = loggerAt('info');
    logger.log('Confirmation envoyée à marie.dupont@example.com');

    const [entry] = logger.entries();
    expect(String(entry?.['message'])).not.toContain('marie.dupont@example.com');
    expect(String(entry?.['message'])).toContain(REDACTED);
  });

  it('expurge la donnée personnelle du contexte structuré', () => {
    const logger = loggerAt('info');
    logger.log('Rendez-vous créé', { tenantId: 'tenant-1', clientEmail: 'marie@example.com' });

    const meta = logger.entries()[0]?.['meta'] as Record<string, unknown>;
    expect(meta['tenantId']).toBe('tenant-1');
    expect(meta['clientEmail']).toBe(REDACTED);
  });

  it('expurge les identifiants de connexion présents dans une pile', () => {
    const logger = loggerAt('error');
    logger.error('échec', 'Error: connect postgresql://spa:s3cret@db:5432/spa\n    at pg');

    expect(logger.lines.join('')).not.toContain('s3cret');
  });

  it('ne lève pas sur une structure circulaire', () => {
    const logger = loggerAt('info');
    const circular: Record<string, unknown> = { tenantId: 'tenant-1' };
    circular['self'] = circular;

    expect(() => logger.log('cycle', circular)).not.toThrow();
    expect(logger.lines).toHaveLength(1);
  });
});
