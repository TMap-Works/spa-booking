import { Global, Module } from '@nestjs/common';

import { TenantContextService } from './tenant-context.service';

/**
 * Le contexte de tenant est `@Global` pour la même raison que `DatabaseModule` :
 * les huit modules métier en dépendront tous, et le réimporter dans chacun ne
 * rendrait le graphe ni plus lisible ni plus découplé. Ce n'est pas un module
 * métier, c'est une propriété transverse de toute requête.
 */
@Global()
@Module({
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenantContextModule {}
