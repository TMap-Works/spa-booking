import {
  CATALOG_ERROR_CODES,
  ERROR_CODES,
  PASSWORD_MIN_LENGTH,
  errorMessage,
  validationMessage,
  validationPhrases,
  type Service,
  type ServiceCategory,
} from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { LoginForm } from '@/app/(account)/[tenantSlug]/compte/components/login-form';
import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';
import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';
import { StaffInviteForm } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-invite-form';
import { SalonFinder } from '@/components/home/salon-finder';
import { PhoneCountryProvider } from '@/components/ui/phone-country';
/*
 * Les phrases que ces écrans écrivent en propre sont **lues** dans les deux
 * catalogues, jamais recopiées ici : une suite qui citerait le littéral
 * resterait verte le jour où l'écran cesserait de consulter la table. Même règle
 * que pour celles du contrat, lues dans `validationPhrases` et `errorMessage`.
 */
import adminCatalogEn from '@/messages/en/admin-catalog.json';
import bookingEn from '@/messages/en/booking.json';
import adminCatalogFr from '@/messages/fr/admin-catalog.json';
import bookingFr from '@/messages/fr/booking.json';

/**
 * Un message **de champ** déjà à l'écran suit la langue — #1354.
 *
 * ## Le défaut que cette suite referme
 *
 * #1327 avait sorti les phrases des états de composant : ce qui va en état est
 * un code, la phrase s'écrit au rendu. Il avait laissé de côté, à dessein, les
 * messages **sous les champs**. Le sélecteur de langue pose un cookie et laisse
 * Next rejouer la route sans navigation (`i18n/actions.ts`) : le bandeau du
 * formulaire basculait, les messages des champs restaient dans l'ancienne
 * langue. « Enter a valid email address. » sous une étiquette « Adresse
 * e-mail », et l'inverse.
 *
 * Trois sources les produisent, et cette suite éprouve les trois :
 *
 * - **zod**, dont la phrase est calculée à la validation puis rangée. Le remède
 *   est de rejouer la validation des champs déjà fautifs — et d'eux seuls ;
 * - **l'écran**, qui pose un refus de l'API sur un champ (`slug` déjà pris).
 *   Aucune validation locale ne saurait le retrouver : il est rangé par son
 *   **code** et réécrit ;
 * - une **action serveur**, dont `useActionState` garde le résultat. La phrase y
 *   était résolue côté serveur : ce qui en sort est désormais un motif, écrit au
 *   rendu (`app/actions.ts`, `components/home/salon-finder.tsx`).
 *
 * ## Ce que la suite garde en ligne de mire
 *
 * Les trois garanties du deuxième critère d'acceptation, et pas une de moins :
 * la phrase suit la langue, **aucun message n'apparaît sur un champ jamais
 * rempli**, et **aucun refus posé par l'API n'est effacé** par le rejeu. Les
 * deux dernières sont ce qui rendait l'arbitrage difficile ; ne vérifier que la
 * première laisserait passer les deux régressions qui coûtent le plus.
 *
 * `rerender` et non un second `render` — c'est le geste réel : le même arbre se
 * rend à nouveau, **avec son état**. Un `render` neuf remonterait le composant
 * et repartirait d'un état vide, donc prouverait le contraire de ce qu'on
 * cherche. L'élément est refabriqué à chaque rendu (`vue()` et non `vue`), sans
 * quoi React court-circuiterait la réconciliation sur l'identité de l'élément et
 * le composant ne se rendrait pas du tout.
 */

vi.mock('next-intl', () => nextIntlMobile());

const loginAction = vi.fn();
const registerAction = vi.fn();
const inviteStaffAccountAction = vi.fn();
const updateServiceAction = vi.fn();
const openSalonAction = vi.fn();

