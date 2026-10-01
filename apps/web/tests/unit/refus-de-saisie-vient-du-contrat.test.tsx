import {
  SLUG_MAX_LENGTH,
  validationMessage,
  validationPhrases,
  type Locale,
  type ServiceCategory,
  type StaffSchedule,
  type Tenant,
} from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

/**
 * Le refus d'un champ vient du contrat, et il arrive dans la langue de l'écran —
 * #1376, étendu au code de vérification par #1387, puis aux huit clés du
 * back-office et de l'inscription par #1388.
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
 *   `zodErrorMap(locale)` traduit ;
 * - `validationMessage('platform.totpCode', locale)` pour le code de vérification
 *   incomplet de la console — la copie que #1376 avait laissée derrière lui, parce
 *   que ses critères ne portaient que sur `validationPhrases` et non sur la table
 *   `VALIDATION_MESSAGES` (#1387). Elle avait, elle aussi, déjà divergé en anglais.
 *
 * Jamais un littéral recopié : une reformulation du contrat ne fait pas rougir
 * cette suite, elle la suit. C'est la règle déjà tenue par
 * `validation-i18n.test.tsx` et `erreur-de-champ-suit-la-langue.test.tsx`.
 *
 * ## Ce que #1388 ajoute : cinq écrans de plus
 *
 * #1387 avait laissé huit dispenses dans `COPIES_DE_MESSAGES_TOLEREES`, hors de son
 * empreinte. **#1388 les écoule toutes les huit**, sur cinq écrans, et chacun a son
 * cas ici — la garde statique du glossaire dit que la clé n'est plus au catalogue,
 * elle ne dit pas que l'écran affiche encore quelque chose :
 *
 * - `validationMessage('identifier.slug', locale)` et
 *   `validationMessage('identifier.slugReserved', locale)` sous l'adresse d'une
 *   **prestation** et d'une **rubrique** — quatre clés, déjà divergentes en anglais ;
 * - `validationMessage('identifier.countryCode', locale)` sous le pays des
 *   **réglages de l'établissement** ;
 * - `validationMessage('identifier.slugReserved', locale)` sous l'adresse de
 *   l'**inscription**, elle aussi divergente en anglais ;
 * - `validationMessage('availability.scheduleOverlap', locale)` au bandeau de la
 *   **grille d'horaires** — la huitième, et la seule que n'écrivait pas un
 *   résolveur de formulaire mais `scheduleRefusalMessage`, un validateur pur lu
 *   hors de React.
 *
 * La septième, `admin-staff.invite.phoneInvalid`, n'était affichée par personne :
 * `PhoneField` écrit sa propre phrase quand il est marqué invalide, et elle nomme
 * le pays choisi — ce que le contrat ne sait pas faire (#825). Son cas ci-dessous
 * mesure donc ce qui compte vraiment de ce côté : le champ est **toujours marqué**,
 * et sa phrase suit la langue.
 */

vi.mock('next-intl', () => nextIntlMobile());

const signupSalonAction = vi.fn();
const platformLoginAction = vi.fn();
const provisionTenantAction = vi.fn();
const createServiceAction = vi.fn();
const createServiceCategoryAction = vi.fn();
const updateTenantSettingsAction = vi.fn();
const inviteStaffAccountAction = vi.fn();
const setStaffScheduleAction = vi.fn();

