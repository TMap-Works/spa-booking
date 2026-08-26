import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import {
  PUBLIC_TENANT_RESOLVER,
  type PublicTenantResolverProvider,
} from '../../common/tenant/public-tenant.resolver';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityRepository } from './identity.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordHasher } from './password.hasher';
import { PublicTenantController } from './public-tenant.controller';
import { PublicTenantService } from './public-tenant.service';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * La résolution `slug → tenantId` que `TenantScopeMiddleware` réclame (#23).
 *
 * `useExisting` et non `useClass` : **la même instance** qu'injectent les
 * services du module. Une seconde instance aurait son propre client Prisma, et
 * surtout : un test qui substitue `IdentityRepository` par un double verrait le
 * middleware continuer à interroger le vrai dépôt — la substitution mentirait
 * exactement là où elle sert le plus.
 */
const publicTenantResolver: PublicTenantResolverProvider = {
  provide: PUBLIC_TENANT_RESOLVER,
  useExisting: IdentityRepository,
};

/**
 * Module `identity` — authentification, rôles, permissions, sessions (CDC §2.3).
 *
 * ## Ce qu'il exporte, et pourquoi si peu
 *
 * `JwtAuthGuard`, `RolesGuard`, `TokenService` — et `PUBLIC_TENANT_RESOLVER`,
 * qui n'est pas destiné aux modules métier mais à `AppModule` : c'est lui qui
 * monte `TenantScopeMiddleware`, et Nest résout les dépendances d'un middleware
 * dans le module qui le déclare. Sans cet export, l'amorçage échouerait sur le
 * jeton manquant — bruyamment, ce qui est le bon mode de défaillance.
 *
 * Le sens de la dépendance est délibéré : `common/tenant` **déclare** le contrat
 * (`public-tenant.resolver.ts`) et `identity` le **remplit**, parce que la table
 * `tenants` lui appartient. Un socle transverse qui importerait un module métier
 * serait l'inverse, et api-module §3 l'interdit.
 *
 * Les autres modules
 * métier gouverneront l'accès à leurs routes avec les deux gardes — par
 * `@Auth(...)` / `@AuthAtLeast(...)`, qui les montent ensemble et dans le bon
 * ordre. Aucun n'a de raison d'atteindre `IdentityRepository` ni `UsersService` :
 * un module n'importe jamais le repository d'un autre (api-module §3).
 *
 * Les deux gardes sont déclarées comme fournisseurs — et non seulement
 * référencées par `@UseGuards` — parce qu'elles ont des dépendances à injecter :
 * `TokenService` pour la première, `Reflector` pour la seconde.
 *
 * ## `JwtModule` sans secret ici
 *
 * `JwtModule.register({})` est délibérément vide : le secret est passé **à chaque
 * appel** par `TokenService`, parce qu'il y en a deux — un par usage — et qu'un
 * secret par défaut au niveau du module rendrait facile de signer un jeton de
 * rafraîchissement avec la clé d'accès sans que rien ne le signale.
 *
 * ## La limitation de débit est déclarée ici
 *
 * `ThrottlerModule.forRoot` pose les quotas par défaut, et `AuthController`
 * resserre route par route. Le module est déclaré dans `identity` plutôt qu'à la
 * racine parce que c'est ici que se trouvent les endpoints à protéger : le rendre
 * global imposerait un quota à `/health`, que les sondes de l'ALB interrogent
 * bien plus souvent qu'un humain ne se connecte.
 */
@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot({
      throttlers: [
        // Défaut prudent ; chaque route d'authentification l'affine par
        // `@Throttle`. La valeur ne sert que si quelqu'un ajoute une route sans y
        // penser — et c'est exactement pour ce cas qu'elle existe.
        { name: 'default', limit: 60, ttl: 60_000 },
      ],
    }),
  ],
  controllers: [AuthController, UsersController, PublicTenantController],
  providers: [
    AuthService,
    UsersService,
    PublicTenantService,
    IdentityRepository,
    PasswordHasher,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    publicTenantResolver,
  ],
  exports: [JwtAuthGuard, RolesGuard, TokenService, PUBLIC_TENANT_RESOLVER],
})
export class IdentityModule {}
