import { ApiProperty } from '@nestjs/swagger';

import type { DependencyCheck, DependencyStatus, HealthReport } from '../health.service';

/**
 * Représentation OpenAPI du rapport de santé. Le contrat est volontairement
 * pauvre : un statut, une latence. Aucune information d'hôte, de port, de
 * version ni d'identifiant de tenant — `/health` est exposé sans
 * authentification.
 */
export class DependencyCheckDto implements DependencyCheck {
  @ApiProperty({ enum: ['up', 'down'], description: 'Résultat de la sonde.' })
  public status!: DependencyStatus;

  @ApiProperty({ description: 'Durée de la sonde en millisecondes.', example: 3 })
  public latencyMs!: number;
}

export class HealthChecksDto {
  @ApiProperty({ type: DependencyCheckDto, description: 'PostgreSQL — `SELECT 1`.' })
  public database!: DependencyCheckDto;

  @ApiProperty({ type: DependencyCheckDto, description: 'Redis — `PING`.' })
  public cache!: DependencyCheckDto;
}

export class HealthResponseDto implements HealthReport {
  @ApiProperty({
    enum: ['ok', 'error'],
    description: '`ok` si toutes les dépendances répondent, `error` sinon.',
  })
  public status!: 'ok' | 'error';

  @ApiProperty({ type: HealthChecksDto })
  public checks!: HealthChecksDto;
}
