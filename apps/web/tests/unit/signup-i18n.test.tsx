import { ERROR_CODES, SUBSCRIPTION_PLAN } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { SignupForm } from '@/app/inscription/components/signup-form';
import { planPriceLabel } from '@/lib/plan';

/**
 * L'inscription d'un salon en français et en anglais — #1105.
 *
 * ## Pourquoi cette suite a sa propre doublure de `next-intl`
 *
 * L'amorce des suites fixe la langue à `fr` une fois pour toutes
 * (`tests/support/next-intl.ts`, #845) : c'est ce qui garde passantes les
 * cinquante-huit suites écrites avant l'épique #843. Or la promesse de ce
 * ticket est précisément que l'écran **change** de langue, et une suite qui
 * n'en connaîtrait qu'une ne pourrait pas le montrer.
 *
 * La doublure ci-dessous est donc celle de l'amorce, à une chose près : la
 * langue est une variable, et chaque test la pose par `fixerLangue()`. Le
 * formatage reste celui de la bibliothèque, sur les catalogues du dépôt — un
 * libellé vérifié ici est celui que la visiteuse lit. Elle vient de
 * `tests/support/langue-mobile.ts` (#1287), où elle est écrite une fois pour
 * toutes les suites qui changent de langue en cours de route.
 *
 * ## Ce qu'elle protège
 *
 * Quatre des critères d'acceptation, dans l'ordre où ils se lisent à l'écran :
 * les libellés viennent du catalogue, la langue du salon est proposée avec `en`
 * présélectionné et transmise à la création, les noms de pays suivent la langue
 * lue, et la promesse de l'offre est une phrase traduite dont le montant reste
 * un entier mis en forme selon la langue. Plus le dernier : un refus de l'API
 * s'affiche dans la langue de l'écran, et non dans celle du serveur.
 */

vi.mock('next-intl', () => nextIntlMobile());

const signupSalonAction = vi.fn();

vi.mock('@/app/inscription/actions', () => ({
  signupSalonAction: (...args: unknown[]) => signupSalonAction(...args),
}));

beforeEach(() => {
  fixerLangue('fr');
  signupSalonAction.mockResolvedValue({ ok: true, data: { next: 'https://checkout.stripe.test/x' } });
});

afterEach(() => {
  cleanup();
  signupSalonAction.mockReset();
});

/** Les libellés sous lesquels chaque langue rend les champs qu'on remplit. */
const LABELS = {
  fr: {
    name: 'Nom du salon',
    slug: 'Adresse de votre page',
    address: 'Adresse',
    city: 'Ville',
    country: 'Pays',
    language: 'Langue du salon',
    firstName: 'Prénom',
    lastName: 'Nom',
    email: 'Adresse e-mail',
    password: 'Mot de passe',
    confirmation: 'Confirmez le mot de passe',
    submit: 'Continuer vers le paiement sécurisé',
  },
  en: {
    name: 'Salon name',
    slug: 'Your page address',
    address: 'Address',
    city: 'City',
    country: 'Country',
    language: 'Salon language',
    firstName: 'First name',
    lastName: 'Last name',
    email: 'Email address',
    password: 'Password',
    confirmation: 'Confirm your password',
    submit: 'Continue to secure payment',
  },
} as const;

/**
 * Le champ que porte ce libellé, et lui seul.
 *
 * Ancré des deux bouts, l'astérisque des champs obligatoires toléré
 * (`components/ui/field.tsx`) : « Adresse » et « Adresse e-mail » cohabitent
 * dans la même langue, et une recherche partielle en désignerait deux.
 */
function champ(label: string): HTMLElement {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

  return screen.getByLabelText(new RegExp(`^${escaped}\\*?$`, 'u'));
}

/**
 * Une session de frappe **sans délai entre les touches**.
 *
 * Le défaut de `user-event` attend quelques millisecondes après chaque touche :
 * remplir les huit champs de ce formulaire y passait près de cinq secondes, soit
 * le délai d'expiration par défaut de Vitest — la suite tombait sur une machine
 * un peu chargée. `delay: null` ne change rien aux événements émis, seulement au
 * temps perdu entre eux.
 */
