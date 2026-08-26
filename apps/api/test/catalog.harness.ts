import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { CacheConnection } from '../src/infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../src/infrastructure/database/database.connection';
import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { ProbeDouble } from './utils/test-app';

/**
 * Amorçage du module `catalog` pour ses suites d'intégration et d'isolation.
 *
 * L'application est la **vraie** — `AppModule` câblé par `configureApp`, la même
 * fonction que `main.ts` : préfixe, versionnement, `ValidationPipe` global,
 * filtre d'exceptions, gardes de #21 et #22. Un test qui reconstruirait ce
 * câblage validerait une application qui n'existe nulle part.
 *
 * Trois substitutions seulement :
 *
 * - les connexions d'infrastructure, comme partout ailleurs dans cette suite ;
 * - `CatalogRepository`, remplacé par le double en mémoire. Ce double reproduit
 *   la propriété qui compte — le filtrage par le **vrai** contexte de tenant,
 *   celui que l'extension Prisma consulte — de sorte qu'une garde qui n'ouvrirait
 *   pas la portée, ou qui l'ouvrirait sur le mauvais établissement, fait rougir
 *   la suite ;
 * - `IdentityRepository`, pour la **table `tenants`** et elle seule. Le module
 *   `catalog` ne l'interroge jamais, mais `TenantScopeMiddleware` si : c'est par
 *   `PUBLIC_TENANT_RESOLVER` — déclaré `useExisting: IdentityRepository` — qu'un
 *   slug d'URL devient un établissement. Sans cette substitution, la route
 *   publique du catalogue irait chercher ses slugs dans un vrai client Prisma
 *   pendant que ses prestations viennent du double.
 *
 * ## Les deux façons dont l'établissement entre dans la requête
 *
 * Le module `catalog` a les deux surfaces, et elles ne se prouvent pas de la
 * même manière :
 *
 * | Surface | Qui résout | Depuis quoi |
 * |---|---|---|
 * | back-office (`/services`, `/service-categories`) | `JwtAuthGuard` | la revendication d'un jeton vérifié |
 * | publique (`/public/:tenantSlug/services`) | `TenantScopeMiddleware` | le slug d'URL, résolu contre `tenants` |
 *
 * D'où les deux paires exposées ici : `tenantId`/`otherTenantId` désignent les
 * établissements pour la première, `tenantSlug`/`otherTenantSlug` pour la
 * seconde — et ce sont **les mêmes** établissements, les slugs étant déclarés
 * sur les identifiants tirés au sort ci-dessous.
 *
 * ## Les jetons sont signés, pas simulés
 *
 * `tokenFor` passe par `TokenService`, donc par la même signature et les mêmes
 * revendications que la connexion réelle. C'est la seule façon d'exercer
 * `JwtAuthGuard` pour ce qu'il fait : lire le `tenantId` d'un jeton **vérifié**
 * et le poser dans le contexte de requête. Un jeton fabriqué à la main ne
 * prouverait rien de ce chemin.
 */

/** Slug public de l'établissement de l'appelant. */
export const TENANT_SLUG = 'salon-des-lilas';
/** Slug public de l'établissement voisin. */
export const OTHER_TENANT_SLUG = 'barbier-du-port';

export interface CatalogHarness {
  app: INestApplication;
  repository: FakeCatalogRepository;
  /**
   * Le dépôt `identity` en mémoire — exposé pour la seule table `tenants` :
   * c'est là qu'une suite déclare l'établissement supplémentaire dont elle a
   * besoin, un salon désactivé par exemple.
   */
  identity: FakeIdentityRepository;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Le slug par lequel l'espace public désigne `tenantId`. */
  tenantSlug: string;
  /** Le slug par lequel l'espace public désigne `otherTenantId`. */
  otherTenantSlug: string;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createCatalogHarness(): Promise<CatalogHarness> {
  const repository = new FakeCatalogRepository();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const identity = new FakeIdentityRepository();
  // Les slugs sont déclarés **sur les identifiants ci-dessus** : la route
  // publique et les routes à jeton désignent ainsi les deux mêmes
  // établissements, et un test peut semer chez l'un pour lire chez l'autre.
  identity.addTenant(TENANT_SLUG, tenantId);
  identity.addTenant(OTHER_TENANT_SLUG, otherTenantId, { name: 'Barbier du Port' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CacheConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CatalogRepository)
    .useValue(repository)
    .overrideProvider(IdentityRepository)
    .useValue(identity)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const tokens = app.get(TokenService);

  return {
    app,
    repository,
    identity,
    tenantId,
    otherTenantId,
    tenantSlug: TENANT_SLUG,
    otherTenantSlug: OTHER_TENANT_SLUG,
    tokenFor: async (role, forTenant) =>
      tokens.signAccessToken({
        userId: randomUUID(),
        tenantId: forTenant ?? tenantId,
        role,
      }),
    close: () => app.close(),
  };
}