vi.mock('@/app/inscription/actions', () => ({
  signupSalonAction: (...args: unknown[]) => signupSalonAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: (...args: unknown[]) => createServiceAction(...args),
  updateServiceAction: vi.fn(),
  createServiceCategoryAction: (...args: unknown[]) => createServiceCategoryAction(...args),
  updateServiceCategoryAction: vi.fn(),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  updateTenantSettingsAction: (...args: unknown[]) => updateTenantSettingsAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  inviteStaffAccountAction: (...args: unknown[]) => inviteStaffAccountAction(...args),
  setStaffScheduleAction: (...args: unknown[]) => setStaffScheduleAction(...args),
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

import { CategoryForm } from '@/app/(admin)/[tenantSlug]/admin/components/category-manager';
import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';
import { TenantSettingsForm } from '@/app/(admin)/[tenantSlug]/admin/components/tenant-settings-form';
import { StaffInviteForm } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-invite-form';
import { StaffScheduleEditor } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-schedule-editor';
import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { SignupForm } from '@/app/inscription/components/signup-form';
import { PlatformLoginForm } from '@/app/plateforme/components/platform-login-form';
import { TenantCreateForm } from '@/app/plateforme/components/tenant-create-form';
import { emptyBookingDraft } from '@/lib/booking/draft';
import { phoneInvalidMessage } from '@/lib/phone';

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
    serviceSave: 'Créer la prestation',
    categorySave: 'Créer la rubrique',
    inviteSubmit: 'Inviter',
    scheduleSave: /Enregistrer la semaine/,
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
    serviceSave: 'Create the service',
    categorySave: 'Create the section',
    inviteSubmit: 'Invite',
    scheduleSave: /Save the week/,
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
 * Saisit une valeur dans le champ d'`id`, puis **quitte le champ**.
 *
 * Désigné par son identifiant et non par son étiquette : ces quatre écrans rendent
 * la leur dans deux langues, et un `getByLabelText` ferait échouer la moitié des
 * cas sur la traduction du libellé au lieu de la phrase du refus. C'est le même
 * repère que {@link messageDuChamp}, pris du même côté.
 *
 * Le `tab()` final n'est pas décoratif : les quatre formulaires sont en
 * `mode: 'onTouched'`, et la validation a lieu quand on quitte le champ. Il est
 * aussi ce qui garantit qu'**un seul** champ est jugé — les voisins jamais
 * remplis restent muets.
 */
async function saisir(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
  value: string,
): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(`#${id}`);

  if (field === null) {
    throw new Error(`champ #${id} absent du rendu`);
  }

  await user.clear(field);
  await user.type(field, value);
  await user.tab();
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
 * Les phrases que les catalogues portaient avant ces tickets, et qui ne doivent
 * plus s'afficher nulle part.
 *
 * Elles sont écrites en clair ici, et c'est le seul endroit de cette suite où un
 * littéral est justifié : ce sont des textes **retirés**, qu'aucune source ne
 * porte plus — les lire quelque part serait précisément le défaut à interdire.
 *
 * La quatrième vient de #1387, et elle dit pourquoi cette liste vaut mieux qu'une
 * comparaison de plus : la copie anglaise du refus de code de vérification avait
 * **divergé** du contrat, et c'est cette formulation-là — et non celle du
 * contrat — qui ne doit plus paraître. Son pendant français, lui, n'est pas
 * inscrit ici : il était identique au contrat, et c'est donc la phrase que les
 * écrans affichent encore, légitimement.
 *
 * Les trois dernières viennent de #1388, et elles suivent la même règle : seules
 * les formulations **divergentes** y entrent. Les quatre clés d'adresse du
 * catalogue et celle de l'inscription s'écartaient du contrat en anglais, et ce
 * sont ces cinq phrases-là — réduites à trois libellés distincts — qui ne doivent
 * plus paraître. Le pays des réglages et le numéro de l'invitation, identiques au
 * contrat dans les deux langues, n'y figurent pas : leur texte est exactement
 * celui que les écrans affichent désormais.
 */
const PHRASES_RETIREES: readonly string[] = [
  'Saisissez une adresse e-mail valide.',
  'Indiquez une adresse e-mail valide.',
  'Cette valeur n’est pas valide.',
  'Six digits, as your authenticator app shows them.',
  'An address in lowercase letters, digits and single hyphens is expected.',
  'This name is reserved by the platform — choose another one.',
  'This name is reserved by the platform — please choose another one.',
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
   * Le code de vérification — la copie que #1376 avait laissée derrière lui (#1387).
   *
   * Sa phrase de catalogue redisait `validationMessage('platform.totpCode', 'fr')`
   * mot pour mot, et en divergeait déjà en anglais. Le refus vient désormais du
   * `refine` de `platformLoginRequestSchema`, qui pose
   * `messageKey('platform.totpCode')` : ce cas le lit au contrat, et il le lit dans
   * les deux langues — c'est le troisième critère de #1387.
   *
   * Le code est saisi **incomplet** et non laissé vide : le `refine` refuse les
   * deux, mais un champ vide se dirait aussi bien par `phrases.required` sur un
   * autre schéma, et ce qu'on veut éprouver ici est la phrase que seule cette
   * règle-là sait nommer.
   */
  for (const locale of LANGUES) {
    it(`annonce le code de vérification incomplet avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<PlatformLoginForm expired={false} />);

      await user.type(screen.getByLabelText(LIBELLES[locale].consoleEmail), 'ops@spa.test');
      await user.type(screen.getByLabelText(LIBELLES[locale].consolePassword), 'mot-de-passe-long');
      await user.type(screen.getByLabelText(LIBELLES[locale].consoleCode), '12');
      await user.click(screen.getByRole('button', { name: LIBELLES[locale].consoleSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('plateforme-totp')).toBe(
          normaliser(validationMessage('platform.totpCode', locale)),
        );
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

  /**
   * Le rejeu du **code de vérification** — ce que #1387 rend nécessaire ici.
   *
   * Tant que la phrase venait du catalogue, elle suivait la langue **au rendu** :
   * `t('login.fieldErrors.totpCode')` était relu à chaque passage, et le rejeu
   * n'y était pour rien. Depuis que c'est le contrat qui répond, elle est
   * calculée **à la validation** et rangée telle quelle dans
   * `formState.errors` — la même situation que l'adresse, donc la même
   * dépendance à `useLocalizedFieldErrors`. Sans ce cas, le crochet pourrait
   * cesser de reprendre ce champ-là sans que rien ne rougisse : l'opérateur qui
   * bascule la langue garderait « Six chiffres… » sous une étiquette anglaise.
   */
  it('rejoue le refus du code de vérification dans la nouvelle langue', async () => {
    const user = frappe();
    const { enAnglais } = monter(() => <PlatformLoginForm expired={false} />);

    await user.type(screen.getByLabelText(LIBELLES.fr.consoleCode), '12');
    // `mode: 'onTouched'` : la validation a lieu quand on quitte le champ.
    await user.tab();

    await waitFor(() => {
      expect(messageDuChamp('plateforme-totp')).toBe(
        normaliser(validationMessage('platform.totpCode', 'fr')),
      );
    });
    expect(messageDuChamp('plateforme-email')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('plateforme-totp')).toBe(
        normaliser(validationMessage('platform.totpCode', 'en')),
      );
    });
    expect(messageDuChamp('plateforme-email')).toBeNull();
    aucunePhraseRetiree();
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

  /**
   * Le nom réservé — la copie que #1387 avait laissée à l'inscription (#1388).
   *
   * `signup.fieldErrors.slugReserved` redisait `identifier.slugReserved` mot pour
   * mot en français et en **divergeait** en anglais, « — please choose another
   * one. » au catalogue contre « — please choose another. » au contrat. Le refus
   * vient désormais du `refine` de `slugSchema`, qui pose la clé : ce cas la lit au
   * contrat, dans les deux langues.
   *
   * `www` plutôt qu'une adresse mal écrite : les deux règles de `slugSchema` rendent
   * un `custom` depuis #1232, et c'est la valeur saisie qui les départage. Celle-ci
   * est bien formée — minuscules et rien d'autre — et pourtant refusée, ce qui est
   * exactement le cas où une phrase unique mentirait.
   */
  for (const locale of LANGUES) {
    it(`annonce le nom réservé avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<SignupForm />);

      await saisir(user, 'inscription-adresse-web', 'www');

      await waitFor(() => {
        expect(messageDuChamp('inscription-adresse-web')).toBe(
          normaliser(validationMessage('identifier.slugReserved', locale)),
        );
      });
      aucunePhraseRetiree();
      expect(signupSalonAction).not.toHaveBeenCalled();
    });
  }

  /**
   * Le rejeu du nom réservé — ce que le passage au contrat rend nécessaire ici.
   *
   * Tant que la phrase venait du catalogue, `t('fieldErrors.slugReserved')` était
   * relu à chaque rendu et suivait la langue sans que rien n'y veille. Elle est
   * maintenant calculée à la validation et rangée dans `formState.errors` : c'est
   * `useLocalizedFieldErrors` qui la remet dans la nouvelle langue. Même situation,
   * et même garde, que le code de vérification de la console (#1387).
   */
  it('rejoue le refus du nom réservé dans la nouvelle langue', async () => {
    const user = frappe();
    const { enAnglais } = monter(() => <SignupForm />);

    await saisir(user, 'inscription-adresse-web', 'www');

    await waitFor(() => {
      expect(messageDuChamp('inscription-adresse-web')).toBe(
        normaliser(validationMessage('identifier.slugReserved', 'fr')),
      );
    });
    expect(messageDuChamp('inscription-nom')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('inscription-adresse-web')).toBe(
        normaliser(validationMessage('identifier.slugReserved', 'en')),
      );
    });
    expect(messageDuChamp('inscription-nom')).toBeNull();
    aucunePhraseRetiree();
  });
});

