import { Global, Module } from '@nestjs/common';

import { DatabaseConnection } from './database.connection';
import { PrismaService } from './prisma.service';

/**
 * Deux accès à PostgreSQL, chacun pour une raison distincte :
 *
 * - `PrismaService` — l'accès aux données métier, injecté par les repositories
 *   et par eux seuls ;
 * - `DatabaseConnection` — le pool `pg` de service, réservé à la sonde
 *   `/health` et au SQL brut que Prisma n'exprime pas.
 *
 * Le module est `@Global` : chaque module métier aura besoin de Prisma, et
 * réimporter `DatabaseModule` dans les huit ne rendrait le graphe ni plus lisible
 * ni plus découplé — l'infrastructure n'est pas un module métier.
 */
@Global()
@Module({
  providers: [DatabaseConnection, PrismaService],
  exports: [DatabaseConnection, PrismaService],
})
export class DatabaseModule {}
