import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { Locale } from '@spa/shared';

import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { BillingRepository } from '../src/modules/payments/billing/billing.repository';
import { STRIPE_BILLING_GATEWAY } from '../src/modules/payments/billing/stripe-billing.gateway';
import {
  FakeBillingRepository,
  FakeStripeBillingGateway,
  type SeedBillingInput,
} from '../src/modules/payments/__tests__/billing.doubles';
import { testStripeConfig } from '../src/modules/payments/__tests__/payments.doubles';
import { StripeConfig } from '../src/modules/payments/stripe/stripe.config';
import {
  createTenantHarness,
  type TenantFixture,
  type TenantHarness,
} from './utils/tenant-harness';

/**
 * Amorçage de l'abonnement des salons pour ses suites d'intégration et
 * d'isolation — ADR 0016, #1262.
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`), sur le
 * modèle de `payments.harness.ts` : deux établissements, l'application réellement
 * câblée par `configureApp`, des jetons signés par le vrai `TokenService`. Il ne
 * reste ici que ce qui est propre à l'abonnement — trois substitutions, chacune
 * pour une raison distincte :
 *
 * 1. `BillingRepository` → son double en mémoire, qui reproduit le **scoping par
 *    tenant** de l'extension Prisma en filtrant sur le vrai contexte de requête.
 *    C'est cette propriété-là que la suite de fuite exerce ; un double qui
 *    l'ignorerait ferait verdir exactement ce qu'on cherche ;
 * 2. `STRIPE_BILLING_GATEWAY` → une passerelle en mémoire. **Aucune suite de ce
 *    dépôt n'atteint Stripe**, live ou test (payments-stripe §7) ;
 * 3. `StripeConfig` → une configuration complète, avec deux clés de remplissage.
 *    Sans elle, la suite dépendrait de l'environnement de la machine : verte sur
 *    un poste qui a des clés, rouge ailleurs.
 *
 * ## Ce que le double prouve, et ce qui le prouve à sa place
 *
 * Un double en mémoire ne peut rien dire de ce que PostgreSQL fait d'un `where`,
 * et ce n'est pas ce qu'on lui demande. Le partage est le même que pour
 * `payments` et `identity`, et il tient en deux suites :
 *
 * - `tenant-scope.isolation-spec.ts` prouve **contre un vrai moteur** que
 *   l'extension Prisma borne tout modèle portant un `tenantId` — `User`
 *   nommément, parce que son `@@unique([tenantId, email])` autorise la même
 *   adresse dans deux établissements ;
 * - cette suite-ci prouve que la **chaîne** qui mène jusqu'à cette extension est
 *   intacte : le middleware ouvre la portée, `JwtAuthGuard` y pose le `tenantId`
 *   d'une revendication signée, et le service lit dedans. C'est cette chaîne-là
 *   qui casse quand on oublie un décorateur ou qu'on passe un identifiant par le
 *   corps, et c'est elle qu'aucune des trois suites unitaires du module ne voit.
 *
 * D'où la seule propriété que le double doit absolument reproduire : filtrer sur
 * le **vrai** `getTenantId()`. Un double qui tiendrait sa propre idée du tenant
 * courant ferait verdir une garde qui n'ouvre pas la portée.
 *
 * ## Les trois routes entrent par un jeton, et par lui seul
 *
 * `BillingController` est `@AuthWith('settings:write')` : il n'a ni paramètre de
 * chemin, ni slug public. L'établissement vient de la revendication signée du
 * jeton, et le gérant aussi — ce qui change la forme du protocole de fuite par
 * rapport au catalogue ou à l'encaissement. Il n'y a **aucun identifiant à faire
 * traverser** : une tentative croisée consiste à présenter un jeton du voisin et
 * à vérifier que la réponse décrit le voisin, jamais le salon principal. C'est
 * pourquoi cette suite n'emprunte pas `expectCrossTenantNotFound` — un 404 n'a
 * pas de sens sur une route qui n'a rien à désigner.
 *
 * ## Les comptes sont réels, parce que `findAccountLocale` les lit
 *
 * Le harnais partagé signe ses jetons sur un `userId` tiré au hasard, ce qui
 * suffit partout où le sujet du jeton ne sert qu'à être journalisé. Ici il ne
 * suffit pas : `BillingRepository.findAccountLocale` lit `users.locale` sur ce
 * sujet-là (#1231), et un identifiant qui ne désigne aucun compte se lirait
 * « aucune préférence » — c'est-à-dire exactement la réponse qu'on attend d'un
 * compte **du voisin**. Les deux cas deviendraient indiscernables, et le test de
 * portée passerait au vert sans avoir rien exercé.
 *
 * Ce harnais sème donc les **quatre rôles** dans chacun des deux établissements,
 * et `tokenFor` signe sur l'identifiant du compte semé.
 */

/** Les trois routes de l'abonnement, telles que l'application les sert. */
export const BILLING_PATHS = {
  subscription: '/api/v1/billing/subscription',
  checkout: '/api/v1/billing/checkout',
  portal: '/api/v1/billing/portal',
} as const;

