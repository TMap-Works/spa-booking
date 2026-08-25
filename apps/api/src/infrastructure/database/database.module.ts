import { Global, Module } from '@nestjs/common';

import { DatabaseConnection } from './database.connection';

@Global()
@Module({
  providers: [DatabaseConnection],
  exports: [DatabaseConnection],
})
export class DatabaseModule {}
