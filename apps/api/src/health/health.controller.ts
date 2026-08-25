import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService, type HealthReport } from './health.service';

/**
 * `/health` — hors préfixe `/api` et hors versionnement (`VERSION_NEUTRAL`).
 *
 * C'est délibéré : cette route est consommée par l'ALB et par le contrôle de
 * santé ECS, pas par un client de l'API. La figer hors du versionnement évite
 * qu'un passage en `v2` demande de reconfigurer l'infrastructure — et un
 * `target group` ne doit pas connaître la version de l'API qu'il équilibre.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Vivacité des dépendances',
    description:
      'Exécute réellement `SELECT 1` sur PostgreSQL et `PING` sur Redis. ' +
      'Répond 200 si tout répond, 503 dès qu’une dépendance est tombée.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, type: HealthResponseDto })
  public async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.check();

    // 503 et non 500 : l'API est saine, c'est une dépendance qui ne l'est pas.
    // C'est ce statut qui fait retirer la tâche du `target group` sans la tuer.
    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    // Jamais de cache sur une sonde : un 200 mémorisé masquerait une panne.
    response.setHeader('Cache-Control', 'no-store');

    return report;
  }
}
