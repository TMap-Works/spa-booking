import type { INestApplication } from '@nestjs/common';

import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import type { UserRole } from '../src/modules/identity/roles';
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { createTenantHarness, TENANT_A, TENANT_B, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `catalog` pour ses suites d'intégration et d'isolation.
 *
 * Ce n'est plus qu'une **spécialisation** du harnais partagé
 * (`utils/tenant-harness.ts`, #27) : deux établissements, l'application
 * réellement câblée par `configureApp`, des jetons signés par le vrai
 * `TokenService`. Tout cela est commun aux huit modules et vit là-bas. Il ne
 * reste ici que ce qui est propre au catalogue — la substitution de
 * `CatalogRepository` par son double en mémoire, et les noms sous lesquels les
 * suites du module désignent les deux établissements.
 *
 * Ce double reproduit la propriété qui compte — le filtrage par le **vrai**
 * contexte de tenant, celui que l'extension Prisma consulte — de sorte qu'une
 * garde qui n'ouvrirait pas la portée, ou qui l'ouvrirait sur le mauvais
 * établissement, fait rougir la suite.
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
 * sur les identifiants par le harnais partagé.
 */

/** Slug public de l'établissement de l'appelant. */
export const TENANT_SLUG = TENANT_A.slug;
/** Slug public de l'établissement voisin. */
export const OTHER_TENANT_SLUG = TENANT_B.slug;

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

  // `IdentityRepository` est substitué par le harnais partagé, et il l'est pour
  // le module `catalog` aussi : ce dernier ne l'interroge jamais, mais
  // `TenantScopeMiddleware` si — c'est par `PUBLIC_TENANT_RESOLVER`, déclaré
  // `useExisting: IdentityRepository`, qu'un slug d'URL devient un
  // établissement. Sans cette substitution, la route publique du catalogue irait
  // chercher ses slugs dans un vrai client Prisma pendant que ses prestations
  // viennent du double.
  const harness: TenantHarness = await createTenantHarness({
    overrides: [{ provide: CatalogRepository, useValue: repository }],
  });

  return {
    app: harness.app,
    repository,
    identity: harness.identity,
    tenantId: harness.a.id,
    otherTenantId: harness.b.id,
    tenantSlug: harness.a.slug,
    otherTenantSlug: harness.b.slug,
    tokenFor: (role, forTenant) => harness.tokenFor(role, forTenant),
    close: () => harness.close(),
  };
}
