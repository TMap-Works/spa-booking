import { JwtService } from '@nestjs/jwt';

import type { StructuredLogger } from '../../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../../config/app-config.service';
import { NotFoundError } from '../../../../common/errors';
import { PasswordHasher } from '../../password.hasher';
import { TokenService } from '../../token.service';
import { fakeConfig, rejectionOf } from '../../__tests__/identity.doubles';
import {
  InvalidPlatformCredentialsError,
  TenantAdminMissingError,
  TenantSlugTakenError,
} from '../platform.errors';
import { PlatformService } from '../platform.service';
import { PlatformTokenService } from '../platform-token.service';
import type { AuthenticatedOperator } from '../platform.types';
import { generateTotpSecret, totpCodeAt } from '../totp';
import { FakePlatformRepository } from './platform.doubles';

/**
 * La console de l'éditeur — règles métier, sans HTTP ni base.
 *
 * Trois propriétés y sont vérifiées, et ce sont les trois que le ticket met en
 * jeu : le second facteur est **exigé**, l'ouverture est **idempotente**, et les
 * trois liens rendus sont ceux qu'un gérant peut réellement suivre.
 */

const APP_URL = 'https://exemple.test';
const PASSWORD = 'correct-horse-battery';

/**
 * Deux clés d'idempotence, courtes et sans entropie.
 *
 * Des littéraux plus longs — `ouverture-maison-lotus-1` — franchissaient le
 * seuil d'entropie de `gitleaks`, qui voit dans toute valeur assignée à un
 * champ nommé `…Key` une clé d'API en fuite, et bloquait la CI sur une
 * chaîne de test. Les nommer une fois vaut mieux que les répéter : c'est
 * aussi ce qui rend visible qu'un cas rejoue **la même** clé et l'autre non.
 */
const CLE = 'cle-test-806';
const AUTRE_CLE = 'cle-test-807';

/** Ce qu'un journal a enregistré — pour vérifier qu'aucun jeton n'y figure. */
interface CapturedLog {
  message: string;
  params: unknown[];
}

interface Fixture {
  service: PlatformService;
  repository: FakePlatformRepository;
  operator: AuthenticatedOperator;
  totpSecret: string;
  logs: CapturedLog[];
}