// ---------------------------------------------------------------------------
// Les quatre écrans que #1388 reprend
// ---------------------------------------------------------------------------

/** La rubrique proposée au classement d'une prestation — une suffit. */
const RUBRIQUES: readonly ServiceCategory[] = [
  {
    id: '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60',
    slug: 'soins-du-visage',
    name: 'Soins du visage',
    description: null,
    isActive: true,
  },
];

/** L'établissement dont les réglages s'éditent — sans adresse, le champ pays est vide. */
const SALON: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'salon-zen',
  name: 'Salon Zen',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
  isActive: true,
  receiptPrefix: 'TIC',
  taxRateBps: 0,
};

describe('la fiche d’une prestation dit les refus d’adresse du contrat (#1388)', () => {
  function fiche(): ReactElement {
    return <ServiceForm tenantSlug="salon-zen" currency="EUR" categories={RUBRIQUES} />;
  }

  /**
   * Les deux refus de `slugSchema`, et ils n'ont pas la même phrase.
   *
   * `pas_une_adresse` est mal formée — c'est `resourceSlugSchema` qui refuse, par
   * `messageKey('identifier.slug')`. `www` est bien formée et **réservée** — c'est
   * le `refine` de `slugSchema`, par `messageKey('identifier.slugReserved')`. Les
   * deux rendent un `custom` depuis #1232, et c'est la valeur saisie qui les
   * départage : une phrase unique aurait reproché une minuscule à `www`, qui n'a
   * rien d'autre.
   */
  const CAS = [
    { saisie: 'pas_une_adresse', cle: 'identifier.slug' },
    { saisie: 'www', cle: 'identifier.slugReserved' },
  ] as const;

  for (const { saisie, cle } of CAS) {
    for (const locale of LANGUES) {
      it(`annonce « ${cle} » avec la phrase du contrat en « ${locale} »`, async () => {
        fixerLangue(locale);
        const user = frappe();
        render(fiche());

        await saisir(user, 'service-slug', saisie);

        await waitFor(() => {
          expect(messageDuChamp('service-slug')).toBe(
            normaliser(validationMessage(cle, locale)),
          );
        });
        aucunePhraseRetiree();
        expect(createServiceAction).not.toHaveBeenCalled();
      });
    }
  }

  /**
   * Ce qui **reste** au catalogue sur ce champ, et doit y rester.
   *
   * La borne de 63 caractères n'est pas une copie mais une reformulation : elle
   * nomme le champ — « Cette adresse fait au plus 63 caractères. » — là où le
   * contrat dirait « Ne dépassez pas 63 caractères. ». `messages/README.md` tranche
   * qu'elle reste à l'écran, et ce cas interdit qu'un ticket de déduplication
   * l'emporte au passage : la phrase affichée n'est **pas** celle du contrat.
   */
  for (const locale of LANGUES) {
    it(`laisse la borne de longueur à l’écran en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(fiche());

      await saisir(user, 'service-slug', 'a'.repeat(SLUG_MAX_LENGTH + 1));

      await waitFor(() => {
        expect(messageDuChamp('service-slug')).toContain(String(SLUG_MAX_LENGTH));
      });
      // Ni l'une ni l'autre des deux phrases du contrat : c'est bien celle de
      // l'écran, qui nomme le champ en même temps que sa borne.
      expect(messageDuChamp('service-slug')).not.toBe(
        normaliser(validationMessage('identifier.slug', locale)),
      );
      expect(messageDuChamp('service-slug')).not.toBe(
        normaliser(validationPhrases(locale).tooLong(SLUG_MAX_LENGTH)),
      );
    });
  }
});

describe('la rubrique du catalogue dit les refus d’adresse du contrat (#1388)', () => {
  function fiche(): ReactElement {
    return <CategoryForm tenantSlug="salon-zen" />;
  }

  const CAS = [
    { saisie: 'pas_une_adresse', cle: 'identifier.slug' },
    { saisie: 'www', cle: 'identifier.slugReserved' },
  ] as const;

  for (const { saisie, cle } of CAS) {
    for (const locale of LANGUES) {
      it(`annonce « ${cle} » avec la phrase du contrat en « ${locale} »`, async () => {
        fixerLangue(locale);
        const user = frappe();
        render(fiche());

        await saisir(user, 'category-slug-nouvelle', saisie);

        await waitFor(() => {
          expect(messageDuChamp('category-slug-nouvelle')).toBe(
            normaliser(validationMessage(cle, locale)),
          );
        });
        aucunePhraseRetiree();
        expect(createServiceCategoryAction).not.toHaveBeenCalled();
      });
    }
  }
});

describe('les réglages de l’établissement disent le refus de pays du contrat (#1388)', () => {
  /**
   * Un pays **inventé** et non mal formé — « ZZ » a bien la forme attendue.
   *
   * C'est la valeur que la recette de #1330 avait enregistrée, et le refus est le
   * même dans les deux cas : `isCountryCodeAlpha2` juge l'un et l'autre, et
   * `identifier.countryCode` est la phrase que le contrat y pose. Le catalogue en
   * portait une copie mot pour mot, dans les deux langues.
   */
  for (const locale of LANGUES) {
    it(`annonce le pays refusé avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<TenantSettingsForm tenant={SALON} tenantSlug="salon-zen" />);

      await saisir(user, 'tenant-country', 'ZZ');

      await waitFor(() => {
        expect(messageDuChamp('tenant-country')).toBe(
          normaliser(validationMessage('identifier.countryCode', locale)),
        );
      });
      aucunePhraseRetiree();
      expect(updateTenantSettingsAction).not.toHaveBeenCalled();
    });
  }
});