function frappe(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ delay: null });
}

/** Remplit le formulaire de quoi être soumis, et le soumet. */
async function remplirEtSoumettre(langue: 'fr' | 'en'): Promise<void> {
  const user = frappe();
  const labels = LABELS[langue];

  await user.type(champ(labels.name), 'Maison Lotus');
  await user.type(champ(labels.address), '12 rue des Lilas');
  await user.type(champ(labels.city), 'Montréal');
  await user.type(champ(labels.firstName), 'Alice');
  await user.type(champ(labels.lastName), 'Martin');
  await user.type(champ(labels.email), 'alice@maison-lotus.test');
  await user.type(champ(labels.password), 'motdepasse-solide');
  await user.type(champ(labels.confirmation), 'motdepasse-solide');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: labels.submit }));
}

/**
 * Un texte ramené à une seule forme d'espace.
 *
 * `Intl` insère des espaces **insécables** dans « 29 € » (U+202F) et dans la
 * ponctuation française ; les comparer à l'espace ordinaire d'un fichier source
 * ferait échouer la comparaison sur une différence que personne ne voit.
 */
function normalise(text: string | null): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim();
}

describe('la langue du salon à l’inscription (#1105)', () => {
  it('propose la langue du salon avec l’anglais présélectionné', () => {
    render(<SignupForm />);
    const select = champ(LABELS.fr.language) as HTMLSelectElement;

    // `en` est le défaut du système (#844) — pas la langue de la visiteuse, qui
    // lit cet écran en français.
    expect(select.value).toBe('en');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(['fr', 'en']);
  });

  it('transmet la langue présélectionnée à la création du salon', async () => {
    render(<SignupForm />);

    await remplirEtSoumettre('fr');

    expect(signupSalonAction).toHaveBeenCalledTimes(1);
    expect(signupSalonAction.mock.calls[0]?.[0]).toMatchObject({ defaultLocale: 'en' });
  });

  it('transmet la langue choisie quand la gérante en change', async () => {
    const user = frappe();
    render(<SignupForm />);

    await user.selectOptions(champ(LABELS.fr.language), 'fr');
    await remplirEtSoumettre('fr');

    expect(signupSalonAction.mock.calls[0]?.[0]).toMatchObject({ defaultLocale: 'fr' });
  });

  it('n’envoie jamais la confirmation du mot de passe à l’API', async () => {
    // Elle n'existe que côté écran : le contrat ne la porte pas, et
    // `salonSignupRequestSchema` est `.strict()`.
    render(<SignupForm />);

    await remplirEtSoumettre('fr');

    expect(signupSalonAction.mock.calls[0]?.[0]).not.toHaveProperty('confirmation');
  });
});

describe('les libellés de l’inscription suivent la langue lue (#1105)', () => {
  it('rend le formulaire en français', () => {
    render(<SignupForm />);

    expect(screen.getByRole('heading', { name: 'Créer mon salon' })).toBeDefined();
    expect(screen.getByRole('button', { name: LABELS.fr.submit })).toBeDefined();
  });

  it('rend le formulaire en anglais, sans un mot de français', () => {
    fixerLangue('en');
    render(<SignupForm />);

    expect(screen.getByRole('heading', { name: 'Create my salon' })).toBeDefined();
    expect(screen.getByRole('button', { name: LABELS.en.submit })).toBeDefined();
    expect(champ(LABELS.en.language)).toBeDefined();
    expect(screen.queryByText('Créer mon salon')).toBeNull();
  });
});

