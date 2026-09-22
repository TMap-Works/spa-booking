import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SignupForm } from '@/app/inscription/components/signup-form';
import { TenantCreateForm } from '@/app/plateforme/components/tenant-create-form';

/**
 * Le pays règle le fuseau, dans les deux portes d'ouverture d'un salon (#1103).
 *
 * Les deux formulaires — l'inscription en libre-service (ADR 0016) et la console
 * de l'éditeur (ADR 0012) — partagent `lib/salon-presets` et doivent se
 * comporter de la même façon. Un salon ouvert dans le mauvais fuseau affiche
 * tous ses créneaux décalés (CLAUDE.md, « sévérité haute ») : c'est ce
 * comportement-là qui est éprouvé, et non le transport.
 */

const signupSalonAction = vi.fn();
const provisionTenantAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/inscription/actions', () => ({
  signupSalonAction: (...args: unknown[]) => signupSalonAction(...args),
}));

vi.mock('@/app/plateforme/actions', () => ({
  provisionTenantAction: (...args: unknown[]) => provisionTenantAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(() => {
  // La console tire une clé d'idempotence au montage. jsdom n'expose pas
  // toujours `crypto.randomUUID` — on la pose plutôt que d'en faire dépendre
  // le test, ce qui n'est pas son sujet.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...globalThis.crypto, randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    });
  }
});

afterEach(() => {
  cleanup();
  signupSalonAction.mockReset();
  provisionTenantAction.mockReset();
  refresh.mockReset();
});

const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

const CA_TIMEZONES = [
  'America/Toronto',
  'America/Halifax',
  'America/St_Johns',
  'America/Winnipeg',
  'America/Edmonton',
  'America/Vancouver',
];

/** Les deux formulaires, avec les libellés sous lesquels chacun rend ses champs. */
const FORMS = [
  {
    name: 'l’inscription en libre-service',
    render: () => {
      render(<SignupForm />);
    },
    currencyLabel: 'Devise de vos prix',
  },
  {
    name: 'la console de l’éditeur',
    render: () => {
      render(<TenantCreateForm />);
    },
    currencyLabel: 'Devise',
  },
] as const;

function selects(currencyLabel: string): {
  country: HTMLSelectElement;
  timezone: HTMLSelectElement;
  currency: HTMLSelectElement;
} {
  return {
    country: screen.getByLabelText('Pays') as HTMLSelectElement,
    timezone: screen.getByLabelText('Fuseau horaire') as HTMLSelectElement,
    currency: screen.getByLabelText(currencyLabel) as HTMLSelectElement,
  };
}

/** Ce que la liste déroulante propose, dans l'ordre où elle le propose. */
function optionValues(select: HTMLSelectElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);
}

describe.each(FORMS)('$name — le pays règle le fuseau', ({ render: renderForm, currencyLabel }) => {
  it('ouvre sur les États-Unis, en Eastern et en dollar américain', () => {
    renderForm();
    const { country, timezone, currency } = selects(currencyLabel);

    expect(country.value).toBe('US');
    expect(timezone.value).toBe('America/New_York');
    expect(currency.value).toBe('USD');
  });

  it('ne propose que les fuseaux des États-Unis tant que c’est le pays choisi', () => {
    renderForm();
    const { timezone } = selects(currencyLabel);

    expect(optionValues(timezone)).toEqual(US_TIMEZONES);
  });

  it('bascule sur les fuseaux du Canada et le dollar canadien quand on choisit le Canada', async () => {
    const user = userEvent.setup();
    renderForm();
    const { country, timezone, currency } = selects(currencyLabel);

    await user.selectOptions(country, 'CA');

    expect(optionValues(timezone)).toEqual(CA_TIMEZONES);
    expect(timezone.value).toBe('America/Toronto');
    expect(currency.value).toBe('CAD');
  });

  it('retombe sur un seul fuseau pour un pays qui n’en a qu’un', async () => {
    const user = userEvent.setup();
    renderForm();
    const { country, timezone, currency } = selects(currencyLabel);

    await user.selectOptions(country, 'FR');

    expect(optionValues(timezone)).toEqual(['Europe/Paris']);
    expect(timezone.value).toBe('Europe/Paris');
    expect(currency.value).toBe('EUR');
  });

  it('laisse choisir un autre fuseau du même pays', async () => {
    // « Présélectionne » et non « impose » : un salon de Denver ouvre sur
    // l'Eastern et doit pouvoir corriger sans changer de pays.
    const user = userEvent.setup();
    renderForm();
    const { country, timezone } = selects(currencyLabel);

    await user.selectOptions(timezone, 'America/Denver');

    expect(timezone.value).toBe('America/Denver');
    expect(country.value).toBe('US');
  });

  it('repose le fuseau du pays quand on revient aux États-Unis', async () => {
    const user = userEvent.setup();
    renderForm();
    const { country, timezone } = selects(currencyLabel);

    await user.selectOptions(country, 'CA');
    await user.selectOptions(country, 'US');

    expect(optionValues(timezone)).toEqual(US_TIMEZONES);
    expect(timezone.value).toBe('America/New_York');
  });

  it('n’affiche jamais un fuseau que le formulaire ne porte pas', async () => {
    // Le piège du `<select>` : si la valeur du formulaire ne figure pas parmi
    // les options, le navigateur affiche la première et le salon s'ouvre dans
    // un fuseau que personne n'a choisi.
    const user = userEvent.setup();
    renderForm();
    const { country, timezone } = selects(currencyLabel);

    for (const code of ['CA', 'FR', 'MG', 'US']) {
      await user.selectOptions(country, code);
      expect(optionValues(timezone), code).toContain(timezone.value);
    }
  });
});
