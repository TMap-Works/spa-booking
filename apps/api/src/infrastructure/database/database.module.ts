import { Global, Module } from '@nestjs/common';

import { DatabaseConnection } from './database.connection';
import {
  PRISMA,
  PRISMA_UNSCOPED,
  createScopedPrismaClient,
} from './prisma-clients';
import { PrismaService } from './prisma.service';

/**
 * Trois accès à PostgreSQL, chacun pour une raison distincte — et **un seul**
 * qui soit le chemin normal :
 *
 * - `PRISMA` — le client Prisma **scopé par tenant**, injecté par les
 *   repositories et par eux seuls. C'est la porte par défaut ;
 * - `PRISMA_UNSCOPED` — le même client sans l'extension, pour les traitements
 *   légitimement inter-tenants. Chaque usage se justifie en commentaire
 *   (voir `prisma-clients.ts`) ;
 * - `DatabaseConnection` — le pool `pg` de service, réservé à la sonde
 *   `/health` et au SQL brut que Prisma n'exprime pas.
 *
 * `PrismaService` reste un provider **interne** : il possède le cycle de vie de
 * la connexion, mais il n'est pas exporté. Un repository qui l'injecterait
 * obtiendrait un accès non scopé que rien ne signalerait à la relecture — le
 * client non scopé doit s'appeler `prismaUnscoped` pour qu'un `grep` le trouve.
 *
 * Le module est `@Global` : chaque module métier aura besoin de Prisma, et
 * réimporter `DatabaseModule` dans les huit ne rendrait le graphe ni plus lisible
 * ni plus découplé — l'infrastructure n'est pas un module métier.
 */
@Global()
@Module({
  providers: [
    DatabaseConnection,
    PrismaService,
    // `useExisting` et non `useClass` : la même instance que celle dont
    // `onModuleDestroy` ferme la connexion. Un second client fermerait mal.
    { provide: PRISMA_UNSCOPED, useExisting: PrismaService },
    {
      provide: PRISMA,
      useFactory: createScopedPrismaClient,
      inject: [PrismaService],
    },
  ],
  exports: [DatabaseConnection, PRISMA, PRISMA_UNSCOPED],
})
export class DatabaseModule {}
