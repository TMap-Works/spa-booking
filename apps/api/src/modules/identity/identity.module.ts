import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityRepository } from './identity.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordHasher } from './password.hasher';
import { TokenService } from './token.service';

/**
 * Module `identity` — authentification, rôles, sessions (CDC §2.3).
 *
 * ## Ce qu'il exporte, et pourquoi si peu
 *
 * `JwtAuthGuard` et `TokenService` seulement. Les autres modules métier
 * gouverneront l'accès à leurs routes avec la garde ; aucun n'a de raison
 * d'atteindre `IdentityRepository` — un module n'importe jamais le repository
 * d'un autre (api-module §3).
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
  controllers: [AuthController],
  providers: [AuthService, IdentityRepository, PasswordHasher, TokenService, JwtAuthGuard],
  exports: [JwtAuthGuard, TokenService],
})
export class IdentityModule {}