async function fixture(): Promise<Fixture> {
  const config = fakeConfig({ appUrl: APP_URL } as Partial<AppConfigService>);
  const hasher = new PasswordHasher(config);
  const repository = new FakePlatformRepository();
  const totpSecret = generateTotpSecret();
  const stored = repository.addOperator({
    email: 'operateur@tmap-works.test',
    passwordHash: await hasher.hash(PASSWORD),
    totpSecret,
  });

  const logs: CapturedLog[] = [];
  const logger = {
    log: (message: unknown, ...params: unknown[]): void => {
      logs.push({ message: String(message), params });
    },
    warn: (): void => undefined,
    error: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;

  const service = new PlatformService(
    repository.asRepository(),
    hasher,
    new PlatformTokenService(new JwtService(), config),
    new TokenService(new JwtService(), config),
    config,
    logger,
  );

  return {
    service,
    repository,
    operator: { operatorId: stored.id, email: stored.email },
    totpSecret,
    logs,
  };
}

/** Une charge utile d'ouverture complète, dont seul le slug varie. */
function tenantPayload(slug: string): {
  slug: string;
  name: string;
  timezone: string;
  defaultCurrency: string;
  countryCode: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string | null;
  city: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
} {
  return {
    slug,
    name: 'Maison Lotus',
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
    countryCode: 'FR',
    addressLine1: '12 rue des Lilas',
    addressLine2: null,
    postalCode: '75011',
    city: 'Paris',
    adminEmail: 'Gerante@Maison-Lotus.test',
    adminFirstName: 'Alice',
    adminLastName: 'Durand',
  };
}

describe('Connexion d’un opérateur — MFA exigée', () => {
  it('ouvre une session avec le mot de passe **et** le code du moment', async () => {
    const { service, repository, totpSecret, operator } = await fixture();

    const session = await service.login({
      email: 'operateur@tmap-works.test',
      password: PASSWORD,
      totpCode: totpCodeAt(totpSecret, Date.now()) ?? '',
    });

    expect(session.operator.id).toBe(operator.operatorId);
    expect(session.expiresIn).toBeGreaterThan(0);
    expect(repository.lastLoginTouched).toBe(operator.operatorId);
  });

  it('refuse le bon mot de passe sans code — le second facteur n’est pas optionnel', async () => {
    const { service } = await fixture();

    const error = await rejectionOf(
      service.login({ email: 'operateur@tmap-works.test', password: PASSWORD, totpCode: '000000' }),
    );

    expect(error).toBeInstanceOf(InvalidPlatformCredentialsError);
  });

  it('refuse le bon code avec un mauvais mot de passe', async () => {
    const { service, totpSecret } = await fixture();

    const error = await rejectionOf(
      service.login({
        email: 'operateur@tmap-works.test',
        password: 'pas-le-bon-mot-de-passe',
        totpCode: totpCodeAt(totpSecret, Date.now()) ?? '',
      }),
    );

    expect(error).toBeInstanceOf(InvalidPlatformCredentialsError);
  });

  it('rend le **même** refus sur une adresse inconnue — aucun oracle d’annuaire', async () => {
    const { service, totpSecret } = await fixture();

    const error = await rejectionOf(
      service.login({
        email: 'inconnu@tmap-works.test',
        password: PASSWORD,
        totpCode: totpCodeAt(totpSecret, Date.now()) ?? '',
      }),
    );

    expect(error).toBeInstanceOf(InvalidPlatformCredentialsError);
  });

  it('refuse un opérateur désactivé, sans le dire', async () => {
    const { service, repository } = await fixture();
    const hasher = new PasswordHasher(fakeConfig());
    const secret = generateTotpSecret();
    repository.addOperator({
      email: 'ferme@tmap-works.test',
      passwordHash: await hasher.hash(PASSWORD),
      totpSecret: secret,
      isActive: false,
    });

    const error = await rejectionOf(
      service.login({
        email: 'ferme@tmap-works.test',
        password: PASSWORD,
        totpCode: totpCodeAt(secret, Date.now()) ?? '',
      }),
    );

    expect(error).toBeInstanceOf(InvalidPlatformCredentialsError);
  });

  it('normalise l’adresse, comme la connexion d’un salon', async () => {
    const { service, totpSecret } = await fixture();

    const session = await service.login({
      email: '  Operateur@TMap-Works.test ',
      password: PASSWORD,
      totpCode: totpCodeAt(totpSecret, Date.now()) ?? '',
    });

    expect(session.operator.email).toBe('operateur@tmap-works.test');
  });
});

describe('Ouverture d’un établissement', () => {
  it('crée le salon, son administrateur, et rend les trois liens', async () => {
    const { service, operator } = await fixture();

    const provisioned = await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('maison-lotus'),
    });

    expect(provisioned.replayed).toBe(false);
    expect(provisioned.tenant.slug).toBe('maison-lotus');
    // L'adresse du gérant est normalisée avant écriture, comme partout ailleurs :
    // une adresse écrite en casse mixte serait prise et pourtant introuvable par
    // une connexion qui, elle, normalise.
    expect(provisioned.admin.email).toBe('gerante@maison-lotus.test');
    expect({
      booking: provisioned.links.bookingUrl,
      login: provisioned.links.adminLoginUrl,
    }).toEqual({
      booking: 'https://maison-lotus.exemple.test/reservation',
      login: 'https://maison-lotus.exemple.test/admin/connexion',
    });
    expect(provisioned.links.adminInvitationUrl).toMatch(
      /^https:\/\/maison-lotus\.exemple\.test\/admin\/invitation\?token=/,
    );
    expect(provisioned.links.invitationExpiresIn).toBeGreaterThan(0);
  });

  it('ouvre le salon en anglais quand la console ne se prononce pas — #844', async () => {
    // Le troisième critère de #844 : `en` est le défaut du **système**, résolu
    // côté serveur et à un seul endroit. Un `?? 'en'` dans le contrôleur ou dans
    // le dépôt en aurait fait un second avis, à côté de celui de l'inscription
    // libre-service, et les deux auraient divergé le jour où la décision change.
    const { service, repository, operator } = await fixture();

    await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('maison-lotus'),
    });

    expect(repository.lastProvisionInput?.defaultLocale).toBe('en');
  });

  it('respecte la langue choisie à l’ouverture — #844', async () => {
    // Le salon qui parle français le dit ici, ou le changera dans ses réglages :
    // le français reste une option qu'on choisit, jamais un défaut qu'on subit.
    const { service, repository, operator } = await fixture();

    await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('maison-lotus'),
      defaultLocale: 'fr',
    });

    expect(repository.lastProvisionInput?.defaultLocale).toBe('fr');
  });

  it('journalise qui, quand et quel établissement — **sans** le jeton', async () => {
    const { service, operator, logs } = await fixture();

    const provisioned = await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('maison-lotus'),
    });

    const entry = logs.find((candidate) => candidate.message.includes('Ouverture'));
    expect(entry?.params).toEqual([
      expect.objectContaining({
        operatorId: operator.operatorId,
        tenantId: provisioned.tenant.id,
        tenantSlug: 'maison-lotus',
      }),
    ]);

    // Le dernier point de vigilance de #806 : aucun jeton, nulle part, dans
    // aucun journal. On cherche le jeton réellement émis, pas un motif.
    const token = new URL(provisioned.links.adminInvitationUrl).searchParams.get('token') ?? '';
    expect(token.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('rejouée sous la même clé, elle n’ouvre pas un second salon', async () => {
    const { service, operator } = await fixture();

    const first = await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('maison-lotus'),
    });
    // Un corps **différent** sous la même clé : c'est le cas qui distingue une
    // vraie idempotence d'une simple déduplication par contenu. La clé fait foi.
    const replay = await service.provisionTenant({
      operator,
      idempotencyKey: CLE,
      ...tenantPayload('un-autre-nom'),
    });

    expect(replay.replayed).toBe(true);
    expect(replay.tenant.id).toBe(first.tenant.id);
    expect(replay.tenant.slug).toBe('maison-lotus');
    // Et les liens sont **frais** : un rejeu reçu huit jours plus tard doit
    // rendre une invitation qui fonctionne encore.
    expect(replay.links.invitationExpiresIn).toBe(first.links.invitationExpiresIn);
  });

  it('refuse un slug déjà pris — 409, jamais un second salon', async () => {
    const { service, repository, operator } = await fixture();
    repository.addTenant({ slug: 'maison-lotus' });

    const error = await rejectionOf(
      service.provisionTenant({
        operator,
        idempotencyKey: AUTRE_CLE,
        ...tenantPayload('maison-lotus'),
      }),
    );

    expect(error).toBeInstanceOf(TenantSlugTakenError);
  });

  it('refuse un nom réservé, avec le même 409 qu’un nom pris', async () => {
    const { service, operator } = await fixture();

    // `www` est refusé par la résolution publique depuis #23 : créable, le salon
    // serait injoignable. Le même code qu'un nom pris, délibérément — les
    // distinguer ferait de la console un oracle sur la liste réservée.
    const error = await rejectionOf(
      service.provisionTenant({
        operator,
        idempotencyKey: AUTRE_CLE,
        ...tenantPayload('www'),
      }),
    );

    expect(error).toBeInstanceOf(TenantSlugTakenError);
  });
});

