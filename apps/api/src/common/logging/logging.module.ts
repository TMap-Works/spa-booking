import { Global, Module } from '@nestjs/common';

import { StructuredLogger } from './structured-logger';

/**
 * Rend `StructuredLogger` injectable partout sans réimporter le module. Il est
 * aussi posé comme logger de Nest lui-même dans `main.ts`, pour que les traces
 * du framework sortent au même format que celles de l'application.
 */
@Global()
@Module({
  providers: [StructuredLogger],
  exports: [StructuredLogger],
})
export class LoggingModule {}