describe('les noms de pays suivent la langue lue (#1105)', () => {
  it('nomme les pays en français quand l’écran est en français', () => {
    render(<SignupForm />);
    const options = within(champ(LABELS.fr.country)).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toContain('États-Unis');
  });

  it('les nomme en anglais quand l’écran est en anglais', () => {
    // C'est le point du critère : les libellés figés de `lib/salon-presets.ts`
    // sont français, et un salon américain les lisait tels quels.
    fixerLangue('en');
    render(<SignupForm />);
    const options = within(champ(LABELS.en.country)).getAllByRole('option');
    const labels = options.map((option) => option.textContent);

    expect(labels).toContain('United States');
    expect(labels).not.toContain('États-Unis');
  });
});

describe('la promesse de l’offre est une phrase traduite (#1105)', () => {
  it('l’écrit en français, avec le prix mis en forme pour le français', () => {
    render(<SignupForm />);
    const fineprint = normalise(screen.getByText(/jours gratuits/u).textContent);

    expect(fineprint).toContain(String(SUBSCRIPTION_PLAN.trialDays));
    expect(fineprint).toContain(normalise(planPriceLabel({ locale: 'fr', countryCode: null })));
    expect(fineprint).toContain('Résiliable à tout moment.');
  });

  it('l’écrit en anglais, avec le prix mis en forme pour l’anglais', () => {
    fixerLangue('en');
    render(<SignupForm />);
    const fineprint = normalise(screen.getByText(/days free/u).textContent);

    expect(fineprint).toContain(normalise(planPriceLabel({ locale: 'en', countryCode: null })));
    expect(fineprint).toContain('Cancel any time.');
  });

  it('garde le montant entier et sa devise — le catalogue ne porte que la phrase', () => {
    // La règle de `CLAUDE.md` : l'argent est un entier dans la plus petite unité
    // de sa devise. Un prix recopié dans les catalogues aurait fait de la
    // traduction un endroit où changer un tarif.
    const catalogues = ['fr', 'en'] as const;

    for (const langue of catalogues) {
      expect(planPriceLabel({ locale: langue, countryCode: null })).toContain('29');
    }

    expect(SUBSCRIPTION_PLAN.amountMinor).toBe(2900);
    expect(SUBSCRIPTION_PLAN.currency).toBe('EUR');
  });
});

describe('les messages de validation suivent la langue de l’écran (#1105)', () => {
  /**
   * Le défaut que la recette de ce ticket a montré : les messages des schémas de
   * `@spa/shared` sont écrits en français — et en anglais brut de Zod quand ils
   * ne le sont pas —, si bien qu'un écran anglais devenait bilingue à la
   * première soumission.
   */
  it('refuse un formulaire vide en français, message par message', async () => {
    const user = frappe();
    render(<SignupForm />);

    await user.click(screen.getByRole('button', { name: LABELS.fr.submit }));

    expect(await screen.findByText('Indiquez le nom de votre salon.')).toBeDefined();
    expect(screen.getByText('Indiquez votre ville.')).toBeDefined();
    expect(screen.getByText('Cochez cette case pour créer votre salon.')).toBeDefined();
  });

  it('le refuse en anglais, sans un mot de français ni de Zod', async () => {
    fixerLangue('en');
    const user = frappe();
    render(<SignupForm />);

    await user.click(screen.getByRole('button', { name: LABELS.en.submit }));

    expect(await screen.findByText('Enter your salon’s name.')).toBeDefined();
    expect(screen.getByText('Enter your city.')).toBeDefined();
    expect(screen.getByText('Tick this box to create your salon.')).toBeDefined();
    // Les deux formes que la recette a relevées sur l'écran anglais.
    expect(screen.queryByText('ville requise')).toBeNull();
    expect(screen.queryByText('String must contain at least 1 character(s)')).toBeNull();
  });

  it('distingue le nom réservé de la forme du slug, dans les deux langues', async () => {
    // Le slug est le seul champ qui a deux façons d'être refusé : sa **forme**
    // (`DNS_LABEL_PATTERN`) et sa **disponibilité** (`RESERVED_TENANT_SLUGS`).
    // Un message unique par champ dirait à qui saisit `support` d'employer des
    // minuscules et des tirets — qu'il a déjà écrits.
    for (const langue of ['fr', 'en'] as const) {
      fixerLangue(langue);
      const user = frappe();
      render(<SignupForm />);

      await user.type(champ(LABELS[langue].slug), 'support');
      await user.click(screen.getByRole('button', { name: LABELS[langue].submit }));

      const reserve =
        langue === 'fr'
          ? 'Ce nom est réservé par la plateforme — choisissez-en un autre.'
          : 'This name is reserved by the platform — please choose another one.';

      expect(await screen.findByText(reserve)).toBeDefined();
      cleanup();
    }
  });

  it('annonce la confirmation qui ne correspond pas, dans la langue lue', async () => {
    fixerLangue('en');
    const user = frappe();
    render(<SignupForm />);

    await user.type(champ(LABELS.en.password), 'motdepasse-solide');
    await user.type(champ(LABELS.en.confirmation), 'autre-mot-de-passe');
    await user.click(screen.getByRole('button', { name: LABELS.en.submit }));

    expect(await screen.findByText('the two passwords do not match')).toBeDefined();
  });
});