/**
 * Le client Stripe du salon principal, et celui du voisin.
 *
 * Deux chaînes distinctes et reconnaissables : ce sont elles que la suite de
 * fuite surveille dans les corps de réponse et dans les commandes reçues par la
 * passerelle. Un identifiant de client est ce qui ouvre le portail de facturation
 * d'un salon — le laisser filer serait la fuite la plus coûteuse de ce module.
 */
export const MAIN_CUSTOMER_ID = 'cus_fixture_lilas';
export const OTHER_CUSTOMER_ID = 'cus_fixture_port';

/** La langue de l'établissement principal, et celle du voisin — toujours distinctes. */
export const MAIN_TENANT_LOCALE: Locale = 'en';
export const OTHER_TENANT_LOCALE: Locale = 'fr';

/**
 * Deux états d'abonnement qui ne se ressemblent sur **aucun** champ du contrat.
 *
 * `TenantBilling` ne porte que quatre champs, dont aucun identifiant : deux
 * fiches semées à l'identique auraient rendu la même réponse au voisin qu'au
 * titulaire, et la suite de fuite aurait été verte sans rien distinguer. Le
 * principal est donc un salon qui n'a jamais payé et dont l'essai court ; le
 * voisin, un salon résilié dont la dernière échéance est enregistrée — deux
 * statuts qui autorisent tous deux l'ouverture d'une page de paiement, ce dont
 * les scénarios ont besoin.
 */
export const MAIN_TRIAL_ENDS_AT = new Date('2026-11-01T00:00:00.000Z');
export const OTHER_PERIOD_ENDS_AT = new Date('2026-12-15T00:00:00.000Z');

/** Un compte semé, tel que les suites le désignent. */
export interface BillingAccount {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  /** `null` — « aucune préférence enregistrée », l'état par défaut (#844). */
  readonly locale: Locale | null;
  /** L'établissement auquel ce compte appartient réellement. */
  readonly tenant: TenantFixture;
}

export interface BillingHarnessOptions {
  /** La facturation de l'établissement principal — défauts de `seedTenant`. */
  readonly main?: Omit<SeedBillingInput, 'slug'>;
  /** La facturation de l'établissement voisin. */
  readonly other?: Omit<SeedBillingInput, 'slug'>;
}

