import { validationMessage, validationPhrases, type Locale } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

/**
 * Le refus d'un champ vient du contrat, et il arrive dans la langue de l'écran —
 * #1376.
 *
 * ## Le défaut que cette suite referme
 *
 * #1373 avait fait de `validationPhrases(locale)` la source unique de la phrase
 * du champ vide, et retiré les trois clés de catalogue du back-office qui la
 * redisaient. Six autres restaient, sur quatre écrans que ce ticket-là ne nommait
 * pas : l'étape de contact du tunnel, la connexion de la console, l'ouverture
 * d'un salon et l'inscription.
 *
 * Et le risque que #1373 décrivait était **déjà réalisé** sur quatre d'entre
 * elles, sans que rien ne le signale : les clés d'adresse e-mail étaient
 * identiques au contrat en anglais — d'où le silence de toute garde qui aurait
 * comparé les deux langues à la fois — et en divergeaient en français.
 * « Saisissez une adresse e-mail **valide**. » au catalogue contre « … e-mail
 * **valable**. » au contrat ; « **Indiquez** une adresse … » à l'inscription,
 * troisième formulation du même refus. Le même champ disait donc deux ou trois
 * phrases selon que le refus venait du schéma partagé ou du formulaire.
 *
 * ## Ce que cette suite tient, et que `messages-glossary` ne peut pas tenir
 *
 * La garde du glossaire est **statique** : elle lit les catalogues et refuse
 * qu'une feuille redise une phrase du contrat. Elle ne dit rien de ce qui
 * s'affiche réellement sous le champ — un écran peut très bien avoir perdu sa
 * clé et n'afficher plus rien du tout, ou afficher la phrase du **repli**
 * français de `@spa/shared` sous une étiquette anglaise, ce qui est exactement le
 * défaut que #1232 avait refermé ailleurs.
 *
 * C'est donc un test de **rendu**, sur les deux langues, et les phrases y sont
 * **lues** au contrat :
 *
 * - `validationPhrases(locale).required` pour le champ laissé vide ;
 * - `validationMessage('identifier.email', locale)` pour l'adresse mal formée —
 *   `emailSchema` porte cette clé de message depuis #1232, et c'est elle que
 *   `zodErrorMap(locale)` traduit.
 *
 * Jamais un littéral recopié : une reformulation du contrat ne fait pas rougir
 * cette suite, elle la suit. C'est la règle déjà tenue par
 * `validation-i18n.test.tsx` et `erreur-de-champ-suit-la-langue.test.tsx`.
 */

vi.mock('next-intl', () => nextIntlMobile());

const signupSalonAction = vi.fn();
const platformLoginAction = vi.fn();
const provisionTenantAction = vi.fn();

vi.mock('@/app/inscription/actions', () => ({
  signupSalonAction: (...args: unknown[]) => signupSalonAction(...args),
}));

vi.mock('@/app/plateforme/actions', () => ({
  platformLoginAction: (...args: unknown[]) => platformLoginAction(...args),
  platformLogoutAction: vi.fn(),
  provisionTenantAction: (...args: unknown[]) => provisionTenantAction(...args),
  reissueTenantInvitationAction: vi.fn(),
  addTenantNoteAction: vi.fn(),
  updateTenantStatusAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/plateforme/salons',
}));

import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { SignupForm } from '@/app/inscription/components/signup-form';
import { PlatformLoginForm } from '@/app/plateforme/components/platform-login-form';
import { TenantCreateForm } from '@/app/plateforme/components/tenant-create-form';
import { emptyBookingDraft } from '@/lib/booking/draft';

beforeAll(() => {
  // L'ouverture d'un salon tire une clé d'idempotence au montage, et jsdom
  // n'expose pas toujours `crypto.randomUUID` — même précaution que
  // `platform-console-i18n.test.tsx`, dont ce n'est pas le sujet non plus.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...globalThis.crypto, randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    });
  }
});

