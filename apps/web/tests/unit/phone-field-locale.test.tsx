import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { PhoneCountryProvider } from '@/components/ui/phone-country';
import { PhoneField } from '@/components/ui/phone-field';
import { resolvePhoneLocale, type PhoneLocale } from '@/lib/phone';

/**
 * Le champ téléphone suit la langue de la session — #1267.
 *
 * ## Ce qui n'allait pas
 *
 * `PhoneField` porte ses textes dans les deux langues depuis #825, et
 * `lib/phone.ts` le refus du numéro. Mais la propriété `locale` retombait sur
 * `'fr'` — le repli transitoire de #845 —, et **un seul appelant sur sept** la
 * passait. Sur un écran anglais, les six autres annonçaient « Pays de
 * l'indicatif : France (+33) », cherchaient « Nom, code ou indicatif », listaient
 * « États-Unis » et refusaient le numéro en français.
 *
 * Le champ lit désormais `useLocale()` lui-même, comme toute brique du design
 * system ; la propriété ne sert plus qu'à forcer une langue.
 *
 * ## Pourquoi une langue mobile plutôt qu'un fournisseur
 *
 * L'amorce des suites fixe la langue à `fr` pour toutes
 * (`tests/support/next-intl.ts`) : elle remplace `useLocale` lui-même, si bien
 * qu'un `NextIntlClientProvider` posé autour du rendu ne changerait rien. C'est
 * l'objet de `tests/support/langue-mobile.ts`, que trois suites partagent déjà.
 *
 * Le **même** champ est rendu dans les deux langues, et non seulement en
 * anglais : une suite qui n'éprouverait que l'anglais resterait verte si le
 * repli se remettait à écraser la langue de la session — il suffirait qu'il
 * bascule sur `'en'`.
 */

vi.mock('next-intl', () => nextIntlMobile());

/** Le pays de l'établissement, pour que l'indicatif affiché soit prévisible. */
const PAYS = 'FR';

/**
 * Un numéro syntaxiquement E.164 mais **trop court** pour la France : c'est le
 * refus que l'audit cite (« Ce numéro est incomplet pour ce pays (…) »), et le
 * seul qui distingue les trois phrases de `phoneInvalidMessage`.
 */
const TROP_COURT = '+336123456';

/**
 * Les phrases que le champ prononçait en français sur un écran anglais — le
 * troisième critère d'acceptation : *« rendu sans prop `locale` sous un
 * fournisseur `en`, il n'affiche aucune phrase française »*.
 *
 * Les noms de pays y sont, et pas seulement les libellés du composant : ils
 * viennent d'`Intl.DisplayNames`, c'est-à-dire d'un autre chemin de code que
 * `TEXTS`, et c'est celui-là que le repli faisait taire en premier.
 */
const PHRASES_FRANCAISES = [
  'Pays de l’indicatif',
  'Rechercher un pays',
  'Nom, code ou indicatif',
  'Aucun pays ne correspond',
  'Ce numéro est incomplet',
  'Ce numéro ne semble pas valide',
  'États-Unis',
  'Allemagne',
  'Fermer',
];

function Champ({
  locale,
  label = 'Phone',
  value: initial = '',
  invalid = false,
}: {
  readonly locale?: PhoneLocale;
  readonly label?: string;
  readonly value?: string;
  readonly invalid?: boolean;
}) {
  const [value, setValue] = useState(initial);

  return (
    <PhoneCountryProvider country={PAYS}>
      <PhoneField
        id="phone"
        label={label}
        invalid={invalid}
        {...(locale === undefined ? {} : { locale })}
        value={value}
        onChange={setValue}
      />
    </PhoneCountryProvider>
  );
}

/** Le texte entier de la page, refus et panneau compris. */
function texteRendu(): string {
  return document.body.textContent ?? '';
}

afterEach(() => {
  fixerLangue('fr');
  cleanup();
});

describe('la langue de la session', () => {
  it('annonce l’indicatif en anglais sur un écran anglais, sans propriété', () => {
    fixerLangue('en');
    render(<Champ />);

    expect(screen.getByRole('button', { name: 'Country code: France (+33)' })).toBeTruthy();
  });

  it('l’annonce en français sur un écran français', () => {
    fixerLangue('fr');
    render(<Champ label="Téléphone" />);

    expect(screen.getByRole('button', { name: 'Pays de l’indicatif : France (+33)' })).toBeTruthy();
  });

  it('refuse le numéro dans la langue de la session', () => {
    fixerLangue('en');
    render(<Champ value={TROP_COURT} invalid />);

    expect(screen.getByRole('alert').textContent).toBe(
      'This number is too short for France (+33).',
    );

    cleanup();
    fixerLangue('fr');
    render(<Champ label="Téléphone" value={TROP_COURT} invalid />);

    expect(screen.getByRole('alert').textContent).toBe(
      'Ce numéro est incomplet pour ce pays (France, +33).',
    );
  });

  it('traduit la recherche de pays, ses noms et son absence de résultat', async () => {
    fixerLangue('en');
    render(<Champ />);

    await userEvent.click(screen.getByRole('button', { name: /country code/i }));

    const recherche = screen.getByRole('combobox', { name: 'Search for a country' });
    expect(recherche.getAttribute('placeholder')).toBe('Name, code or dialing code');

    await userEvent.type(recherche, 'germ');
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('Germany');

    await userEvent.clear(recherche);
    await userEvent.type(recherche, 'zzzz');
    expect(screen.getByText('No country matches “zzzz”.')).toBeTruthy();
  });

  it('n’affiche aucune phrase française, panneau de pays ouvert', async () => {
    fixerLangue('en');
    render(<Champ value={TROP_COURT} invalid />);

    await userEvent.click(screen.getByRole('button', { name: /country code/i }));
    // Le panneau ouvert, la liste montée : c'est là que le champ prononce le
    // plus de mots — deux cent quarante noms de pays, la recherche, le refus.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(200);

    const rendu = texteRendu();

    for (const phrase of PHRASES_FRANCAISES) {
      expect(rendu).not.toContain(phrase);
    }

    expect(rendu).toContain('United States');
  });
});

describe('la propriété locale', () => {
  it('force la langue du champ contre celle de la session', () => {
    fixerLangue('en');
    render(<Champ locale="fr" value={TROP_COURT} invalid />);

    expect(screen.getByRole('button', { name: 'Pays de l’indicatif : France (+33)' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Ce numéro est incomplet pour ce pays (France, +33).',
    );
  });
});

describe('resolvePhoneLocale', () => {
  it('garde les deux langues du contrat', () => {
    expect(resolvePhoneLocale('fr')).toBe('fr');
    expect(resolvePhoneLocale('en')).toBe('en');
  });

  it('retombe sur l’anglais — jamais sur le français — pour tout le reste', () => {
    // `DEFAULT_LOCALE`, la dernière étape de `i18n/resolve.ts`. Le repli `'fr'`
    // de #845 est précisément ce que ce ticket supprime : aucune de ces valeurs
    // ne doit plus le ramener.
    for (const valeur of [undefined, null, '', 'FR', 'fr-CA', 'de', 'xx']) {
      expect(resolvePhoneLocale(valeur)).toBe('en');
    }
  });
});
