import { ERROR_CODES, validationMessage, type PlatformTenant } from '@spa/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { nextIntlFixe } from '../support/langue-figee';

/**
 * La console de l'éditeur en français et en anglais — #1106.
 *
 * ## Ce que cette suite protège
 *
 * - **La coquille** porte le sélecteur de langue de #845 et nomme ses sections
 *   dans la langue de la session.
 * - **Le formulaire d'ouverture** propose la langue du salon avec `en`
 *   présélectionné — le défaut du système (#844), et non la langue de
 *   l'opérateur —, la transmet à la création, et nomme ses pays par
 *   `Intl.DisplayNames` plutôt que par les libellés français des préréglages.
 * - **Aucun message de refus ne reste en français** sur un écran anglais : ni
 *   celui du contrat partagé, ni celui que l'API renvoie. Les écrans réagissent
 *   sur le **code** et écrivent leur propre phrase.
 * - **La liste** écrit ses en-têtes, ses pastilles et ses dates dans la langue.
 *
 * Le rendu en anglais demande de remplacer l'amorce de langue des suites, qui les
 * fixe toutes en français (`tests/support/next-intl.ts`) : la doublure ci-dessous
 * lit le **vrai** catalogue anglais. Elle vient de
 * `tests/support/langue-figee.ts` (#1287), où elle est écrite une fois pour
 * toutes les suites anglaises.
 */

vi.mock('next-intl', () => nextIntlFixe('en'));

const platformLoginAction = vi.fn();
const platformVerifyCodeAction = vi.fn();
const platformLogoutAction = vi.fn();
const provisionTenantAction = vi.fn();
const reissueTenantInvitationAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

vi.mock('@/app/plateforme/actions', () => ({
  platformLoginAction: (...args: unknown[]) => platformLoginAction(...args),
  platformVerifyCodeAction: (...args: unknown[]) => platformVerifyCodeAction(...args),
  platformLogoutAction: (...args: unknown[]) => platformLogoutAction(...args),
  provisionTenantAction: (...args: unknown[]) => provisionTenantAction(...args),
  reissueTenantInvitationAction: (...args: unknown[]) => reissueTenantInvitationAction(...args),
  addTenantNoteAction: vi.fn(),
  updateTenantStatusAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/plateforme/salons',
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
}));

import { PlatformLoginForm } from '@/app/plateforme/components/platform-login-form';
import { PlatformRail } from '@/app/plateforme/components/platform-rail';
import { TenantCreateForm } from '@/app/plateforme/components/tenant-create-form';
import { TenantTable } from '@/app/plateforme/components/tenant-table';

beforeAll(() => {
  // La console tire une clé d'idempotence au montage. jsdom n'expose pas
  // toujours `crypto.randomUUID` — on la pose plutôt que d'en faire dépendre le
  // test, ce qui n'est pas son sujet.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...globalThis.crypto, randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    });
  }
});

