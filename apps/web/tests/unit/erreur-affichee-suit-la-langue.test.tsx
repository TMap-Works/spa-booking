import {
  ERROR_CODES,
  errorMessage,
  type Service,
  type ServiceCategory,
  type UtcInstant,
} from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { contact, contactAccount, presence, service, tenant } from './fixtures';

import { BillingPanel } from '@/app/(admin)/[tenantSlug]/admin/components/billing-panel';
import { ReportExportButton } from '@/app/(admin)/[tenantSlug]/admin/components/report-export-button';
import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';
import { StaffInviteForm } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-invite-form';
import { LoginForm } from '@/app/(account)/[tenantSlug]/compte/components/login-form';
import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';
import { BookingTunnel } from '@/app/(booking)/[tenantSlug]/reservation/booking-tunnel';
import { PhoneCountryProvider } from '@/components/ui/phone-country';
import { emptyBookingDraft, writeBookingDraft, type BookingDraft } from '@/lib/booking/draft';
/*
 * Les catalogues eux-mêmes, dans les deux langues.
 *
 * Les phrases que ces écrans écrivent en propre — « Connexion refusée », « Un
 * compte existe déjà pour cette adresse dans cet établissement » — n'ont pas
 * d'autre source que le catalogue : les recopier ici ferait deux écritures d'une
 * même phrase, et la suite resterait verte le jour où l'écran cesserait de la
 * lire. Même règle que pour les phrases du contrat, lues dans `errorMessage`.
 */
import accountEn from '@/messages/en/account.json';
import adminCatalogEn from '@/messages/en/admin-catalog.json';
import adminReportingEn from '@/messages/en/admin-reporting.json';
import adminStaffEn from '@/messages/en/admin-staff.json';
import adminSubscriptionEn from '@/messages/en/admin-subscription.json';
import accountFr from '@/messages/fr/account.json';
import adminCatalogFr from '@/messages/fr/admin-catalog.json';
import adminReportingFr from '@/messages/fr/admin-reporting.json';
import adminStaffFr from '@/messages/fr/admin-staff.json';
import adminSubscriptionFr from '@/messages/fr/admin-subscription.json';

/**
 * Un message déjà à l'écran suit la langue — #1327.
 *
 * ## Le défaut que cette suite referme
 *
 * Le sélecteur de langue pose un cookie et laisse Next **rejouer la route sans
 * navigation** (`i18n/actions.ts`) : les composants clients se rendent à
 * nouveau, leur état ne bouge pas. Six surfaces rangeaient le texte d'un refus
 * dans cet état-là — un `useState<string>` — et ce texte restait donc écrit dans
 * la langue d'avant, sous un titre qui, lui, suivait le rendu. Ce que la recette
 * du 2026-09-29 a vu, c'est « Sign-in refused » au-dessus d'« Adresse e-mail ou
 * mot de passe incorrect. ».
 *
 * Tout redevenait correct au rechargement, et c'est ce qui rendait le défaut
 * discret : aucune suite ne rechargeait.
 *
 * ## Ce qui est éprouvé, et comment
 *
 * `rerender` de `@testing-library/react` — et non un second `render` — parce que
 * c'est le geste réel : le même arbre se rend à nouveau, **avec son état**. Un
 * `render` neuf remonterait le composant et prouverait le contraire de ce qu'on
 * cherche, puisqu'un remontage repartirait d'un état vide.
 *
 * L'élément est refabriqué à chaque rendu (`vue()` et non `vue`) : React
 * court-circuite la réconciliation quand on lui repasse **le même objet
 * d'élément**, et le composant ne se rendrait pas du tout — une suite écrite
 * ainsi resterait verte sans rien avoir éprouvé.
 *
 * Chaque cas exige deux choses à la fois : la phrase française d'abord, puis
 * l'anglaise après bascule. La première seule laisserait passer un écran qui
 * n'affiche plus rien ; la seconde seule laisserait passer un écran figé en
 * anglais.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat,
 * les deux rendus du catalogue pour celles des écrans. Aucun littéral de
 * catalogue recopié : il resterait vert le jour où l'écran cesserait de
 * consulter la table.
 */

vi.mock('next-intl', () => nextIntlMobile());

const loginAction = vi.fn();
const registerAction = vi.fn();
const requestBooking = vi.fn();
const loadAvailabilityAction = vi.fn();
const requestCancellation = vi.fn();
const inviteStaffAccountAction = vi.fn();
const createReportExportAction = vi.fn();
const startBillingCheckoutAction = vi.fn();
const openBillingPortalAction = vi.fn();
const updateServiceAction = vi.fn();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  loginAction: (...args: unknown[]) => loginAction(...args),
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-request', () => ({
  requestBooking: (...args: unknown[]) => requestBooking(...args),
}));

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
}));