beforeEach(() => {
  fixerLangue('fr');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

/**
 * Une session de frappe **sans délai entre les touches**.
 *
 * Le défaut de `user-event` attend quelques millisecondes après chaque touche, et
 * ces formulaires en comptent jusqu'à huit champs : la même précaution que
 * `signup-i18n.test.tsx`, pour la même raison.
 */
function frappe(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ delay: null });
}

/** Les libellés et les boutons sous lesquels chaque langue rend ces écrans. */
const LIBELLES = {
  fr: {
    tunnelFirstName: /^Prénom/,
    tunnelEmail: /^Adresse e-mail/,
    tunnelSubmit: /Vérifier ma réservation/,
    consoleEmail: 'Adresse e-mail*',
    consolePassword: 'Mot de passe*',
    consoleCode: 'Code de vérification*',
    consoleSubmit: 'Se connecter',
    salonName: 'Nom du salon*',
    salonAddress: 'Adresse*',
    salonCity: 'Ville*',
    salonFirstName: 'Prénom*',
    salonLastName: 'Nom*',
    salonEmail: 'Adresse e-mail*',
    salonSubmit: 'Ouvrir le salon',
    signupEmail: /^Adresse e-mail/,
    signupSubmit: 'Continuer vers le paiement sécurisé',
  },
  en: {
    tunnelFirstName: /^First name/,
    tunnelEmail: /^Email address/,
    tunnelSubmit: /Review my booking/,
    consoleEmail: 'Email address*',
    consolePassword: 'Password*',
    consoleCode: 'Verification code*',
    consoleSubmit: 'Sign in',
    salonName: 'Salon name*',
    salonAddress: 'Address*',
    salonCity: 'City*',
    salonFirstName: 'First name*',
    salonLastName: 'Last name*',
    salonEmail: 'Email address*',
    salonSubmit: 'Open the salon',
    signupEmail: /^Email address/,
    signupSubmit: 'Continue to secure payment',
  },
} as const;

/** Les deux langues du contrat, dans l'ordre où le produit les nomme. */
const LANGUES: readonly Locale[] = ['fr', 'en'];

/** La phrase du contrat pour une adresse mal formée, dans la langue lue. */
function adresseInvalide(locale: Locale): string {
  return validationMessage('identifier.email', locale);
}

/**
 * Le message porté par **ce** champ, ou `null` s'il n'en porte aucun.
 *
 * Cherché par l'identifiant que `Field` donne à son message — `${id}-error`,
 * celui que porte `aria-describedby` — et non par le texte. Deux choses s'y
 * prouvent d'un coup : que la phrase est la bonne, et qu'elle est rendue **sur
 * le champ** et non en bloc en tête de page (web-frontend §4). C'est le même
 * repère que `erreur-de-champ-suit-la-langue.test.tsx`.
 */
function messageDuChamp(id: string): string | null {
  const element = document.querySelector(`#${id}-error`);

  return element === null ? null : normaliser(element.textContent ?? '');
}

/**
 * La normalisation des espaces, appliquée aux deux côtés de la comparaison.
 *
 * Les phrases françaises portent des espaces insécables ; `\s` les confond avec
 * une espace ordinaire, et comparer un texte du DOM à une phrase non normalisée
 * échouerait sur la typographie plutôt que sur la langue.
 */
function normaliser(phrase: string): string {
  return phrase.replace(/\s+/gu, ' ').trim();
}

/**
 * Les trois phrases que les catalogues portaient avant ce ticket, et qui ne
 * doivent plus s'afficher nulle part.
 *
 * Elles sont écrites en clair ici, et c'est le seul endroit de cette suite où un
 * littéral est justifié : ce sont des textes **retirés**, qu'aucune source ne
 * porte plus — les lire quelque part serait précisément le défaut à interdire.
 */
const PHRASES_RETIREES: readonly string[] = [
  'Saisissez une adresse e-mail valide.',
  'Indiquez une adresse e-mail valide.',
  'Cette valeur n’est pas valide.',
];