export interface BillingHarness {
  readonly app: INestApplication;
  /** Le dépôt en mémoire — c'est par lui que les suites relisent l'état écrit. */
  readonly repository: FakeBillingRepository;
  /** La passerelle en mémoire — commandes reçues, instantanés semés. */
  readonly stripe: FakeStripeBillingGateway;
  /** Le dépôt `identity` en mémoire, qui porte la table des comptes. */
  readonly identity: FakeIdentityRepository;
  /** L'établissement de l'appelant. */
  readonly a: TenantFixture;
  /** L'établissement voisin, pour les scénarios de traversée. */
  readonly b: TenantFixture;
  /** Les quatre comptes semés dans cet établissement, par rôle. */
  accounts(tenant: TenantFixture): Readonly<Record<UserRole, BillingAccount>>;
  /** Sème un compte de plus — pour un scénario qui dépend d'une langue précise. */
  seedAccount(
    tenant: TenantFixture,
    input?: { role?: UserRole; locale?: Locale | null; email?: string },
  ): BillingAccount;
  /**
   * Un jeton d'accès signé pour ce compte.
   *
   * `scope` sert **un seul** scénario, et il est délibérément explicite : signer
   * un jeton dont le sujet appartient à un établissement et dont la portée en
   * désigne un autre. Ce n'est pas une curiosité de test — `JwtAuthGuard` lit
   * `tenantId` et `sub` de la même revendication signée sans vérifier que le
   * second appartient au premier, si bien que la portée du dépôt est la **seule**
   * chose qui empêche alors de lire la préférence de langue du voisin. C'est
   * exactement ce que #1262 demande de verrouiller par un test.
   */
  tokenFor(account: BillingAccount, scope?: TenantFixture): Promise<string>;
  /** Le même jeton, déjà mis en forme pour l'en-tête `Authorization`. */
  bearer(account: BillingAccount, scope?: TenantFixture): Promise<string>;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

export async function createBillingHarness(
  options: BillingHarnessOptions = {},
): Promise<BillingHarness> {
  const identity = new FakeIdentityRepository();
  // La table des comptes est passée **par référence** : les comptes semés après
  // la compilation de l'application doivent être visibles du dépôt de
  // facturation, et c'est le cas normal — on ne peut pas semer avant de savoir
  // quels établissements le harnais a créés.
  const repository = new FakeBillingRepository(identity.users);
  const stripe = new FakeStripeBillingGateway();

  const harness: TenantHarness = await createTenantHarness({
    identity,
    overrides: [
      { provide: BillingRepository, useValue: repository },
      { provide: STRIPE_BILLING_GATEWAY, useValue: stripe },
      { provide: StripeConfig, useValue: testStripeConfig() },
    ],
  });

  // Les deux établissements ont un client Stripe et une langue **différents** :
  // c'est ce qui rend une traversée observable. Deux fiches identiques auraient
  // rendu la même réponse au voisin qu'au titulaire, et le test n'aurait rien
  // distingué.
  repository.seedTenant(harness.a.id, {
    slug: harness.a.slug,
    name: harness.a.name,
    status: 'pending',
    trialEndsAt: MAIN_TRIAL_ENDS_AT,
    stripeCustomerId: MAIN_CUSTOMER_ID,
    defaultLocale: MAIN_TENANT_LOCALE,
    ...options.main,
  });
  repository.seedTenant(harness.b.id, {
    slug: harness.b.slug,
    name: harness.b.name,
    status: 'canceled',
    currentPeriodEndsAt: OTHER_PERIOD_ENDS_AT,
    stripeCustomerId: OTHER_CUSTOMER_ID,
    defaultLocale: OTHER_TENANT_LOCALE,
    ...options.other,
  });

  /**
   * La même facturation dans la table `tenants` du double `identity`.
   *
   * `billingStatus` et `trialEndsAt` sont **une seule** paire de colonnes en
   * base, et deux lecteurs les lisent : `BillingRepository`, pour l'écran
   * d'abonnement, et `TenantBillingGate` — par `IdentityRepository` — pour la
   * garde qui ferme le back-office d'un salon impayé (ADR 0016). Les laisser
   * diverger ici ferait répondre `managed` à la garde quoi que la suite ait
   * semé : un scénario attendant 402 `SUBSCRIPTION_REQUIRED` sur une route sans
   * `@AllowUnpaidTenant` obtiendrait 200, sans que rien ne le signale. C'est la
   * raison exacte pour laquelle les comptes, eux, n'ont qu'une table.
   *
   * Le report a lieu à l'ensemencement : une suite qui écrirait ensuite le
   * statut par une resynchronisation doit le refaire elle-même, le double de
   * facturation ne modélisant pas la table de l'autre.
   */
  const reporterLaFacturation = (tenant: TenantFixture): void => {
    const row = repository.rowOf(tenant.id);
    if (row !== null) {
      identity.addTenant(tenant.slug, tenant.id, {
        name: tenant.name,
        billingStatus: row.status,
        trialEndsAt: row.trialEndsAt,
      });
    }
  };
  reporterLaFacturation(harness.a);
  reporterLaFacturation(harness.b);

  const tokens = harness.app.get(TokenService);

  /**
   * Sème un compte dans un établissement.
   *
   * Passe par `identity.addUser` et non par `harness.seedUser`, pour une raison
   * précise : le second ne prend pas de `locale`, et c'est la seule colonne dont
   * cette suite ait réellement besoin. Aucun mot de passe n'est haché — ces
   * comptes existent pour être **lus** et pour porter un jeton, jamais pour
   * passer par `/auth/login`, qui a sa propre suite.
   */
  const seedAccount = (
    tenant: TenantFixture,
    input: { role?: UserRole; locale?: Locale | null; email?: string } = {},
  ): BillingAccount => {
    const role = input.role ?? 'ADMIN';
    const user = identity.addUser({
      tenantId: tenant.id,
      email: input.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@${tenant.slug}.test`,
      passwordHash: null,
      role,
      locale: input.locale ?? null,
    });

    return { id: user.id, email: user.email, role: user.role, locale: user.locale, tenant };
  };

  /** Les quatre rôles, dans chacun des deux établissements. */
  const seedRoles = (tenant: TenantFixture): Readonly<Record<UserRole, BillingAccount>> =>
    Object.freeze({
      CLIENT: seedAccount(tenant, { role: 'CLIENT' }),
      STAFF: seedAccount(tenant, { role: 'STAFF' }),
      MANAGER: seedAccount(tenant, { role: 'MANAGER' }),
      ADMIN: seedAccount(tenant, { role: 'ADMIN' }),
    });

  const roles = new Map<string, Readonly<Record<UserRole, BillingAccount>>>([
    [harness.a.id, seedRoles(harness.a)],
    [harness.b.id, seedRoles(harness.b)],
  ]);

  const tokenFor = async (account: BillingAccount, scope?: TenantFixture): Promise<string> =>
    tokens.signAccessToken({
      userId: account.id,
      tenantId: (scope ?? account.tenant).id,
      role: account.role,
    });

  return {
    app: harness.app,
    repository,
    stripe,
    identity,
    a: harness.a,
    b: harness.b,
    accounts: (tenant) => {
      const found = roles.get(tenant.id);
      if (found === undefined) {
        // Un établissement inconnu rendrait `undefined`, puis un `userId`
        // indéfini dans le jeton — et toutes les lectures répondraient « aucune
        // préférence », donc tous les cas de repli verdiraient sans avoir rien
        // visé. Même mode de défaillance que le `tenantIdOf` du harnais partagé.
        throw new Error(
          `« ${tenant.slug} » n’est ni l’établissement principal ni le voisin : ` +
            'passer `harness.a` ou `harness.b`.',
        );
      }
      return found;
    },
    seedAccount,
    tokenFor,
    bearer: async (account, scope) => `Bearer ${await tokenFor(account, scope)}`,
    server: harness.server,
    close: harness.close,
  };
}