describe('les refus de l’inscription s’affichent dans la langue de l’écran (#1105)', () => {
  it('pose l’adresse déjà prise sur le champ, en français', async () => {
    signupSalonAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.TENANT_SLUG_TAKEN,
      message: 'peu importe, le front trie sur le code',
    });
    render(<SignupForm />);

    await remplirEtSoumettre('fr');

    expect(
      await screen.findByText('Cette adresse est déjà prise — choisissez-en une autre.'),
    ).toBeDefined();
  });

  it('la pose en anglais quand l’écran est en anglais', async () => {
    fixerLangue('en');
    signupSalonAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.TENANT_SLUG_TAKEN,
      message: 'Cette adresse est déjà prise — choisissez-en une autre.',
    });
    render(<SignupForm />);

    await remplirEtSoumettre('en');

    expect(
      await screen.findByText('This address is already taken — please choose another one.'),
    ).toBeDefined();
  });

  it('n’affiche pas le message français du serveur sur un écran anglais', async () => {
    // Le message d'un refus est écrit côté serveur : le lire tel quel rendrait
    // l'écran bilingue à la première erreur. Le front trie sur le **code**.
    fixerLangue('en');
    signupSalonAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Une erreur inattendue est survenue. Merci de réessayer.',
    });
    render(<SignupForm />);

    await remplirEtSoumettre('en');

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeDefined();
    expect(screen.queryByText('Une erreur inattendue est survenue. Merci de réessayer.')).toBeNull();
  });

  /*
   * Le repli d'un code inconnu — #1234, second critère d'acceptation : *« aucun
   * écran ne retombe sur un message brut de l'API ; un code inconnu donne un
   * message générique traduit »*.
   *
   * Il retombait sur `result.message`, c'est-à-dire sur la phrase du serveur —
   * écrite en français, l'API n'ayant pas de langue de requête. C'était l'écran
   * bilingue au premier refus que la table de l'inscription ne nomme pas, et
   * c'est précisément ce que le ticket ferme : le repli est
   * `errorMessage(code, locale)` du contrat partagé, dont le repli à lui est la
   * phrase générique d'`INTERNAL_ERROR`.
   */
  it.each([
    ['fr', 'Une erreur inattendue est survenue. Réessayez dans un instant.'],
    ['en', 'Something went wrong. Please try again in a moment.'],
  ] as const)('donne un message générique traduit pour un code inconnu — %s', async (locale, attendu) => {
    fixerLangue(locale);
    signupSalonAction.mockResolvedValue({
      ok: false,
      code: 'CODE_QUI_NEXISTE_PAS',
      message: 'Un refus que le front ne sait pas nommer.',
    });
    render(<SignupForm />);

    await remplirEtSoumettre(locale);

    expect(await screen.findByText(attendu)).toBeDefined();
    // Et surtout : la phrase du serveur ne s'affiche plus, dans aucune langue.
    expect(screen.queryByText('Un refus que le front ne sait pas nommer.')).toBeNull();
  });
});