/** Rougit si l'écran affiche encore une des phrases que le catalogue a perdues. */
function aucunePhraseRetiree(): void {
  for (const phrase of PHRASES_RETIREES) {
    expect(screen.queryByText(phrase), `« ${phrase} » est encore affichée`).toBeNull();
  }
}

/**
 * Monte un écran, et rend de quoi le **rejouer dans l'autre langue**.
 *
 * `rerender` et non un second `render` — c'est le geste réel du sélecteur de
 * langue de la coquille : le même arbre se rend à nouveau, **avec son état**, la
 * route étant rejouée sans navigation. Un `render` neuf remonterait le
 * formulaire et repartirait d'un `formState` vide, donc prouverait le contraire
 * de ce qu'on cherche. Même geste, et même raison, que
 * `erreur-de-champ-suit-la-langue.test.tsx`.
 */
function monter(vue: () => ReactElement): { readonly enAnglais: () => void } {
  const { rerender } = render(vue());

  return {
    enAnglais: () => {
      fixerLangue('en');
      rerender(vue());
    },
  };
}

/** L'étape de contact du tunnel, sans compte ni rappel de réservation. */
function etapeDeContact(): ReactElement {
  return (
    <ContactStep
      contact={emptyBookingDraft().contact}
      tenantSlug="salon-zen"
      countryCode="FR"
      summary={null}
      presence={null}
      onSave={vi.fn()}
      onBack={vi.fn()}
      onSubmit={vi.fn()}
    />
  );
}

/** Monte l'étape de contact du tunnel, sans compte ni rappel de réservation. */
function monterEtapeDeContact(): void {
  render(etapeDeContact());
}

describe('l’étape de contact du tunnel dit les refus du contrat (#1376)', () => {
  for (const locale of LANGUES) {
    it(`annonce le champ vide avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      monterEtapeDeContact();

      await user.click(screen.getByRole('button', { name: LIBELLES[locale].tunnelSubmit }));

      // Deux champs requis laissés vides — le prénom et le nom : la phrase est
      // lue sur chacun, et c'est sa **langue** qui est mesurée.
      await waitFor(() => {
        expect(messageDuChamp('firstName')).toBe(normaliser(validationPhrases(locale).required));
      });
      expect(messageDuChamp('lastName')).toBe(normaliser(validationPhrases(locale).required));
      aucunePhraseRetiree();
    });

    it(`annonce l’adresse mal formée avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      monterEtapeDeContact();

      await user.type(screen.getByLabelText(LIBELLES[locale].tunnelFirstName), 'Camille');
      await user.type(screen.getByLabelText(LIBELLES[locale].tunnelEmail), 'camille');
      await user.click(screen.getByRole('button', { name: LIBELLES[locale].tunnelSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('email')).toBe(normaliser(adresseInvalide(locale)));
      });
      aucunePhraseRetiree();
    });
  }

  /**
   * Le refus déjà affiché suit la langue — la moitié de ce ticket que les cas
   * ci-dessus ne peuvent pas voir.
   *
   * Ils rendent chaque langue depuis un montage neuf : la phrase y est calculée
   * par `zodErrorMap(locale)` à la validation, donc juste par construction. Ce
   * que #1376 ajoute à cette étape est le **rejeu** (`useLocalizedFieldErrors`),
   * et il ne se prouve que sur un formulaire qui n'est pas démonté — c'est le
   * geste du sélecteur de langue de la coquille du salon.
   *
   * Le second `expect` est la garantie qui coûtait l'arbitrage de #1354 : le
   * prénom n'a jamais été rempli, et la bascule ne doit pas le lui reprocher. Un
   * `trigger()` sans argument y ferait apparaître « Ce champ est obligatoire. »
   * sous un champ que personne n'a touché.
   */
  it('rejoue le refus de l’adresse dans la nouvelle langue, sans en inventer', async () => {
    const user = frappe();
    const { enAnglais } = monter(etapeDeContact);

    await user.type(screen.getByLabelText(LIBELLES.fr.tunnelEmail), 'camille');
    // `mode: 'onTouched'` : la validation a lieu quand on quitte le champ.
    await user.tab();

    await waitFor(() => {
      expect(messageDuChamp('email')).toBe(normaliser(adresseInvalide('fr')));
    });
    expect(messageDuChamp('firstName')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('email')).toBe(normaliser(adresseInvalide('en')));
    });
    expect(messageDuChamp('firstName')).toBeNull();
  });
});

