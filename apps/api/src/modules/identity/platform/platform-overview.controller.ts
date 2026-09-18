import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PlatformOverview } from '@spa/shared';

import { PlatformOverviewDto, toPlatformOverviewDto } from './dto/platform.dto';
import { PlatformAuth } from './platform-auth.guard';
import { PlatformConsoleService } from './platform-console.service';

/**
 * La vue d'ensemble de la plateforme — l'écran d'arrivée de la console.
 *
 * Un contrôleur à part de `platform/tenants` : `GET /platform/tenants/overview`
 * aurait disputé le segment à `GET /platform/tenants/:id`, et la vue d'ensemble
 * n'est pas un salon.
 *
 * Des **agrégats**, et le revenu de l'éditeur (les abonnements) — jamais une
 * donnée de salon (ADR 0012).
 */
@ApiTags('platform')
@Controller({ path: 'platform/overview', version: '1' })
@PlatformAuth()
export class PlatformOverviewController {
  public constructor(private readonly console: PlatformConsoleService) {}

  @Get()
  @ApiOperation({ summary: 'Vue d’ensemble de la plateforme' })
  @ApiOkResponse({ type: PlatformOverviewDto })
  public async overview(): Promise<PlatformOverview> {
    return toPlatformOverviewDto(await this.console.overview());
  }
}
