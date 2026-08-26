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
 * Deux substitutions seulement :
 *
 * - les connexions d'infrastructure, comme partout ailleurs dans cette suite ;
 * - `CatalogRepository`, remplacé par le double en mémoire. Ce double reproduit
 *   la propriété qui compte — le filtrage par le **vrai** contexte de tenant,
 *   celui que l'extension Prisma consulte — de sorte qu'une garde qui n'ouvrirait
 *   pas la portée, ou qui l'ouvrirait sur le mauvais établissement, fait rougir
 *   la suite.
 *
 * ## Les jetons sont signés, pas simulés
 *
 * `tokenFor` passe par `TokenService`, donc par la même signature et les mêmes
 * revendications que la connexion réelle. C'est la seule façon d'exercer
 * `JwtAuthGuard` pour ce qu'il fait : lire le `tenantId` d'un jeton **vérifié**
 * et le poser dans le contexte de requête. Un jeton fabriqué à la main ne
 * prouverait rien de ce chemin.
 */

export interface CatalogHarness {
  app: INestApplication;
  repository: FakeCatalogRepository;
  /** L'établissement de l'appelant — celui que porteront ses jetons par défaut. */
  tenantId: string;
  /** L'établissement voisin, pour les scénarios de traversée. */
  otherTenantId: string;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenantId?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createCatalogHarness(): Promise<CatalogHarness> {
  const repository = new FakeCatalogRepository();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CacheConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CatalogRepository)
    .useValue(repository)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const tokens = app.get(TokenService);

  return {
    app,
    repository,
    tenantId,
    otherTenantId,
    tokenFor: async (role, forTenant) =>
      tokens.signAccessToken({
        userId: randomUUID(),
        tenantId: forTenant ?? tenantId,
        role,
      }),
    close: () => app.close(),
  };
}