afterEach(() => {
  cleanup();
  platformLoginAction.mockReset();
  platformVerifyCodeAction.mockReset();
  platformLogoutAction.mockReset();
  provisionTenantAction.mockReset();
  reissueTenantInvitationAction.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

const TENANT: PlatformTenant = {
  id: '7e586141-9ccf-4caa-802d-72c4d5e7aa2c',
  slug: 'maison-lotus',
  name: 'Maison Lotus',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  isActive: false,
  billingStatus: 'past_due',
  trialEndsAt: null,
  createdAt: '2026-09-06T10:00:00.000Z',
  origin: 'signup',
};

describe('la coquille de la console, en anglais', () => {
  it('nomme ses sections dans la langue et porte le sélecteur de langue de #845', () => {
    render(<PlatformRail operatorName="Hasina R." />);

    expect(screen.getByRole('navigation', { name: 'Console sections' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/plateforme');
    expect(screen.getByRole('link', { name: 'Salons' }).getAttribute('href')).toBe(
      '/plateforme/salons',
    );
    expect(screen.getByRole('link', { name: 'Open a salon' })).toBeDefined();
    expect(screen.getByText('30-minute session')).toBeDefined();
    expect(screen.getByText('Operator')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();

    // Le sélecteur de #845, consommé tel quel : un bouton par langue, chacune
    // nommée dans la sienne.
    const switcher = screen.getByRole('form', { name: 'Language' });
    expect(within(switcher).getByRole('button', { name: 'English' })).toBeDefined();
    expect(within(switcher).getByRole('button', { name: 'Français' })).toBeDefined();
  });
});

describe('la connexion de la console, en anglais', () => {
  /** Le premier temps, passé : l'écran du code est affiché. */
  async function passerLeMotDePasse(
    user: ReturnType<typeof userEvent.setup>,
    enrollment: { otpauthUri: string; secret: string } | null = null,
  ): Promise<void> {
    platformLoginAction.mockResolvedValue({ ok: true, data: { enrollment } });
    await user.type(screen.getByLabelText('Email address*'), 'ops@spa.test');
    await user.type(screen.getByLabelText('Password*'), 'mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Verification code*')).toBeDefined();
    });
  }

  it('ne demande que l’adresse et le mot de passe au premier temps (#1442)', () => {
    render(<PlatformLoginForm expired={false} />);

    expect(screen.getByRole('heading', { name: 'Platform console — sign in' })).toBeDefined();
    expect(screen.getByLabelText('Email address*')).toBeDefined();
    expect(screen.getByLabelText('Password*')).toBeDefined();
    expect(screen.queryByLabelText('Verification code*')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined();
  });

  it('dit une session expirée dans la langue', () => {
    render(<PlatformLoginForm expired />);

    expect(screen.getByText('Your session has expired')).toBeDefined();
  });

  it('refuse le mot de passe dans la langue, sans recopier le message du serveur', async () => {
    const user = userEvent.setup();
    platformLoginAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INVALID_PLATFORM_CREDENTIALS,
      // Ce que l'API renvoie : du français, écrit côté serveur.
      message: 'Identifiants refusés.',
    });

    render(<PlatformLoginForm expired={false} />);

    await user.type(screen.getByLabelText('Email address*'), 'ops@spa.test');
    await user.type(screen.getByLabelText('Password*'), 'mot-de-passe-long');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByText('Sign-in refused')).toBeDefined();
    });
    expect(screen.getByText('Incorrect email address or password.')).toBeDefined();
    expect(screen.queryByText(/Identifiants refusés/)).toBeNull();
    // On reste au premier temps : aucun code n'est demandé sur un refus.
    expect(screen.queryByLabelText('Verification code*')).toBeNull();
  });

  it('passe au code sur un écran dédié, en rappelant le compte', async () => {
    const user = userEvent.setup();
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);

    expect(screen.getByRole('heading', { name: 'Two-step verification' })).toBeDefined();
    expect(
      screen.getByText('Enter the six-digit code shown by your authenticator app for ops@spa.test.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Password*')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Verification code*'));
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(platformLoginAction).toHaveBeenCalledWith({ email: 'ops@spa.test', password: 'mot-de-passe-long' });
  });

  it('montre le QR code et la clé à la première connexion', async () => {
    const user = userEvent.setup();
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user, {
      otpauthUri: 'otpauth://totp/Spa%20Booking:ops%40spa.test?secret=ABCDEFGHABCDEFGH&issuer=Spa+Booking',
      secret: 'ABCDEFGHABCDEFGH',
    });

    expect(screen.getByRole('heading', { name: 'Set up your authenticator app' })).toBeDefined();
    const qr = screen.getByRole('img', { name: 'QR code to scan with your authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    // La clé, groupée par quatre pour qui ne peut pas scanner.
    expect(screen.getByText('ABCD EFGH ABCD EFGH')).toBeDefined();
  });

  it('ouvre la console sur le bon code', async () => {
    const user = userEvent.setup();
    platformVerifyCodeAction.mockResolvedValue({ ok: true, data: { id: 'x' } });
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);
    await user.type(screen.getByLabelText('Verification code*'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(platformVerifyCodeAction).toHaveBeenCalledWith({ totpCode: '123456' });
  });

  it('refuse un code faux sans renvoyer au mot de passe, et vide le champ', async () => {
    const user = userEvent.setup();
    platformVerifyCodeAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INVALID_PLATFORM_CREDENTIALS,
      message: 'Identifiants refusés.',
    });
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);
    await user.type(screen.getByLabelText('Verification code*'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Incorrect code')).toBeDefined();
    });
    expect(
      screen.getByText('The code was refused. If it has just expired, enter the next one.'),
    ).toBeDefined();
    expect((screen.getByLabelText('Verification code*') as HTMLInputElement).value).toBe('');
  });

  it('renvoie au mot de passe, adresse gardée, quand le défi a expiré', async () => {
    const user = userEvent.setup();
    platformVerifyCodeAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.UNAUTHORIZED,
      message: 'Session expirée.',
    });
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);
    await user.type(screen.getByLabelText('Verification code*'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Verification timed out')).toBeDefined();
    });
    expect((screen.getByLabelText('Email address*') as HTMLInputElement).value).toBe('ops@spa.test');
    expect((screen.getByLabelText('Password*') as HTMLInputElement).value).toBe('');
  });

  it('revient au premier temps, vide, sur « Use a different account »', async () => {
    const user = userEvent.setup();
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);
    // Le champ du code a le focus : le quitter vide ne doit rien refuser, sans
    // quoi le refus décale le bouton sous le pointeur (recette de #1442).
    await user.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(screen.queryByText(validationMessage('platform.totpCode', 'en'))).toBeNull();

    expect((screen.getByLabelText('Email address*') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Verification timed out')).toBeNull();
  });

  /**
   * La phrase est **lue au contrat**, et non recopiée ici — #1387.
   *
   * Elle l'était : le catalogue de cet écran portait sa propre copie, que le
   * littéral de ce cas citait. Les deux ont divergé sans que rien ne le signale.
   * Le contrat est la seule source depuis ce ticket — `platformTotpCodeSchema`
   * pose `messageKey('platform.totpCode')` sur son `refine` (#1442 l'a déplacé
   * au second temps), et `zodErrorMap(locale)` la traduit.
   */
  it('refuse un code TOTP mal formé sous le champ, dans la langue', async () => {
    const user = userEvent.setup();
    render(<PlatformLoginForm expired={false} />);

    await passerLeMotDePasse(user);
    await user.type(screen.getByLabelText('Verification code*'), '12');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText(validationMessage('platform.totpCode', 'en'))).toBeDefined();
    });
    expect(platformVerifyCodeAction).not.toHaveBeenCalled();
  });
});

