import { Global, Module } from '@nestjs/common';

import { CacheBroadcast } from './cache.broadcast';
import { CacheConnection } from './cache.connection';

@Global()
@Module({
  providers: [CacheConnection, CacheBroadcast],
  exports: [CacheConnection, CacheBroadcast],
})
export class CacheModule {}
