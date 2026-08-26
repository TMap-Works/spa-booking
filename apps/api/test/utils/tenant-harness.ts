import { randomUUID } from 'node:crypto';

import type { INestApplication, InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AppConfigService } from '../../src/config/app-config.service';
import { CacheConnection } from '../../src/infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../../src/infrastructure/database/database.connection';
import { IdentityRepository } from '../../src/modules/identity/identity.repository';
import { PasswordHasher } from '../../src/modules/identity/password.hasher';
import type { UserRole } from '../../src/modules/identity/roles';
import { TokenService } from '../../src/modules/identity/token.service';
import { FakeIdentityRepository } from '../../src/modules/identity/__tests__/identity.doubles';
import { ProbeDouble } from './test-app';

/**
 * Harnais des tests de fuite inter-tenant — **deux établissements, une seule
 * application, des jetons signés** (#27).
 *
 * Le protocole de tenant-isolation §6 est le même pour les huit modules : créer
 * une ressource chez A, s'authentifier comme B, tenter lecture, modification et
 * suppression par identifiant, attendre 404, vérifier que la ressource de A est
 * intacte, et qu'aucune liste ne laisse voir un identifiant d'ailleurs. Ce qui
 * précède ce protocole — deux établissements, l'application réellement câblée,
 * un porteur par rôle — était jusqu'ici réécrit dans chaque suite : quatre
 * `createHarness` locaux, quasi identiques, qui divergeaient déjà sur le nom des
 * établissements et sur ce qu'ils substituaient.
 *
 * Ce module est ce préalable, écrit une fois. Les assertions du protocole
 * lui-même vivent dans `./tenant-assertions.ts`.
 *
 * ## L'application est la vraie
 *
 * `AppModule` câblé par `configureApp` — la **même** fonction que `main.ts` :
 * préfixe, versionnement, `ValidationPipe` global, filtre d'exceptions, gardes
 * d'authentification et de rôles. Un harnais qui reconstruirait ce câblage
 * prouverait l'isolation d'une application qui n'existe nulle part.
 *
 * Trois substitutions, et pas une de plus :
 *
 * - `DatabaseConnection` et `CacheConnection`, les deux sondes d'infrastructure,
 *   comme partout ailleurs dans cette suite ;
 * - `IdentityRepository`, remplacé par le double en mémoire. Ce n'est pas une
 *   commodité : c'est lui qui porte la table `tenants`, donc la résolution d'un
 *   slug d'URL par `TenantScopeMiddleware`, et c'est lui qui refuse de lire hors
 *   portée. Un double qui rendrait « toutes les lignes » sans tenant courant
 *   ferait passer au vert exactement la fuite qu'on cherche.
 *
 * Un module qui a son propre dépôt — `catalog`, et les six qui viendront — le
 * déclare par `overrides`, sans redire le reste.
 *
 * ## Les jetons sont signés, pas simulés
 *
 * `tokenFor` passe par le **vrai** `TokenService` : même signature, mêmes
 * revendications que la connexion réelle. C'est la seule façon d'exercer
 * `JwtAuthGuard` pour ce qu'il fait — lire le `tenantId` d'un jeton *vérifié* et
 * le poser dans le contexte de requête. Un jeton fabriqué à la main ne
 * prouverait rien de ce chemin, et un `login` complet ferait hacher un mot de
 * passe par cas sans rien prouver de plus (c'est `identity-auth` qui exerce la
 * connexion).
 */

/** L'établissement de l'appelant — celui chez qui les ressources sont créées. */
export const TENANT_A = { slug: 'salon-des-lilas', name: 'Salon des Lilas' } as const;

/** L'établissement voisin — celui qu'aucune réponse ne doit laisser voir. */
export const TENANT_B = { slug: 'barbier-du-port', name: 'Barbier du Port' } as const;

/** Un établissement du harnais, tel que les suites le désignent. */
export interface TenantFixture {
  /** L'identifiant interne, celui que portent les jetons et les lignes. */
  readonly id: string;
  /** Le slug par lequel l'espace public désigne cet établissement. */
  readonly slug: string;
  readonly name: string;
}

/** Substitution de fournisseur supplémentaire — le dépôt d'un module métier. */
export interface ProviderOverride {
  readonly provide: InjectionToken;
  readonly useValue: unknown;
}

export interface TenantHarnessOptions {
  /**
   * Dépôts de modules métier à substituer, en plus des connexions et
   * d'`IdentityRepository`.
   */
  readonly overrides?: readonly ProviderOverride[];
  /**
   * Un dépôt `identity` déjà instancié — pour une suite qui doit y déclarer
   * autre chose que les deux établissements du harnais (un salon désactivé, un
   * salon sans coordonnées) ou y poser une sentinelle **avant** que
   * l'application ne soit compilée.
   */
  readonly identity?: FakeIdentityRepository;
}

