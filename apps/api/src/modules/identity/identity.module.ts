import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import {
  PUBLIC_TENANT_RESOLVER,
  type PublicTenantResolverProvider,
} from '../../common/tenant/public-tenant.resolver';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityEvents } from './events/identity-events';
import { IdentityRepository } from './identity.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordHasher } from './password.hasher';
import { PlatformAuthController } from './platform/platform-auth.controller';
import { PlatformAuthGuard } from './platform/platform-auth.guard';
import { PlatformRepository } from './platform/platform.repository';
import { PlatformService } from './platform/platform.service';
import { PlatformTenantsController } from './platform/platform-tenants.controller';
import { PlatformTokenService } from './platform/platform-token.service';
import { PublicTenantController } from './public-tenant.controller';
import { PublicTenantService } from './public-tenant.service';
import { RolesGuard } from './roles.guard';
import { SessionThrottlerGuard } from './session-throttler.guard';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantTimeZoneAudit } from './tenant-timezone.audit';
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
 * métier gouvernent l'accès à leurs routes avec les deux gardes — par
 * `@Auth(...)` / `@AuthAtLeast(...)`, qui les montent ensemble et dans le bon
 * ordre.
 *
 * `UsersService` s'y est ajouté avec #694, et c'est le premier export de ce
 * module vers un autre module **métier**. La raison est celle que api-module §3
 * prévoit : `catalog` crée désormais la fiche praticien, qui se rattache à un
 * **compte**, et vérifier que ce compte est un compte interne de
 * l'établissement est une question d'identité — pas de catalogue. C'est un appel
 * de service, la voie autorisée ; `IdentityRepository`, lui, reste privé, et un
 * module n'importe jamais le repository d'un autre. La différence n'est pas
 * cosmétique : le service tient la règle — un 404 qui confond « inconnu »,
 * « d'ailleurs » et « cliente » —, là où le dépôt ne rendrait qu'une ligne, et
 * laisserait chaque appelant réinventer ce refus.
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
 *
 * `SessionThrottlerGuard` y figure comme les deux autres gardes de ce module,
 * par convention et non par nécessité : Nest sait instancier une garde
 * référencée par `@UseGuards` en résolvant ses dépendances dans le module qui
 * déclare le contrôleur — `TokenService` en fait partie. La déclarer ici laisse
 * les trois gardes du module visibles au même endroit (#860).
 *
 * ## La console plateforme vit dans ce module, sous `platform/`
 *
 * Le CDC §2.3 range les tenants dans Identité & accès, et ouvrir un
 * établissement est d'abord une question d'identité : qui a le droit de le
 * faire, et quel compte naît avec le salon. Un neuvième module se serait
 * justifié en ADR (api-module §1) ; l'ADR 0012 tranche en sens inverse — c'est
 * la même table `tenants` et le même mécanisme d'invitation que `UsersService`
 * emploie déjà.
 *
 * Le sous-dossier, lui, n'est pas décoratif : **rien** de ce qu'il contient ne
 * s'applique à l'espace des établissements. `PlatformAuthGuard` ne pose aucune
 * portée là où `JwtAuthGuard` en pose une, `PlatformTokenService` signe avec une
 * troisième clé, et `PlatformRepository` est la seule porte vers deux tables que
 * le client scopé refuse. Les mêler aux fichiers de l'espace salon aurait rendu
 * cette frontière invisible à la relecture.
 *
 * Rien n'en est **exporté** : aucun autre module n'a de raison d'ouvrir un
 * établissement, et un export serait le premier pas vers une route de salon qui
 * emprunte la porte de la console.
 *
 * ## Un fournisseur sans route : `TenantTimeZoneAudit`
 *
 * Il ne sert aucun contrôleur et n'est exporté par personne — il existe pour son
 * `onApplicationBootstrap`, qui relève au démarrage les établissements dont le
 * fuseau ne se résout pas (#604). Le déclarer ici suffit à le faire instancier,
 * et c'est bien ce module qu'il fallait choisir : la table `tenants` lui
 * appartient, et le prédicat qu'il applique est celui que son DTO de réglages
 * applique déjà à la frontière.
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
  controllers: [
    AuthController,
    UsersController,
    PublicTenantController,
    TenantSettingsController,
    PlatformAuthController,
    PlatformTenantsController,
  ],
  providers: [
    AuthService,
    UsersService,
    PublicTenantService,
    TenantSettingsService,
    TenantTimeZoneAudit,
    IdentityRepository,
    PasswordHasher,
    TokenService,
    // Le bus du module (#809). Il n'a qu'un émetteur — `AuthService`, sur la
    // demande de réinitialisation — et qu'un abonné, dans `notifications`.
    // Exporté ci-dessous pour cette raison, et pour elle seule : c'est
    // `notifications` qui dépend d'`identity`, jamais l'inverse (api-module §3),
    // et un appel direct à la chaîne d'envoi depuis ici formerait le cycle que
    // Nest refuse au démarrage.
    IdentityEvents,
    JwtAuthGuard,
    RolesGuard,
    SessionThrottlerGuard,
    publicTenantResolver,
    PlatformService,
    PlatformRepository,
    PlatformTokenService,
    PlatformAuthGuard,
  ],
  exports: [
    JwtAuthGuard,
    RolesGuard,
    TokenService,
    UsersService,
    IdentityEvents,
    PUBLIC_TENANT_RESOLVER,
  ],
})
export class IdentityModule {}