vi.mock('@/app/actions', () => ({
  openSalonAction: (...args: unknown[]) => openSalonAction(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  loginAction: (...args: unknown[]) => loginAction(...args),
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  inviteStaffAccountAction: (...args: unknown[]) => inviteStaffAccountAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: vi.fn(),
  updateServiceAction: (...args: unknown[]) => updateServiceAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/salon-des-lilas/admin/catalogue/massage-suedois',
}));

beforeEach(() => {
  fixerLangue('fr');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

const SLUG = 'salon-des-lilas';

/** Monte un écran, et rend de quoi le **rejouer dans l'autre langue**. */
function monter(vue: () => ReactElement): { readonly enAnglais: () => void } {
  const { rerender } = render(vue());

  return {
    enAnglais: () => {
      fixerLangue('en');
      rerender(vue());
    },
  };
}

/**
 * Le message porté par un champ, ou `null` s'il n'en porte aucun.
 *
 * Cherché par l'**identifiant** que `Field`, `TextArea` et `PasswordField`
 * donnent tous les trois à leur message — `${id}-error`, celui que porte
 * `aria-describedby` — et non par le texte : l'étiquette est traduite elle
 * aussi, et un `getByText` ferait échouer la seconde moitié de chaque cas sur la
 * traduction de l'étiquette au lieu du rejeu du message.
 */
function messageDuChamp(id: string): string | null {
  const element = document.querySelector(`#${id}-error`);

  return element === null ? null : (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** Combien de champs portent un message, tous contrôles confondus. */
function nombreDeMessages(): number {
  return document.querySelectorAll('.spa-field__error, .spa-select__error').length;
}

/**
 * La même normalisation d'espaces que `messageDuChamp`, appliquée à l'attendu.
 *
 * Les phrases françaises portent des espaces insécables autour des guillemets ;
 * `\s` les confond avec une espace ordinaire, et comparer un texte normalisé à
 * un littéral qui ne l'est pas échouerait sur la typographie plutôt que sur la
 * langue.
 */
function normaliser(phrase: string): string {
  return phrase.replace(/\s+/gu, ' ').trim();
}

describe('connexion de l’espace client', () => {
  /**
   * Le cas le plus nu : une phrase du contrat, dite par `zodErrorMap`, sous un
   * champ que la cliente a quitté.
   *
   * Le second `expect` est la garantie qui coûtait l'arbitrage : le mot de passe
   * n'a jamais été rempli, et la bascule ne doit pas le lui reprocher. Un
   * `trigger()` sans argument — la correction la plus courte — aurait fait
   * apparaître « Ce champ est obligatoire. » sous un champ que personne n'a
   * touché.
   */
  it('traduit le message du champ e-mail, sans en inventer un sur le mot de passe', async () => {
    const user = userEvent.setup();
    const { enAnglais } = monter(() => <LoginForm tenantSlug={SLUG} notice={null} />);

    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille-sans-arobase');
    // `mode: 'onTouched'` : la validation a lieu quand on quitte le champ.
    await user.tab();

    /*
     * La phrase est celle que le **schéma** nomme — `emailSchema` pose la clé
     * `identifier.email` depuis #1232 —, et non la tournure générique de
     * `zodErrorMap`. C'est le chemin le plus exigeant pour ce ticket : la clé et
     * ses bornes voyagent dans les `params` de l'`issue`, et c'est en les
     * relisant que la phrase se réécrit dans l'autre langue.
     */
    await waitFor(() => {
      expect(messageDuChamp('login-email')).toBe(validationMessage('identifier.email', 'fr'));
    });
    expect(messageDuChamp('login-password')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('login-email')).toBe(validationMessage('identifier.email', 'en'));
    });
    expect(messageDuChamp('login-password')).toBeNull();
  });
});

describe('inscription de l’espace client', () => {
  it('traduit le message d’un mot de passe trop court déjà affiché', async () => {
    const user = userEvent.setup();
    const { enAnglais } = monter(() => (
      <PhoneCountryProvider country="FR">
        <RegisterForm tenantSlug={SLUG} />
      </PhoneCountryProvider>
    ));

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'trop-court');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    // La borne est celle du contrat, interpolée : la lire de `validationPhrases`
    // est ce qui fait échouer la suite si la phrase change de langue sans
    // prévenir.
    await waitFor(() => {
      expect(messageDuChamp('register-password')).toBe(
        validationPhrases('fr').tooShort(PASSWORD_MIN_LENGTH),
      );
    });
    // Rien n'est parti vers le serveur : c'est bien le champ qui a refusé.
    expect(registerAction).not.toHaveBeenCalled();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('register-password')).toBe(
        validationPhrases('en').tooShort(PASSWORD_MIN_LENGTH),
      );
    });
  });
});

describe('invitation du personnel', () => {
  /**
   * Ce formulaire n'emploie pas `react-hook-form` : il `safeParse` lui-même et
   * range le résultat. Ce qu'il range est donc l'`issue`, et la phrase s'écrit au
   * rendu — il n'y a rien à rejouer, et la bascule est immédiate.
   */
  it('traduit les messages des champs obligatoires déjà affichés', async () => {
    const user = userEvent.setup();
    const { enAnglais } = monter(() => <StaffInviteForm tenantSlug={SLUG} />);

    await user.click(screen.getByRole('button', { name: /Inviter/ }));

    await waitFor(() => {
      expect(messageDuChamp('invitation-prenom')).toBe(validationPhrases('fr').required);
    });
    expect(messageDuChamp('invitation-nom')).toBe(validationPhrases('fr').required);
    expect(messageDuChamp('invitation-email')).toBe(validationMessage('identifier.email', 'fr'));
    expect(inviteStaffAccountAction).not.toHaveBeenCalled();

    enAnglais();

    expect(messageDuChamp('invitation-prenom')).toBe(validationPhrases('en').required);
    expect(messageDuChamp('invitation-nom')).toBe(validationPhrases('en').required);
    expect(messageDuChamp('invitation-email')).toBe(validationMessage('identifier.email', 'en'));
  });
});