describe('la connexion de la console dit le refus du contrat (#1376)', () => {
  for (const locale of LANGUES) {
    it(`annonce l’adresse mal formée dans la langue lue — « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<PlatformLoginForm expired={false} />);

      await user.type(screen.getByLabelText(LIBELLES[locale].consoleEmail), 'ops');
      await user.type(screen.getByLabelText(LIBELLES[locale].consolePassword), 'mot-de-passe-long');
      await user.type(screen.getByLabelText(LIBELLES[locale].consoleCode), '123456');
      await user.click(screen.getByRole('button', { name: LIBELLES[locale].consoleSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('plateforme-email')).toBe(normaliser(adresseInvalide(locale)));
      });
      aucunePhraseRetiree();
      expect(platformLoginAction).not.toHaveBeenCalled();
    });
  }

  /**
   * Le rejeu, sur le second écran que #1376 branche à `useLocalizedFieldErrors`.
   *
   * Même raison qu'au tunnel : c'est le seul cas où la phrase affichée est
   * relue plutôt que produite, et donc le seul qui rougirait si le crochet
   * partait. Le mot de passe, jamais rempli, reste muet après la bascule.
   */
  it('rejoue le refus de l’adresse dans la nouvelle langue, sans en inventer', async () => {
    const user = frappe();
    const { enAnglais } = monter(() => <PlatformLoginForm expired={false} />);

    await user.type(screen.getByLabelText(LIBELLES.fr.consoleEmail), 'ops');
    await user.tab();

    await waitFor(() => {
      expect(messageDuChamp('plateforme-email')).toBe(normaliser(adresseInvalide('fr')));
    });
    expect(messageDuChamp('plateforme-password')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('plateforme-email')).toBe(normaliser(adresseInvalide('en')));
    });
    expect(messageDuChamp('plateforme-password')).toBeNull();
  });
});

describe('l’ouverture d’un salon dit le refus du contrat (#1376)', () => {
  for (const locale of LANGUES) {
    it(`annonce l’adresse du gérant mal formée en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<TenantCreateForm />);

      const libelles = LIBELLES[locale];

      await user.type(screen.getByLabelText(libelles.salonName), 'Maison Lotus');
      await user.type(screen.getByLabelText(libelles.salonAddress), '12 rue des Lilas');
      await user.type(screen.getByLabelText(libelles.salonCity), 'Boston');
      await user.type(screen.getByLabelText(libelles.salonFirstName), 'Hasina');
      await user.type(screen.getByLabelText(libelles.salonLastName), 'Rakoto');
      await user.type(screen.getByLabelText(libelles.salonEmail), 'hasina');
      await user.click(screen.getByRole('button', { name: libelles.salonSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('gerant-email')).toBe(normaliser(adresseInvalide(locale)));
      });
      aucunePhraseRetiree();
      expect(provisionTenantAction).not.toHaveBeenCalled();
    });
  }
});

describe('l’inscription dit le refus du contrat (#1376)', () => {
  for (const locale of LANGUES) {
    it(`annonce l’adresse de la gérante mal formée en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<SignupForm />);

      // Le seul champ que ce cas remplit : les autres refus sont ceux du
      // catalogue de l'écran, et ils ont leur propre suite (`signup-i18n`).
      await user.type(screen.getByLabelText(LIBELLES[locale].signupEmail), 'gerante');
      await user.click(screen.getByRole('button', { name: LIBELLES[locale].signupSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('inscription-email')).toBe(normaliser(adresseInvalide(locale)));
      });
      aucunePhraseRetiree();
      expect(signupSalonAction).not.toHaveBeenCalled();
    });
  }
});