/** Un compte, tel que le harnais le sème. */
export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface TenantHarness {
  readonly app: INestApplication;
  /**
   * Le dépôt `identity` en mémoire — exposé pour la table `tenants` et pour les
   * comptes : c'est là qu'une suite déclare l'établissement supplémentaire dont
   * elle a besoin.
   */
  readonly identity: FakeIdentityRepository;
  /** L'établissement de l'appelant. */
  readonly a: TenantFixture;
  /** L'établissement voisin, pour les scénarios de traversée. */
  readonly b: TenantFixture;
  /** Le serveur HTTP, à passer à `supertest`. */
  server(): ReturnType<INestApplication['getHttpServer']>;
  /** Un jeton d'accès signé, pour ce rôle et — au besoin — cet établissement. */
  tokenFor(role: UserRole, tenant?: TenantFixture | string): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(role: UserRole, tenant?: TenantFixture | string): Promise<string>;
  /**
   * Sème un compte dans un établissement et rend de quoi le désigner.
   *
   * Le mot de passe est haché par le **vrai** `PasswordHasher` quand il est
   * fourni : c'est ce qui rend le compte utilisable par `/auth/login`. Sans mot
   * de passe, le compte n'existe que pour être lu — ce que la plupart des tests
   * de fuite demandent.
   */
  seedUser(
    tenant: TenantFixture,
    input?: { email?: string; role?: UserRole; password?: string; isActive?: boolean },
  ): Promise<SeededUser>;
  close(): Promise<void>;
}

/**
 * Un identifiant de la bonne forme qui ne désigne rien.
 *
 * Utile au cas de référence du protocole : « inconnu ici » et « connu ailleurs »
 * doivent produire la **même** réponse, faute de quoi la différence sert de
 * sonde d'existence (tenant-isolation §4).
 */
export const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

export async function createTenantHarness(
  options: TenantHarnessOptions = {},
): Promise<TenantHarness> {
  const identity = options.identity ?? new FakeIdentityRepository();

  // Les identifiants sont tirés ici, puis déclarés **avec** leur slug : la route
  // publique et les routes à jeton désignent ainsi les deux mêmes
  // établissements, et un test peut semer chez l'un pour lire chez l'autre.
  const idA = randomUUID();
  const idB = randomUUID();
  identity.addTenant(TENANT_A.slug, idA, { name: TENANT_A.name });
  identity.addTenant(TENANT_B.slug, idB, { name: TENANT_B.name });
  const a: TenantFixture = { id: idA, ...TENANT_A };
  const b: TenantFixture = { id: idB, ...TENANT_B };

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CacheConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(IdentityRepository)
    .useValue(identity);

  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const tokens = app.get(TokenService);
  const hasher = app.get(PasswordHasher);

  /**
   * L'établissement visé par un jeton.
   *
   * La forme chaîne est acceptée — `catalog.harness.ts` la reprend — mais elle
   * est **vérifiée** : seuls les deux identifiants du harnais passent. Sans ce
   * contrôle, `tokenFor('ADMIN', harness.b.slug)` compilerait sans broncher et
   * signerait un jeton sur une portée qui ne désigne aucun établissement. Toutes
   * les lectures y répondraient « rien », donc tous les cas de traversée
   * verdiraient — sans avoir jamais visé le voisin. C'est exactement le mode de
   * défaillance qu'un harnais de fuite ne peut pas se permettre : silencieux, et
   * du bon côté du vert.
   */
  const tenantIdOf = (tenant: TenantFixture | string | undefined): string => {
    if (tenant === undefined) {
      return a.id;
    }
    if (typeof tenant !== 'string') {
      return tenant.id;
    }
    if (tenant !== a.id && tenant !== b.id) {
      throw new Error(
        `« ${tenant} » n’est ni l’identifiant de ${a.slug} ni celui de ${b.slug}. ` +
          'Passer `harness.a` ou `harness.b` plutôt qu’une chaîne — un slug ou un ' +
          'identifiant inventé signerait un jeton sur une portée vide, et les cas ' +
          'de traversée passeraient au vert sans avoir rien visé.',
      );
    }
    return tenant;
  };

  const tokenFor = async (role: UserRole, tenant?: TenantFixture | string): Promise<string> =>
    tokens.signAccessToken({ userId: randomUUID(), tenantId: tenantIdOf(tenant), role });

  return {
    app,
    identity,
    a,
    b,
    server: () => app.getHttpServer(),
    tokenFor,
    bearer: async (role, tenant) => `Bearer ${await tokenFor(role, tenant)}`,
    seedUser: async (tenant, input = {}) => {
      const email = input.email ?? `${tenant.slug}-${randomUUID().slice(0, 8)}@example.test`;
      const user = identity.addUser({
        tenantId: tenant.id,
        email,
        passwordHash: input.password === undefined ? null : await hasher.hash(input.password),
        role: input.role ?? 'CLIENT',
        // Étalé sous condition, et non posé à `undefined` :
        // `exactOptionalPropertyTypes` distingue « absent » de « présent et
        // indéfini », et le double ne connaît que le premier.
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      });
      return { id: user.id, email: user.email, role: user.role };
    },
    close: () => app.close(),
  };
}
