import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityRepository } from './identity.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordHasher } from './password.hasher';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Module `identity` — authentification, rôles, permissions, sessions (CDC §2.3).
 *
 * ## Ce qu'il exporte, et pourquoi si peu
 *
 * `JwtAuthGuard`, `RolesGuard` et `TokenService` seulement. Les autres modules
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
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    UsersService,
    IdentityRepository,
    PasswordHasher,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [JwtAuthGuard, RolesGuard, TokenService],
})
export class IdentityModule {}