vi.mock(
  '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/cancellation-request',
  () => ({ requestCancellation: (...args: unknown[]) => requestCancellation(...args) }),
);

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  inviteStaffAccountAction: (...args: unknown[]) => inviteStaffAccountAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/reporting/actions', () => ({
  createReportExportAction: (...args: unknown[]) => createReportExportAction(...args),
  refreshReportExportAction: vi.fn(),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  startBillingCheckoutAction: (...args: unknown[]) => startBillingCheckoutAction(...args),
  openBillingPortalAction: (...args: unknown[]) => openBillingPortalAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: vi.fn(),
  updateServiceAction: (...args: unknown[]) => updateServiceAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/salon-des-lilas/admin/catalogue/nouveau',
}));

beforeEach(() => {
  fixerLangue('fr');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

const SLUG = 'salon-des-lilas';

/**
 * Monte un écran, et rend de quoi le **rejouer dans l'autre langue**.
 *
 * `enAnglais()` fait exactement ce que fait le sélecteur du rail : la langue
 * change, le même arbre se rend à nouveau, l'état reste en place.
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

/** Le texte d'une notification, par son ton — espaces ramenées à une forme. */
function notification(tone: 'danger' | 'warning'): string {
  const element = document.querySelector(`.spa-notification--${tone}`);

  return (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** Le refus affiché — l'encart rouge, et lui seul. */
function refus(): string {
  return notification('danger');
}

describe('connexion de l’espace client', () => {
  /**
   * Le cas exact du constat : « Sign-in refused » au-dessus d'« Adresse e-mail ou
   * mot de passe incorrect. ». Le titre suivait le rendu, le corps non.
   */
  it('traduit le refus d’identifiants déjà affiché', async () => {
    loginAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: errorMessage(ERROR_CODES.INVALID_CREDENTIALS, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => <LoginForm tenantSlug={SLUG} notice={null} />);

    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'mot-de-passe');
    await user.click(screen.getByRole('button', { name: /Se connecter/ }));

    await waitFor(() => {
      expect(refus()).toContain(accountFr.login.invalidCredentials);
    });

    expect(refus()).toContain(accountFr.login.failureTitle);

    enAnglais();

    // Le titre **et** le corps, dans la même langue : c'est le couple qui était
    // faux, et n'en vérifier qu'un laisserait passer l'écran mixte.
    expect(refus()).toContain(accountEn.login.failureTitle);
    expect(refus()).toContain(accountEn.login.invalidCredentials);
    expect(refus()).not.toContain(accountFr.login.invalidCredentials);
  });
});

describe('inscription de l’espace client', () => {
  it('traduit le refus d’adresse déjà inscrite déjà affiché', async () => {
    registerAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      message: errorMessage(ERROR_CODES.EMAIL_ALREADY_REGISTERED, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => (
      <PhoneCountryProvider country="FR">
        <RegisterForm tenantSlug={SLUG} />
      </PhoneCountryProvider>
    ));

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'mot-de-passe-long');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    await waitFor(() => {
      expect(refus()).toContain(accountFr.register.emailAlreadyRegistered);
    });

    expect(refus()).toContain(accountFr.register.failureTitle);

    enAnglais();

    expect(refus()).toContain(accountEn.register.failureTitle);
    expect(refus()).toContain(accountEn.register.emailAlreadyRegistered);
    expect(refus()).not.toContain(accountFr.register.emailAlreadyRegistered);
  });
});

describe('tunnel de réservation', () => {
  /** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
  const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;

  /** Le récapitulatif atteint, avec tout ce qu'il faut pour confirmer. */
  function brouillonAuRecapitulatif(): BookingDraft {
    return {
      ...emptyBookingDraft(),
      step: 'recapitulatif',
      serviceId: service.id,
      startsAt: MATIN,
      contact,
      // Sans propriétaire, le tunnel tient le brouillon pour celui d'une autre
      // cliente et en vide les coordonnées avant le premier rendu (#1151).
      contactAccount,
    };
  }

  /**
   * L'avis de créneau perdu — celui que la recette a vu rester en français.
   *
   * L'horaire qu'il rappelle est une **donnée** et non une phrase : il se
   * reformate avec le reste, dans la langue lue et le fuseau du salon.
   */
  it('traduit l’avis de créneau perdu déjà affiché, horaire compris', async () => {
    const draft = brouillonAuRecapitulatif();

    writeBookingDraft(tenant.slug, draft);
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { serviceId: service.id, timezone: tenant.timezone, days: [] },
    });
    requestBooking.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.SLOT_NO_LONGER_AVAILABLE,
      message: 'Slot lock 7f3a is already held by another transaction.',
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => (
      <BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={draft}
      />
    ));

    await user.click(await screen.findByRole('button', { name: /Confirmer la réservation/ }));
    await waitFor(() => {
      expect(notification('warning')).toContain('septembre');
    });

    const francais = notification('warning');

    expect(francais).toContain('09:00');

    enAnglais();

    const anglais = notification('warning');

    expect(anglais).toContain('September');
    expect(anglais).not.toContain('septembre');
    // Le message du serveur n'atteint l'écran dans aucune des deux langues.
    expect(`${francais}${anglais}`).not.toContain('7f3a');
  });
});