describe('fiche d’une prestation', () => {
  const categories: ServiceCategory[] = [
    {
      id: '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60',
      slug: 'soins-du-visage',
      name: 'Soins du visage',
      description: null,
      isActive: true,
    },
  ];

  const prestation: Service = {
    id: 'b7e1c2d3-2222-4c53-8f0e-1b2c3d4e5f60',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: 'Un classique.',
    category: { id: categories[0]!.id, slug: 'soins-du-visage', name: 'Soins du visage' },
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 5,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    assignedStaffCount: 1,
    activeAssignedStaffCount: 1,
  };

  function fiche(): ReactElement {
    return (
      <ServiceForm
        tenantSlug={SLUG}
        currency="EUR"
        categories={categories}
        service={prestation}
      />
    );
  }

  /**
   * La phrase vient du catalogue de cet écran, et non du contrat : le
   * formulaire passe ses propres messages à son schéma (#849). Elle se démodait
   * exactement comme celles du contrat, puisque c'est la validation qui les fige
   * toutes les deux.
   *
   * Le compte de messages est la seconde moitié du cas : un seul champ est
   * fautif avant la bascule, et il doit en rester un seul après. Sept autres
   * champs attendent, dont deux vides et licites.
   */
  it('traduit le message d’un champ obligatoire, et n’en ajoute sur aucun autre', async () => {
    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.clear(screen.getByLabelText(/^Nom/));
    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));

    await waitFor(() => {
      expect(messageDuChamp('service-name')).toBe(adminCatalogFr.form.errors.nameRequired);
    });
    expect(nombreDeMessages()).toBe(1);
    expect(updateServiceAction).not.toHaveBeenCalled();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('service-name')).toBe(adminCatalogEn.form.errors.nameRequired);
    });
    expect(nombreDeMessages()).toBe(1);
  });

  /**
   * Le refus de l'**API** posé sur un champ : l'autre moitié de l'arbitrage.
   *
   * Rejouer la validation de tous les champs fautifs l'aurait effacé — la saisie
   * est licite, c'est le voisin qui porte déjà cette adresse, et aucun schéma
   * local ne le sait. Il est donc rangé par son code et réécrit, ce qui l'exclut
   * du rejeu. Le cas exige les deux choses à la fois : la phrase est traduite,
   * **et** elle est encore là.
   */
  it('traduit le conflit d’adresse rendu par l’API, sans l’effacer', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      // Le code que l'API **rend** : `ServiceSlugTakenError` pose
      // `SERVICE_SLUG_TAKEN` en 409, et jamais le `CONFLICT` générique (#1367).
      code: CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN,
      message: errorMessage(CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));

    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogFr.form.errors.slugTaken);
    });
    // Sur le champ qui se corrige, et non en bandeau au-dessus du formulaire.
    expect(document.querySelector('.spa-notification--danger')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogEn.form.errors.slugTaken);
    });
    expect(nombreDeMessages()).toBe(1);
  });

  /**
   * Le refus de l'API **cède la place** dès que le schéma parle du même champ.
   *
   * L'adresse reprise mais mal écrite est refusée par le résolveur, dont le
   * message remplace celui de l'API sur ce champ. Le code du conflit, lui, est
   * encore dans la table du crochet : le réécrire à la bascule afficherait « une
   * autre prestation porte déjà cette adresse » sur une saisie dont ce qui
   * cloche est la **forme**, et priverait le champ du rejeu qui traduit ce que
   * zod a dit.
   */
  it('laisse le refus de forme parler quand l’adresse est reprise mal écrite', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      // Le code que l'API **rend** : `ServiceSlugTakenError` pose
      // `SERVICE_SLUG_TAKEN` en 409, et jamais le `CONFLICT` générique (#1367).
      code: CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN,
      message: errorMessage(CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));
    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogFr.form.errors.slugTaken);
    });

    const adresse = screen.getByLabelText(/Adresse publique/);
    await user.clear(adresse);
    await user.type(adresse, 'Pas Un Slug!');
    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogFr.form.errors.slug);
    });

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogEn.form.errors.slug);
    });
    expect(nombreDeMessages()).toBe(1);
  });

  /**
   * Les deux origines **en même temps** — le cas qui départage vraiment.
   *
   * Tant qu'un seul refus est à l'écran, rien ne prouve que le rejeu épargne
   * celui que l'API a posé : il n'y a rien à rejouer. Ici la durée est fautive
   * *et* l'adresse est prise. La bascule doit traduire les deux, chacun par son
   * chemin — `trigger('durationMinutes')` pour l'un, réécriture depuis le code
   * pour l'autre —, et n'effacer ni l'un ni l'autre. C'est exactement ce que
   * l'issue redoutait : un rejeu sans exclusion aurait trouvé l'adresse licite et
   * emporté le refus du serveur.
   */
  it('traduit un refus de saisie et un refus de l’API posés sur deux champs', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      // Le code que l'API **rend** : `ServiceSlugTakenError` pose
      // `SERVICE_SLUG_TAKEN` en 409, et jamais le `CONFLICT` générique (#1367).
      code: CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN,
      message: errorMessage(CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));
    await waitFor(() => {
      expect(messageDuChamp('service-slug')).toBe(adminCatalogFr.form.errors.slugTaken);
    });

    // La durée vidée après coup : le formulaire est soumis, donc chaque frappe
    // revalide le champ qu'on touche — et lui seul.
    await user.clear(screen.getByLabelText(/Durée/));
    await waitFor(() => {
      expect(messageDuChamp('service-duration')).toBe(adminCatalogFr.form.errors.minutes);
    });
    expect(messageDuChamp('service-slug')).toBe(adminCatalogFr.form.errors.slugTaken);

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('service-duration')).toBe(adminCatalogEn.form.errors.minutes);
    });
    expect(messageDuChamp('service-slug')).toBe(adminCatalogEn.form.errors.slugTaken);
    expect(nombreDeMessages()).toBe(2);
  });

  /**
   * Le code lu est celui que l'API **rend**, et non le `CONFLICT` générique —
   * #1367.
   *
   * L'écran branchait `postFieldRefusal('slug', …)` sur `ERROR_CODES.CONFLICT`,
   * que ces routes ne servent jamais : le conflit d'adresse partait donc au
   * bandeau, le champ restait muet, et le chemin que les trois cas ci-dessus
   * éprouvent n'était pas atteint en production. Ce cas-ci le fige dans les deux
   * sens — `SERVICE_SLUG_TAKEN` se pose sur le champ (au-dessus), un `CONFLICT`
   * qui arriverait malgré tout reste au bandeau.
   */
  it('laisse au bandeau un conflit qui ne nomme pas l’adresse', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.CONFLICT,
      message: errorMessage(ERROR_CODES.CONFLICT, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));

    await waitFor(() => {
      expect(document.querySelector('.spa-notification--danger')?.textContent).toContain(
        errorMessage(ERROR_CODES.CONFLICT, 'fr'),
      );
    });
    // Rien sous le champ : ce refus ne dit pas que l'adresse est prise, et
    // l'y poser aurait envoyé corriger une saisie qui n'a rien de fautif.
    expect(messageDuChamp('service-slug')).toBeNull();

    enAnglais();

    await waitFor(() => {
      expect(document.querySelector('.spa-notification--danger')?.textContent).toContain(
        errorMessage(ERROR_CODES.CONFLICT, 'en'),
      );
    });
  });
});