describe('l’invitation du personnel marque toujours le numéro refusé (#1388)', () => {
  /**
   * La septième clé reprise, et la seule qui n'était affichée par personne.
   *
   * `invite.phoneInvalid` redisait `identifier.phone` dans les deux langues, et le
   * formulaire ne la servait qu'à travers une table de traduction que `PhoneField`
   * court-circuite : le champ écrit **sa** phrase quand il est marqué invalide, et
   * elle nomme le pays choisi (#825). Ce que #1388 change est donc le motif rangé
   * en état — une `issue` du contrat au lieu d'une clé de catalogue —, et ce que ce
   * cas mesure est que le marquage survit : le champ porte toujours un message,
   * c'est celui du champ, et il suit la langue.
   */
  for (const locale of LANGUES) {
    it(`marque le numéro et écrit la phrase du champ en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(<StaffInviteForm tenantSlug="salon-zen" />);

      // Un indicatif suivi de trop peu de chiffres : la forme passe, le numéro
      // n'est attribuable dans aucun plan de numérotation.
      await saisir(user, 'invitation-telephone', '+1415555');
      await user.click(screen.getByRole('button', { name: LIBELLES[locale].inviteSubmit }));

      await waitFor(() => {
        expect(messageDuChamp('invitation-telephone')).toBe(
          normaliser(phoneInvalidMessage('+1415555', 'US', locale)),
        );
      });
      aucunePhraseRetiree();
      expect(inviteStaffAccountAction).not.toHaveBeenCalled();
    });
  }
});

describe('la grille d’horaires dit le recouvrement du contrat (#1388)', () => {
  /**
   * La huitième clé, et la seule que n'écrivait pas un formulaire.
   *
   * `admin-staff.schedule.overlap` redisait `availability.scheduleOverlap` mot pour
   * mot dans les **deux** langues, et elle ne venait pas d'un résolveur de
   * formulaire mais de `scheduleRefusalMessage` (`lib/admin/staff-schedule.ts`), un
   * validateur pur lu hors de React. C'est ce qui l'avait fait rester en dispense
   * quand #1388 a repris les sept autres — et c'est ce que ce cas referme : le
   * module rend désormais `validationMessage('availability.scheduleOverlap', locale)`,
   * et la clé a quitté les deux catalogues.
   *
   * ## Pourquoi ce refus-là paraît en bandeau et non sous un champ
   *
   * Un recouvrement met en cause **deux** lignes : l'imputer à l'une des deux ferait
   * chercher la faute au mauvais endroit, et `validateScheduleRows` rend donc
   * `rowId: null` — ce que l'éditeur traduit par une `Notification` au-dessus de la
   * grille, depuis #1354 et non depuis ce ticket. Les quatre écrans dont le
   * troisième critère exige un message **sous le champ** sont les quatre
   * formulaires ci-dessus ; celui-ci est le cinquième, et sa place est celle que le
   * contrat lui donne.
   */
  const RECOUVREMENT: StaffSchedule = {
    staffId: '22222222-2222-4222-8222-222222222222',
    timezone: 'Europe/Paris',
    entries: [
      { weekday: 1, startsAt: '09:00', endsAt: '13:00' },
      { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
    ],
  };

  function grille(): ReactElement {
    return (
      <StaffScheduleEditor
        schedule={RECOUVREMENT}
        staffId={RECOUVREMENT.staffId}
        tenantSlug="salon-zen"
      />
    );
  }

  /**
   * La phrase du bandeau de refus, ou `null` si aucun n'est affiché.
   *
   * Le **corps** du bandeau, et non son titre : `Notification` rend les deux en
   * `<p>`, le titre portant `spa-notification__title`. C'est le corps qui dit la
   * phrase du contrat ; le titre, lui, reste une clé de catalogue (« Semaine non
   * enregistrée »), et ce n'est pas un refus mais un titre — voir `estUnTitre` dans
   * `messages-glossary.test.ts`.
   */
  function messageDuBandeau(): string | null {
    const element = document.querySelector(
      '.spa-notification__content p:not(.spa-notification__title)',
    );

    return element === null ? null : normaliser(element.textContent ?? '');
  }

  for (const locale of LANGUES) {
    it(`annonce le recouvrement avec la phrase du contrat en « ${locale} »`, async () => {
      fixerLangue(locale);
      const user = frappe();
      render(grille());

      await user.click(screen.getByRole('button', { name: LIBELLES[locale].scheduleSave }));

      await waitFor(() => {
        expect(messageDuBandeau()).toBe(
          normaliser(validationMessage('availability.scheduleOverlap', locale)),
        );
      });
      aucunePhraseRetiree();
      // Le verdict est celui du contrat, rejoué côté écran : aucun appel ne part.
      expect(setStaffScheduleAction).not.toHaveBeenCalled();
    });
  }

  /**
   * Le rejeu — ce que la garde statique du glossaire ne peut pas voir.
   *
   * L'éditeur garde le **motif** en état depuis #1354, et la phrase s'écrit au
   * rendu : c'est précisément ce qui fait que le passage au contrat ne casse rien
   * ici. Ce cas l'éprouve plutôt que de le supposer — le sélecteur de langue rejoue
   * la route sans démonter la grille, et le bandeau doit suivre.
   */
  it('rejoue le recouvrement dans la nouvelle langue, sans démonter la grille', async () => {
    const user = frappe();
    const { enAnglais } = monter(grille);

    await user.click(screen.getByRole('button', { name: LIBELLES.fr.scheduleSave }));

    await waitFor(() => {
      expect(messageDuBandeau()).toBe(
        normaliser(validationMessage('availability.scheduleOverlap', 'fr')),
      );
    });

    enAnglais();

    await waitFor(() => {
      expect(messageDuBandeau()).toBe(
        normaliser(validationMessage('availability.scheduleOverlap', 'en')),
      );
    });
    aucunePhraseRetiree();
    expect(setStaffScheduleAction).not.toHaveBeenCalled();
  });
});