describe('l’ouverture d’un salon, en anglais', () => {
  /** Remplit ce que le schéma exige, et rien de plus. */
  async function fill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText('Salon name*'), 'Maison Lotus');
    await user.type(screen.getByLabelText('Address*'), '12 rue des Lilas');
    await user.type(screen.getByLabelText('City*'), 'Boston');
    await user.type(screen.getByLabelText('First name*'), 'Hasina');
    await user.type(screen.getByLabelText('Last name*'), 'Rakoto');
    await user.type(screen.getByLabelText('Email address*'), 'hasina@lotus.test');
  }

  it('propose la langue du salon avec « en » présélectionné, nommée dans sa propre langue', () => {
    render(<TenantCreateForm />);

    const language = screen.getByLabelText('Salon language') as HTMLSelectElement;

    // `en` et non la langue de l'opérateur : ce sont deux questions distinctes.
    expect(language.value).toBe('en');
    expect(
      within(language)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Français', 'English']);
  });

  it('nomme ses pays par Intl.DisplayNames, dans la langue lue', () => {
    render(<TenantCreateForm />);

    const country = screen.getByLabelText('Country') as HTMLSelectElement;
    const labels = within(country)
      .getAllByRole('option')
      .map((option) => option.textContent);

    // Les libellés figés des préréglages sont français (« États-Unis ») : ce sont
    // ceux d'`Intl` qui s'affichent.
    expect(labels[0]).toBe('United States');
    expect(labels).toContain('France');
    expect(labels).toContain('Réunion');
    expect(labels).not.toContain('États-Unis');
  });

  it('transmet la langue du salon à la création', async () => {
    const user = userEvent.setup();
    provisionTenantAction.mockResolvedValue({
      ok: true,
      data: {
        tenant: { ...TENANT, isActive: true },
        admin: {
          id: '1e3a4a4b-0a4f-4a4f-8a4f-0a4f4a4f0a4f',
          email: 'hasina@lotus.test',
          firstName: 'Hasina',
          lastName: 'Rakoto',
        },
        links: {
          bookingUrl: 'https://spa.test/maison-lotus/reservation',
          adminInvitationUrl: 'https://spa.test/maison-lotus/admin/invitation?token=x',
          adminLoginUrl: 'https://spa.test/maison-lotus/admin/connexion',
          invitationExpiresIn: 604_800,
        },
        replayed: false,
      },
    });

    render(<TenantCreateForm />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Open the salon' }));

    await waitFor(() => {
      expect(provisionTenantAction).toHaveBeenCalledTimes(1);
    });
    expect(provisionTenantAction.mock.calls[0]?.[1]).toMatchObject({ defaultLocale: 'en' });

    // La suite de l'écran est traduite aussi : les trois liens à remettre.
    expect(screen.getByText('Maison Lotus is open')).toBeDefined();
    expect(screen.getByLabelText('1. Manager activation link')).toBeDefined();
    expect(screen.getByText(/Valid for 7 days, once only\./)).toBeDefined();
  });

  it('ouvre un salon francophone quand l’opérateur le choisit', async () => {
    const user = userEvent.setup();
    provisionTenantAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: 'Le service est momentanément injoignable.',
    });

    render(<TenantCreateForm />);
    await fill(user);
    await user.selectOptions(screen.getByLabelText('Salon language'), 'fr');
    await user.click(screen.getByRole('button', { name: 'Open the salon' }));

    await waitFor(() => {
      expect(provisionTenantAction).toHaveBeenCalledTimes(1);
    });
    expect(provisionTenantAction.mock.calls[0]?.[1]).toMatchObject({ defaultLocale: 'fr' });
  });

  it('refuse la création dans la langue, sans recopier le message du serveur', async () => {
    const user = userEvent.setup();
    provisionTenantAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: 'Le service est momentanément injoignable.',
    });

    render(<TenantCreateForm />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Open the salon' }));

    await waitFor(() => {
      expect(screen.getByText('The salon was not opened')).toBeDefined();
    });
    expect(
      screen.getByText('The service is briefly unreachable. Please try again in a moment.'),
    ).toBeDefined();
    expect(screen.queryByText(/momentanément injoignable/)).toBeNull();
  });

  it('pose une adresse déjà prise sur le champ qui la porte, dans la langue', async () => {
    const user = userEvent.setup();
    provisionTenantAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.TENANT_SLUG_TAKEN,
      message: 'ce nom est déjà pris',
    });

    render(<TenantCreateForm />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Open the salon' }));

    await waitFor(() => {
      expect(
        screen.getByText('This address is already taken or reserved — choose another one.'),
      ).toBeDefined();
    });
  });

  it('refuse un champ vide dans la langue, et non dans celle du contrat', async () => {
    const user = userEvent.setup();
    render(<TenantCreateForm />);

    await user.click(screen.getByRole('button', { name: 'Open the salon' }));

    await waitFor(() => {
      expect(screen.getByText('Enter the salon name.')).toBeDefined();
    });
    // Les messages du contrat partagé sont des littéraux français.
    expect(screen.queryByText('adresse requise')).toBeNull();
    expect(screen.queryByText('ville requise')).toBeNull();
    expect(screen.getByText('Enter the address.')).toBeDefined();
    expect(screen.getByText('Enter the city.')).toBeDefined();
    expect(provisionTenantAction).not.toHaveBeenCalled();
  });
});