describe('accès à un salon depuis l’accueil', () => {
  /**
   * La troisième origine d'un message de champ : une **action serveur**, dont
   * `useActionState` garde le résultat d'une soumission à l'autre.
   *
   * Elle résolvait la phrase côté serveur, dans la langue de la soumission
   * (#1233) — et cette phrase-là ne bougeait plus jamais, puisque le sélecteur
   * de langue rejoue la route sans démonter le formulaire. L'action rend
   * désormais le motif (`'unknown'`), et l'écran l'écrit au rendu.
   *
   * Le second `expect` est ce qui distingue le remède de sa contrefaçon : la
   * phrase est **réécrite**, pas redemandée. Rejouer l'action à la bascule
   * aurait traduit le message tout en relançant un appel réseau à chaque
   * changement de langue.
   */
  it('traduit le refus rendu par l’action serveur, sans la rejouer', async () => {
    openSalonAction.mockResolvedValue({
      address: 'Salon Fantôme',
      fieldRefusal: 'unknown',
      formRefusal: null,
    });
    const attendu = (modele: string): string =>
      normaliser(modele.replace('{address}', 'Salon Fantôme'));

    const user = userEvent.setup();
    const { enAnglais } = monter(() => (
      <SalonFinder initialAddress="Salon Fantôme" title="Accéder à mon salon" />
    ));

    // La première porte — « Prendre rendez-vous », celle que la touche Entrée
    // déclencherait aussi.
    await user.click(screen.getAllByRole('button')[0]!);

    await waitFor(() => {
      expect(messageDuChamp('acces-adresse')).toBe(attendu(bookingFr.home.finder.errors.unknown));
    });
    expect(openSalonAction).toHaveBeenCalledTimes(1);

    enAnglais();

    await waitFor(() => {
      expect(messageDuChamp('acces-adresse')).toBe(attendu(bookingEn.home.finder.errors.unknown));
    });
    expect(openSalonAction).toHaveBeenCalledTimes(1);
  });
});
