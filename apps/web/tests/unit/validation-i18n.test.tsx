import { PASSWORD_MIN_LENGTH, validationMessage, validationPhrases } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Les refus de saisie du **contrat partagé**, rendus en anglais — #1232.
 *
 * ## Ce que cette suite protège, et qu'aucune autre ne protégeait
 *
 * Les schémas de `packages/shared` portaient une cinquantaine de phrases
 * françaises écrites en dur. Un message posé sur un check l'emporte sur toute
 * carte d'erreurs, par conception de zod : ces phrases-là s'affichaient telles
 * quelles sous les écrans anglais, et `zodErrorMap(locale)` n'y pouvait rien.
 *
 * Les écrans s'en tiraient chacun à sa façon — un catalogue de formulaire ici,
 * un branchement sur le code de l'`issue` là —, et ces contournements ne
 * couvraient que les champs qu'un ticket avait regardés. Le ticket referme
 * l'écart à la source : les schémas portent une clé, la carte la traduit.
 *
 * Ce qui se vérifie ici est donc le **dernier maillon**, celui que les suites de
 * `packages/shared` ne peuvent pas tenir : qu'un formulaire monté dans un écran
 * anglais passe bien la carte, et que la phrase du contrat arrive en anglais
 * sous le champ. Un formulaire de l'espace client, un formulaire du back-office
 * — c'est le quatrième critère d'acceptation, mot pour mot.
 *
 * ## Pourquoi une amorce de langue propre à ce fichier
 *
 * `tests/support/next-intl.ts` fixe toutes les suites en français. Rendre un
 * écran en anglais demande de la remplacer, et les deux doublures ci-dessous
 * lisent le **vrai** catalogue anglais — même conduite que
 * `admin-catalog-i18n.test.tsx`, dont elles reprennent la forme.
 */

/** Le traducteur anglais, fabriqué une fois par namespace — comme l'amorce. */
async function englishTranslator(namespace?: string): Promise<unknown> {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');
  const messages = loadMessages('en');
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;

  return translator(
    namespace === undefined ? { locale: 'en', messages } : { locale: 'en', messages, namespace },
  );
}

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');
  const messages = loadMessages('en');
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) => {
      const key = namespace ?? '';
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const made = translator(
        namespace === undefined
          ? { locale: 'en', messages }
          : { locale: 'en', messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en'),
  getTranslations: (options?: string | { readonly namespace?: string }) =>
    englishTranslator(typeof options === 'string' ? options : options?.namespace),
}));

const registerAction = vi.fn();
const createStaffMemberAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  createStaffMemberAction: (...args: unknown[]) => createStaffMemberAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { RegisterForm } = await import(
  '@/app/(account)/[tenantSlug]/compte/components/register-form'
);
const { StaffMemberForm } = await import(
  '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-member-form'
);
const { PhoneCountryProvider } = await import('@/components/ui/phone-country');

afterEach(() => {
  cleanup();
  registerAction.mockReset();
  createStaffMemberAction.mockReset();
  refresh.mockReset();
});

/** Les phrases anglaises attendues, lues du contrat plutôt que recopiées. */
const REQUIRED = validationPhrases('en').required;
const TOO_SHORT = validationPhrases('en').tooShort(PASSWORD_MIN_LENGTH);
const INVALID_EMAIL = validationMessage('identifier.email', 'en');

describe('espace client — inscription rendue en anglais', () => {
  it('dit en anglais les refus que le contrat écrit lui-même', async () => {
    const user = userEvent.setup();

    render(
      <PhoneCountryProvider country="FR">
        <RegisterForm tenantSlug="salon-des-lilas" />
      </PhoneCountryProvider>,
    );

    await user.type(screen.getByLabelText(/First name/), 'Zoé');
    await user.type(screen.getByLabelText(/Email address/), 'zoe-pas-un-email');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Create my account/ }));

    // Le champ obligatoire, l'adresse e-mail et la longueur du mot de passe :
    // trois refus, trois sources différentes du contrat, tous en anglais.
    expect(await screen.findByText(REQUIRED)).toBeDefined();
    expect(screen.getByText(INVALID_EMAIL)).toBeDefined();
    expect(screen.getByText(TOO_SHORT)).toBeDefined();
    expect(registerAction).not.toHaveBeenCalled();
  });

  it('ne laisse remonter aucune phrase française du contrat', async () => {
    const user = userEvent.setup();

    render(
      <PhoneCountryProvider country="FR">
        <RegisterForm tenantSlug="salon-des-lilas" />
      </PhoneCountryProvider>,
    );

    await user.click(screen.getByRole('button', { name: /Create my account/ }));
    // Quatre champs vides, donc quatre fois la même phrase : c'est leur langue
    // qui est mesurée ici, pas leur nombre.
    await screen.findAllByText(REQUIRED);

    // Les trois phrases que cet écran affichait en français avant #1232.
    expect(screen.queryByText(/ce champ est obligatoire/)).toBeNull();
    expect(screen.queryByText(/adresse e-mail invalide/)).toBeNull();
    expect(screen.queryByText(/le mot de passe fait au moins/)).toBeNull();
    // Ni le libellé brut de zod, que #613 avait chassé de ces écrans.
    expect(screen.queryByText(/String must contain/)).toBeNull();
  });
});

describe('back-office — fiche praticien rendue en anglais', () => {
  it('pose sous son champ la borne du contrat, en anglais', async () => {
    const user = userEvent.setup();

    render(
      <StaffMemberForm
        accounts={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'lea@salon-des-lilas.test',
            role: 'staff',
            firstName: 'Léa',
            lastName: 'Praticienne',
            phone: null,
            locale: null,
          },
        ]}
        tenantSlug="salon-des-lilas"
      />,
    );

    // Un compte choisi, un nom d'affichage effacé : le seul refus qui reste est
    // celui de `displayNameSchema`, que le contrat ne nomme plus lui-même.
    await user.selectOptions(
      screen.getByLabelText(/Account to make bookable/),
      '11111111-1111-4111-8111-111111111111',
    );
    await user.clear(screen.getByLabelText(/Display name/));
    await user.click(screen.getByRole('button', { name: /Create the record/ }));

    expect(await screen.findByText(REQUIRED)).toBeDefined();
    expect(screen.queryByText(/ce champ est obligatoire/)).toBeNull();
    expect(createStaffMemberAction).not.toHaveBeenCalled();
  });
});
