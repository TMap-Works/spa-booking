import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Module transverse — ce n'est pas un des huit modules métier du CDC §2.3. Il
 * ne connaît aucune donnée de tenant et n'en expose aucune.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