describe('invitation du personnel', () => {
  it('traduit le refus de l’API déjà affiché', async () => {
    inviteStaffAccountAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      message: errorMessage(ERROR_CODES.EMAIL_ALREADY_REGISTERED, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => <StaffInviteForm tenantSlug={SLUG} />);

    await user.type(screen.getByLabelText(/Prénom/), 'Hanta');
    await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
    await user.type(screen.getByLabelText(/Adresse électronique/), 'hanta@example.test');
    await user.click(screen.getByRole('button', { name: /Inviter/ }));

    await waitFor(() => {
      expect(refus()).toContain(errorMessage(ERROR_CODES.EMAIL_ALREADY_REGISTERED, 'fr'));
    });
    expect(refus()).toContain(adminStaffFr.invite.failureTitle);

    enAnglais();

    expect(refus()).toContain(adminStaffEn.invite.failureTitle);
    expect(refus()).toContain(errorMessage(ERROR_CODES.EMAIL_ALREADY_REGISTERED, 'en'));
    expect(refus()).not.toContain(errorMessage(ERROR_CODES.EMAIL_ALREADY_REGISTERED, 'fr'));
  });
});

describe('export de reporting', () => {
  const FENETRE = { from: '2026-08-31T22:00:00.000Z', to: '2026-09-30T22:00:00.000Z' };

  /** La zone d'état du bouton — la seule surface où le refus s'écrit. */
  function statut(): string {
    const element = document.querySelector('.spa-admin-report-export__status');

    return (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();
  }

  /**
   * Deux refus d'un coup : celui que l'écran nomme lui-même, et le générique qui
   * retombe sur la phrase du contrat. Le second est celui qui laissait vraiment
   * du français sous un écran anglais — il interpolait `result.message`.
   */
  it('traduit le refus d’export déjà affiché, nommé comme générique', async () => {
    createReportExportAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.REPORT_EXPORT_UNAVAILABLE,
      message: errorMessage(ERROR_CODES.REPORT_EXPORT_UNAVAILABLE, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => <ReportExportButton tenantSlug={SLUG} window={FENETRE} />);

    await user.click(screen.getByRole('button', { name: /Exporter en CSV/i }));
    await waitFor(() => {
      expect(statut()).toContain(adminReportingFr.export.unavailable);
    });

    enAnglais();

    // La phrase de cet écran, pas celle du contrat : l'export indisponible est
    // une **configuration**, et le catalogue le dit mieux qu'`errorMessage`.
    expect(statut()).toContain(adminReportingEn.export.unavailable);
    expect(statut()).not.toContain(adminReportingFr.export.unavailable);
  });

  it('traduit aussi le détail d’un refus que l’écran ne nomme pas', async () => {
    createReportExportAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.REPORT_WINDOW_TOO_WIDE,
      message: errorMessage(ERROR_CODES.REPORT_WINDOW_TOO_WIDE, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => <ReportExportButton tenantSlug={SLUG} window={FENETRE} />);

    await user.click(screen.getByRole('button', { name: /Exporter en CSV/i }));
    await waitFor(() => {
      expect(statut()).toContain(errorMessage(ERROR_CODES.REPORT_WINDOW_TOO_WIDE, 'fr'));
    });

    enAnglais();

    expect(statut()).toContain(errorMessage(ERROR_CODES.REPORT_WINDOW_TOO_WIDE, 'en'));
    expect(statut()).not.toContain(errorMessage(ERROR_CODES.REPORT_WINDOW_TOO_WIDE, 'fr'));
  });
});

describe('abonnement', () => {
  it('traduit le refus d’ouverture de Stripe déjà affiché', async () => {
    startBillingCheckoutAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
      message: errorMessage(ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(() => (
      <BillingPanel
        tenantSlug={SLUG}
        billing={{
          status: 'pending',
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          hasBillingAccount: false,
        }}
        retour={null}
        timeZone="America/Toronto"
        countryCode="CA"
      />
    ));

    await user.click(screen.getByRole('button', { name: /Démarrer mon essai/ }));
    await waitFor(() => {
      expect(refus()).toContain(adminSubscriptionFr.redirect.errors.unavailable);
    });

    expect(refus()).toContain(adminSubscriptionFr.redirect.failureTitle);

    enAnglais();

    expect(refus()).toContain(adminSubscriptionEn.redirect.failureTitle);
    expect(refus()).toContain(adminSubscriptionEn.redirect.errors.unavailable);
    expect(refus()).not.toContain(adminSubscriptionFr.redirect.errors.unavailable);
  });
});

describe('prix d’une prestation', () => {
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
   * Le champ de prix, **par son identifiant** et non par son étiquette.
   *
   * L'étiquette est traduite — « Prix (EUR) » puis « Price (EUR) » —, et la
   * chercher par son libellé français ferait échouer la seconde moitié de chaque
   * cas sur la traduction de l'étiquette au lieu du reformatage du montant.
   */
  function champPrix(): HTMLInputElement {
    const element = document.querySelector('#service-price');

    if (element === null) {
      throw new Error('le champ de prix est absent du rendu');
    }

    return element as HTMLInputElement;
  }

  function prix(): string {
    return champPrix().value;
  }

  /**
   * Deuxième critère d'acceptation : le champ numérique se reformate au
   * changement de langue. « 35,00 » sous un gabarit qui annonce « 35.00 » n'est
   * pas faux — `parseAmountInput` accepte les deux —, mais l'écran se contredit
   * à l'endroit exact où il demande de recopier une forme.
   */
  it('reformate le prix pré-rempli quand la langue change', () => {
    const { enAnglais } = monter(fiche);

    expect(prix()).toBe('35,00');

    enAnglais();

    expect(prix()).toBe('35.00');
  });

  it('reformate une saisie en cours, et dans les deux sens', async () => {
    const user = userEvent.setup();
    const { rerender } = render(fiche());

    await user.clear(champPrix());
    await user.type(champPrix(), '19,90');

    fixerLangue('en');
    rerender(fiche());
    expect(prix()).toBe('19.90');

    fixerLangue('fr');
    rerender(fiche());
    expect(prix()).toBe('19,90');
  });

  /**
   * Une saisie que la devise ne sait pas relire est **laissée telle quelle** : un
   * changement de langue ne doit pas effacer une frappe en cours, ni inventer un
   * prix à la place de celui qu'on est en train de taper.
   */
  it('laisse intacte une saisie que la devise ne sait pas relire', async () => {
    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.clear(champPrix());
    // Trois décimales pour une devise qui en porte deux : `parseAmountInput`
    // refuse plutôt que d'arrondir, et le champ doit donc rester tel quel.
    await user.type(champPrix(), '19,905');

    enAnglais();

    expect(prix()).toBe('19,905');
  });

  /**
   * Et l'aller-retour ne doit pas la **réinterpréter**.
   *
   * Une saisie laissée telle quelle est restée écrite dans la langue où elle a
   * été tapée : la référence de langue du champ ne peut donc pas avancer quand la
   * réécriture a été refusée. Sans cette précaution, « 19,905 » tapé en français
   * était relu au retour avec les séparateurs anglais, où la virgule groupe les
   * milliers — dix-neuf mille neuf cent cinq euros à la place de dix-neuf, et un
   * prix mille fois trop élevé enregistré sans que rien ne le signale.
   */
  it('ne réinterprète pas une saisie illisible au retour à la langue d’origine', async () => {
    const user = userEvent.setup();
    const { rerender } = render(fiche());

    await user.clear(champPrix());
    await user.type(champPrix(), '19,905');

    fixerLangue('en');
    rerender(fiche());
    expect(prix()).toBe('19,905');

    fixerLangue('fr');
    rerender(fiche());
    expect(prix()).toBe('19,905');
  });

  it('traduit le refus d’enregistrement déjà affiché', async () => {
    updateServiceAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'),
    });

    const user = userEvent.setup();
    const { enAnglais } = monter(fiche);

    await user.click(screen.getByRole('button', { name: adminCatalogFr.form.save }));
    await waitFor(() => {
      expect(refus()).toContain(errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'));
    });

    expect(refus()).toContain(adminCatalogFr.form.failureTitle);

    enAnglais();

    expect(refus()).toContain(adminCatalogEn.form.failureTitle);
    expect(refus()).toContain(errorMessage(ERROR_CODES.VALIDATION_ERROR, 'en'));
    expect(refus()).not.toContain(errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'));
  });
});