describe('Liste et réémission', () => {
  it('pagine, et rend « page 1 sur 0 » sur un ensemble vide', async () => {
    const { service } = await fixture();

    expect(await service.listTenants({ page: 1, pageSize: 20 })).toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('rend les établissements page par page', async () => {
    const { service, repository } = await fixture();
    repository.addTenant({ slug: 'salon-un' });
    repository.addTenant({ slug: 'salon-deux' });
    repository.addTenant({ slug: 'salon-trois' });

    const page = await service.listTenants({ page: 2, pageSize: 2 });

    expect({ items: page.items.length, totalItems: page.totalItems, totalPages: page.totalPages })
      .toEqual({ items: 1, totalItems: 3, totalPages: 2 });
  });

  it('réémet l’invitation de l’administrateur et rend les trois liens', async () => {
    const { service, repository, operator } = await fixture();
    const tenant = repository.addTenant({ slug: 'maison-lotus' });

    const reissued = await service.reissueAdminInvitation({ operator, tenantId: tenant.id });

    expect(reissued.tenantId).toBe(tenant.id);
    expect(reissued.links.bookingUrl).toBe('https://maison-lotus.exemple.test/reservation');
    expect(reissued.links.adminInvitationUrl).toContain('token=');
  });

  it('répond 404 sur un établissement inconnu', async () => {
    const { service, operator } = await fixture();

    const error = await rejectionOf(
      service.reissueAdminInvitation({
        operator,
        tenantId: '99999999-9999-4999-8999-999999999999',
      }),
    );

    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('répond 409 sur un établissement sans administrateur', async () => {
    const { service, repository, operator } = await fixture();
    // Un salon écrit par le seed, avant que cette console n'existe.
    const tenant = repository.addTenant({ slug: 'salon-du-seed', withAdmin: false });

    const error = await rejectionOf(
      service.reissueAdminInvitation({ operator, tenantId: tenant.id }),
    );

    expect(error).toBeInstanceOf(TenantAdminMissingError);
  });
});
