import { Global, Module } from '@nestjs/common';

import { CacheConnection } from './cache.connection';

@Global()
@Module({
  providers: [CacheConnection],
  exports: [CacheConnection],
})
export class CacheModule {}
