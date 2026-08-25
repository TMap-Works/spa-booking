import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { IsInt, IsString } from 'class-validator';

import { BusinessRuleError, ConflictError, NotFoundError } from '../../src/common/errors';

/**
 * Module de test — jamais importé par `AppModule`.
 *
 * Le squelette de #18 n'expose qu'une sonde `/health`, en lecture seule et sans
 * corps de requête : impossible de prouver sur elle que le `ValidationPipe`
 * global rejette un champ non déclaré, ni que le filtre d'exceptions traduit
 * bien une erreur de domaine. Ce contrôleur donne les surfaces manquantes, en
 * traversant exactement le même câblage global que n'importe quel module métier
 * à venir — préfixe `/api`, version `v1`, pipe et filtre injectés par `AppModule`.
 */

export class CreateProbeDto {
  @IsString()
  public label!: string;

  @IsInt()
  public amountMinor!: number;
}

/** Monté sur `/api/v1/probe` par le préfixe et le versionnement globaux. */
@Controller({ path: 'probe' })
export class ProbeController {
  @Post()
  public create(@Body() dto: CreateProbeDto): CreateProbeDto {
    return dto;
  }

  @Get('not-found')
  public notFound(): never {
    throw new NotFoundError();
  }

  @Get('conflict')
  public conflict(): never {
    throw new ConflictError('Ce créneau vient d’être réservé.', { slotId: 'slot_42' });
  }

  @Get('business-rule')
  public businessRule(): never {
    throw new BusinessRuleError('Annulation trop tardive.', { hoursBeforeStart: 1 });
  }

  /**
   * Défaut de programmation : l'erreur cite une URL de connexion complète et un
   * e-mail client, exactement ce qu'une exception de pilote fait spontanément.
   * Ni l'un ni l'autre ne doit atteindre le corps de réponse ni le journal.
   */
  @Get('boom')
  public boom(): never {
    throw new Error(
      'relation "appointments" does not exist — ' +
        'postgres://spa_app:Sup3rS3cret@prod-db.internal:5432/spa (client: alice@example.test)',
    );
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
