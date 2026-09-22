import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchema } from '@spa/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PhoneCountryProvider } from '@/components/ui/phone-country';
import { PhoneField } from '@/components/ui/phone-field';
import { formatPhoneForDisplay, phoneInvalidMessage, toPhoneInputValue } from '@/lib/phone';

/**
 * Le champ téléphone international (#825).
 *
 * Ce qui se vérifie ici, ce sont les trois tests que le ticket exige : une
 * saisie nationale française part en E.164, un changement de pays revalide le
 * numéro, et le sélecteur tient au clavier. Le rendu à 360 px est vérifié sur
 * la feuille de style (`tests/phone-field-layout.test.mjs`) : jsdom ne met rien
 * en page.
 */

afterEach(() => {
  cleanup();
});

function Controlled({
  initial = '',
  onValue,
  defaultCountry,
}: {
  readonly initial?: string;
  readonly onValue?: (value: string) => void;
  readonly defaultCountry?: string | null;
}) {
  const [value, setValue] = useState(initial);

  return (
    <PhoneField
      id="phone"
      label="Téléphone"
      value={value}
      defaultCountry={defaultCountry}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

/** Un formulaire comme ceux du produit : `react-hook-form`, le schéma du contrat. */
function ProfileLike({ onSubmit }: { readonly onSubmit: (phone: string) => void }) {
  const { control, handleSubmit } = useForm<{ phone: string }, unknown, { phone: string }>({
    resolver: zodResolver(z.object({ phone: z.union([z.literal(''), e164PhoneSchema]) })),
    defaultValues: { phone: '' },
    mode: 'onTouched',
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void handleSubmit((values) => {
          onSubmit(values.phone);
        })(event);
      }}
    >
      <Controller
        control={control}
        name="phone"
        render={({ field, fieldState }) => (
          <PhoneField
            id="profile-phone"
            label="Téléphone"
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            invalid={fieldState.invalid}
            ref={field.ref}
          />
        )}
      />
      <button type="submit">Enregistrer</button>
    </form>
  );
}

describe('la saisie', () => {
  it('rend en E.164 un numéro français tapé au format national', async () => {
    const onValue = vi.fn();
    render(<Controlled defaultCountry="FR" onValue={onValue} />);

    await userEvent.type(screen.getByLabelText('Téléphone'), '06 12 34 56 78');

    expect(onValue).toHaveBeenLastCalledWith('+33612345678');
    // Le numéro reste écrit comme on le tape, derrière le drapeau.
    expect(screen.getByLabelText('Téléphone')).toHaveProperty('value', '06 12 34 56 78');
  });

  it('bascule sur le pays de l’indicatif quand on tape un « + »', async () => {
    const onValue = vi.fn();
    render(<Controlled defaultCountry="FR" onValue={onValue} />);

    await userEvent.type(screen.getByLabelText('Téléphone'), '+261 34 12 345 67');

    expect(onValue).toHaveBeenLastCalledWith('+261341234567');
    expect(screen.getByRole('button', { name: /madagascar \(\+261\)/i })).toBeTruthy();
  });

  it('part du pays de l’établissement, et des États-Unis à défaut', () => {
    render(
      <PhoneCountryProvider country="CA">
        <Controlled />
      </PhoneCountryProvider>,
    );
    expect(screen.getByRole('button', { name: /canada \(\+1\)/i })).toBeTruthy();
    cleanup();

    render(<Controlled defaultCountry={null} />);
    expect(screen.getByRole('button', { name: /états-unis \(\+1\)/i })).toBeTruthy();
  });

  it('relit un numéro enregistré au format national du pays qui le porte', () => {
    render(<Controlled defaultCountry="FR" initial="+261341234567" />);

    expect(screen.getByLabelText('Téléphone')).toHaveProperty('value', '034 12 345 67');
    expect(screen.getByRole('button', { name: /madagascar/i })).toBeTruthy();
  });

  it('donne un exemple du pays choisi, jamais d’un autre', () => {
    render(<Controlled defaultCountry="FR" />);

    expect(screen.getByLabelText('Téléphone').getAttribute('placeholder')).toMatch(/^06/);
  });
});

describe('le choix du pays', () => {
  it('cherche un pays par son nom, sans accent, et le choisit au clavier', async () => {
    const onValue = vi.fn();
    render(<Controlled defaultCountry="FR" onValue={onValue} />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    const search = screen.getByRole('combobox', { name: 'Rechercher un pays' });
    expect(document.activeElement).toBe(search);

    await userEvent.type(search, 'etats');
    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('États-Unis');

    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: /états-unis \(\+1\)/i })).toBeTruthy();
    // Le focus rejoint le numéro, là où l'on va taper.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Téléphone'));
    });
  });

  it('trouve un pays par son indicatif et par son nom anglais', async () => {
    render(<Controlled defaultCountry="FR" />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    const search = screen.getByRole('combobox', { name: 'Rechercher un pays' });

    await userEvent.type(search, '+261');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('Madagascar'),
    ]);

    await userEvent.clear(search);
    await userEvent.type(search, 'germany');
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('Allemagne');
  });

  it('classe d’abord les noms de la langue de l’écran, le nom anglais ensuite', async () => {
    render(<Controlled defaultCountry="FR" />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    await userEvent.type(screen.getByRole('combobox'), 'ca');
    const names = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    const rank = (name: string): number => names.findIndex((entry) => entry.includes(name));

    // « Canada » commence par « ca » en français ; « Pays-Bas caribéens » ne
    // le fait qu'en anglais (*Caribbean Netherlands*).
    expect(rank('Canada')).toBeLessThan(rank('Pays-Bas caribéens'));
    expect(rank('Pays-Bas caribéens')).toBeLessThan(rank('Afrique du Sud'));
  });

  it('met le pays de l’établissement en tête, une seule fois', async () => {
    render(<Controlled defaultCountry="FR" />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    const names = screen.getAllByRole('option').map((option) => option.textContent ?? '');

    expect(names[0]).toContain('France');
    expect(names.filter((name) => name.includes('France'))).toHaveLength(1);
    expect(names.length).toBeGreaterThan(200);
  });

  it('dit quand aucun pays ne correspond', async () => {
    render(<Controlled defaultCountry="FR" />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    await userEvent.type(screen.getByRole('combobox'), 'zzzz');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Aucun pays ne correspond à « zzzz ».')).toBeTruthy();
  });

  it('ne soumet pas le formulaire quand on valide la recherche par Entrée', async () => {
    const onSubmit = vi.fn();
    render(<ProfileLike onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    await userEvent.type(screen.getByRole('combobox'), 'belg{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /belgique \(\+32\)/i })).toBeTruthy();
  });
});

describe('la validation', () => {
  it('envoie l’E.164 d’un numéro valide', async () => {
    const onSubmit = vi.fn();
    render(
      <PhoneCountryProvider country="FR">
        <ProfileLike onSubmit={onSubmit} />
      </PhoneCountryProvider>,
    );

    await userEvent.type(screen.getByLabelText('Téléphone'), '0612345678');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(onSubmit).toHaveBeenCalledWith('+33612345678');
  });

  it('revalide le numéro quand on change de pays', async () => {
    const onSubmit = vi.fn();
    render(
      <PhoneCountryProvider country="FR">
        <ProfileLike onSubmit={onSubmit} />
      </PhoneCountryProvider>,
    );

    await userEvent.type(screen.getByLabelText('Téléphone'), '0612345678');
    await userEvent.tab();
    expect(screen.queryByRole('alert')).toBeNull();

    // Les mêmes chiffres, lus avec le plan de numérotation belge : trop longs.
    await userEvent.click(screen.getByRole('button', { name: /pays de l’indicatif/i }));
    await userEvent.type(screen.getByRole('combobox'), 'belgique{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/pour ce pays \(Belgique, \+32\)/);
    expect(screen.getByLabelText('Téléphone').getAttribute('aria-invalid')).toBe('true');
  });

  it('dit qu’un numéro est incomplet plutôt qu’invalide', async () => {
    render(
      <PhoneCountryProvider country="FR">
        <ProfileLike onSubmit={vi.fn()} />
      </PhoneCountryProvider>,
    );

    await userEvent.type(screen.getByLabelText('Téléphone'), '06 12');
    await userEvent.tab();

    expect(screen.getByRole('alert').textContent).toBe(
      'Ce numéro est incomplet pour ce pays (France, +33).',
    );
  });
});

describe('les drapeaux', () => {
  it('sont embarqués — aucune image n’est demandée à un domaine tiers', async () => {
    const { container } = render(<Controlled defaultCountry="FR" />);

    await act(async () => {
      await import('react-phone-number-input/flags');
    });
    await waitFor(() => {
      expect(container.querySelector('.spa-phone__flag svg')).not.toBeNull();
    });
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('l’affichage et la reprise', () => {
  it('écrit un numéro enregistré au format international lisible', () => {
    expect(formatPhoneForDisplay('+33612345678')).toBe('+33 6 12 34 56 78');
    expect(formatPhoneForDisplay('+14155552671')).toBe('+1 415 555 2671');
    // Ce qui ne s'analyse pas reste tel quel plutôt que de disparaître.
    expect(formatPhoneForDisplay('poste 12')).toBe('poste 12');
  });

  it('complète un brouillon national écrit avant le champ international', () => {
    expect(toPhoneInputValue('06 12 34 56 78', 'FR')).toBe('+33612345678');
    expect(toPhoneInputValue('+33612345678', 'FR')).toBe('+33612345678');
    expect(toPhoneInputValue('n’importe quoi', 'FR')).toBeUndefined();
    expect(toPhoneInputValue('', 'FR')).toBeUndefined();
  });

  it('parle anglais quand l’écran est en anglais', () => {
    expect(phoneInvalidMessage('+1415555', 'US', 'en')).toBe(
      'This number is too short for United States (+1).',
    );
  });
});