describe('la liste des salons, en anglais', () => {
  it('écrit ses en-têtes, ses pastilles et ses dates dans la langue', () => {
    render(<TenantTable tenants={[TENANT]} />);

    for (const head of [
      'Salon',
      'Page address',
      'Time zone · currency',
      'Opened on',
      'Billing',
      'Status',
    ]) {
      expect(screen.getByRole('columnheader', { name: head })).toBeDefined();
    }

    expect(screen.getByText('Signed up online')).toBeDefined();
    expect(screen.getByText('Unpaid — follow up')).toBeDefined();
    expect(screen.getByText('Suspended')).toBeDefined();
    // La date suit la langue et reste dans le fuseau du salon.
    expect(screen.getByText('Sep 6, 2026')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Access links' })).toBeDefined();
  });

  it('dit un salon sans administrateur dans la langue, sans recopier le message du serveur', async () => {
    const user = userEvent.setup();
    reissueTenantInvitationAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.TENANT_ADMIN_MISSING,
      message: 'Ce salon n’a aucun compte administrateur à réinviter.',
    });

    render(<TenantTable tenants={[TENANT]} />);
    await user.click(screen.getByRole('button', { name: 'Access links' }));

    await waitFor(() => {
      expect(screen.getByText('Links unavailable')).toBeDefined();
    });
    expect(
      screen.getByText('This salon has no administrator account to re-invite.'),
    ).toBeDefined();
  });
});
