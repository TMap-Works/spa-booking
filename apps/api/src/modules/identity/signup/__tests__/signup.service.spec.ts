import type { StructuredLogger } from '../../../../common/logging/structured-logger';
import type { AuthService } from '../../auth.service';
import type { AuthenticationResult } from '../../identity.types';
import type { PasswordHasher } from '../../password.hasher';
import type { SelfServiceTenantInput, SignupRepository } from '../signup.repository';
import { SignupService } from '../signup.service';

/**
 * L'inscription libre-service d'un salon — la **langue d'ouverture** (#844).
 *
 * Cette suite ne rejoue pas l'ADR 0016 : elle tient une seule propriété, celle
 * du troisième critère d'acceptation de #844, et c'est la seule que la porte
 * libre-service peut tenir seule — le défaut de langue est résolu **ici**, côté
 * serveur, et nulle part ailleurs.
 *
 * Pourquoi cela mérite un test plutôt qu'une relecture : le même défaut est posé
 * par `PlatformService.provisionTenant`, pour l'autre porte d'ouverture d'un
 * établissement. Deux littéraux `'en'` dispersés n'auraient pas bougé ensemble
 * le jour où la décision du PO change — et le jour où l'un des deux oublierait
 * le `??`, la colonne recevrait `undefined` plutôt que son défaut.
 */

const PAYLOAD = {
  slug: 'maison-lotus',
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
  password: 'correct-horse-battery',
  dataConsent: true,
} as const;

interface Fixture {
  service: SignupService;
  /** La charge d'écriture telle que le service l'a composée. */
  written: () => SelfServiceTenantInput | null;
}

function fixture(): Fixture {
  let written: SelfServiceTenantInput | null = null;

  const repository = {
    createSelfServiceTenant: async (input: SelfServiceTenantInput) => {
      written = input;
      return { tenantId: 'tenant-cree', adminUserId: 'admin-cree' };
    },
  } as unknown as SignupRepository;

  const passwords = { hash: async () => 'empreinte' } as unknown as PasswordHasher;

  const auth = {
    openSessionForNewTenant: async (): Promise<AuthenticationResult> =>
      ({}) as AuthenticationResult,
  } as unknown as AuthService;

  const logger = { log: (): void => undefined } as unknown as StructuredLogger;

  return {
    service: new SignupService(repository, passwords, auth, logger),
    written: () => written,
  };
}

describe('SignupService — langue d’ouverture du salon (#844)', () => {
  it('ouvre en anglais le salon qui ne se prononce pas', async () => {
    // `en` est le défaut du **système**, décision du PO du 2026-09-19 : la
    // clientèle du produit est nord-américaine. Le formulaire d'inscription n'a
    // donc pas à poser la question à l'étape qu'on veut la plus courte.
    const f = fixture();

    await f.service.signup({ ...PAYLOAD });

    expect(f.written()?.defaultLocale).toBe('en');
  });

  it('respecte la langue choisie par le salon', async () => {
    // Le français reste une option que l'établissement choisit, jamais un défaut
    // qu'il subit — ici, ou plus tard dans ses réglages.
    const f = fixture();

    await f.service.signup({ ...PAYLOAD, defaultLocale: 'fr' });

    expect(f.written()?.defaultLocale).toBe('fr');
  });

  it('n’écrit jamais `undefined` dans la colonne', async () => {
    // La colonne est `NOT NULL` : un `??` oublié ferait descendre `undefined`
    // jusqu'à Prisma, qui l'omettrait du `INSERT` — la ligne recevrait alors le
    // `DEFAULT` de la base, et les deux sources de vérité auraient commencé à
    // diverger sans que rien ne le dise.
    const f = fixture();

    await f.service.signup({ ...PAYLOAD, defaultLocale: undefined });

    expect(f.written()).toHaveProperty('defaultLocale');
    expect(f.written()?.defaultLocale).toBeDefined();
  });
});
