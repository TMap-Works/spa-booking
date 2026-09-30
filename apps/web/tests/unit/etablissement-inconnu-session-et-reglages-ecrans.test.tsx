import {
  ERROR_CODES,
  LOCALES,
  errorMessage,
  type Locale,
  type SessionUser,
  type Tenant,
  type TenantBilling,
} from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Les écrans de la session et des réglages nomment l'établissement — #1379,
 * quatrième critère.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * `etablissement-inconnu-session-et-reglages.test.ts` exerce les **vraies**
 * actions des deux derniers modules : elle prouve qu'elles rendent
 * `TENANT_NOT_FOUND`. Celle-ci monte les écrans qui reçoivent ce refus et leur
 * tend, elle prouve qu'ils le **nomment**, dans les deux langues. Aucune des deux
 * ne suffit seule — la première laisse ouverte la possibilité d'un écran qui
 * écraserait la phrase, la seconde celle d'un refus qu'aucune action ne produit.
 *
 * ## Les cinq écrans, et le sixième qui n'affiche rien
 *
 * Un par site repris, et chacun a une **forme de repli différente**, ce qui est ce
 * qui justifie de les monter tous les cinq plutôt qu'un seul : la connexion trie
 * sur une `Map` de codes et ajoute son propre titre neutre, l'invitation sur un
 * `Set`, l'abonnement sur un objet indexé, les réglages passent par
 * `fieldRefusalMessage` — la voie des refus de champ —, et la langue du compte
 * n'a aucune table du tout. Cinq chemins vers `errorMessage(code, locale)`, cinq
 * occasions distinctes de l'avaler.
 *
 * Le sixième site, `adminLogoutAction`, n'a pas d'écran à mesurer :
 * `admin-logout-button.tsx` ne lit pas le résultat de son action et part vers
 * l'écran de connexion quoi qu'elle rende. C'est le comportement d'avant ce
 * ticket comme d'après — il n'affichait pas davantage l'ancienne phrase — et le
 * dire vaut mieux que de laisser croire au compte rond. Ce que ce ticket lui
 * garantit est mesuré dans l'autre suite : le refus précède la révocation, si
 * bien qu'un slug illisible n'efface pas les cookies d'une session valable.
 *
 * ## Deux moitiés par cas
 *
 * La phrase qui nomme l'établissement **et** l'absence de la tournure générique
 * du refus de saisie — celle que ces écrans affichaient jusqu'ici, faute d'un code
 * qui dise autre chose. La première seule laisserait passer un écran qui affiche
 * les deux ; la seconde seule, un écran qui n'affiche plus rien.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat, les
 * catalogues du dépôt pour les libellés — et jamais recopiées : un littéral
 * resterait vert le jour où l'écran cesserait de consulter la table.
 */

const adminLoginAction = vi.fn();
const adminLogoutAction = vi.fn();
const adminAcceptInvitationAction = vi.fn();
const updateTenantSettingsAction = vi.fn();
const openBillingPortalAction = vi.fn();
const saveMemberLocaleAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: (...args: unknown[]) => adminLoginAction(...args),
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
  adminAcceptInvitationAction: (...args: unknown[]) => adminAcceptInvitationAction(...args),
  updateTenantSettingsAction: (...args: unknown[]) => updateTenantSettingsAction(...args),
  startBillingCheckoutAction: vi.fn(),
  openBillingPortalAction: (...args: unknown[]) => openBillingPortalAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/reglages/actions', () => ({
  saveMemberLocaleAction: (...args: unknown[]) => saveMemberLocaleAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

vi.mock('next-intl', () => nextIntlMobile());

import { AdminInvitationForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-invitation-form';
import { AdminLoginForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-login-form';
import { BillingPanel } from '@/app/(admin)/[tenantSlug]/admin/components/billing-panel';
import { TenantSettingsForm } from '@/app/(admin)/[tenantSlug]/admin/components/tenant-settings-form';
import { MemberLocaleForm } from '@/app/(admin)/[tenantSlug]/admin/reglages/components/member-locale-form';

const SLUG = 'maison-lotus';

/**
 * Le refus tel qu'`unknownTenant()` le rend — code du contrat, aucun `details`.
 *
 * L'absence de `details` n'est pas un oubli : c'est la propriété d'un refus opposé
 * par l'action avant tout appel, et c'est ce qui l'empêche d'être pris pour un
 * refus rapporté du corps d'erreur de l'API.
 */
function refusEtablissement(locale: Locale) {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
  } as const;
}

/** La phrase du contrat pour ce code, dans la langue du rendu. */
function phraseAttendue(locale: Locale): string {
  return errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);
}

/** Celle que ces écrans disaient à sa place, faute d'un code qui le nomme. */
function phraseEvincee(locale: Locale): string {
  return errorMessage(ERROR_CODES.VALIDATION_ERROR, locale);
}

/**
 * Un libellé du catalogue, lu là où l'écran le lit — le même `loadMessages` que
 * le serveur emploie.
 */
function libelle(locale: Locale, chemin: string): string {
  const trouve = chemin
    .split('.')
    .reduce<string | MessageTree | undefined>(
      (noeud, cle) => (typeof noeud === 'object' ? noeud[cle] : undefined),
      loadMessages(locale),
    );

  if (typeof trouve !== 'string') {
    throw new Error(`libellé absent du catalogue « ${locale} » : ${chemin}`);
  }

  return trouve;
}

/** Un libellé transformé en motif, pour un nom accessible qui porte autre chose. */
function debut(texte: string): RegExp {
  return new RegExp(`^${texte.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
}

const TENANT: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  defaultLocale: 'fr',
  isActive: true,
  receiptPrefix: 'TIC',
  taxRateBps: 0,
  openingHours: [{ weekday: 1, opensAt: '09:00', closesAt: '19:00' }],
};

const MEMBRE: SessionUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'adele@maison-lotus.test',
  role: 'staff',
  firstName: 'Adèle',
  lastName: 'Andria',
  phone: null,
  locale: null,
};

/** Un abonnement actif : le statut dont le geste ouvre le portail Stripe. */
const ABONNEMENT: TenantBilling = {
  status: 'active',
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  hasBillingAccount: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

describe.each([...LOCALES])('l’établissement inconnu, en « %s »', (locale) => {
  it('l’écran de connexion le nomme, sans accuser les identifiants', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    adminLoginAction.mockResolvedValue(refusEtablissement(locale));

    render(<AdminLoginForm notice={null} tenantSlug={SLUG} />);
    await user.type(
      screen.getByLabelText(debut(libelle(locale, 'admin-auth.login.email'))),
      'claire@maison-lotus.test',
    );
    await user.type(
      screen.getByLabelText(debut(libelle(locale, 'admin-auth.login.password'))),
      'MotDePasse123!',
    );
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-auth.login.submit')) }),
    );

    expect(await screen.findByText(phraseAttendue(locale))).toBeDefined();
    expect(screen.queryByText(phraseEvincee(locale))).toBeNull();
    // Le titre reste le repli neutre : ce refus n'est pas celui du couple saisi,
    // et le dire autrement enverrait corriger un mot de passe qui n'a rien (#759).
    expect(
      screen.getByText(libelle(locale, 'admin-auth.login.failures.unknownTitle')),
    ).toBeDefined();
    expect(
      screen.queryByText(libelle(locale, 'admin-auth.login.failures.invalidCredentials.title')),
    ).toBeNull();
  });

  it('l’écran d’activation d’invitation le nomme, plutôt que le lien périmé', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    adminAcceptInvitationAction.mockResolvedValue(refusEtablissement(locale));

    render(<AdminInvitationForm tenantSlug={SLUG} token="abc.def.ghi" />);
    await user.type(
      screen.getByLabelText(debut(libelle(locale, 'admin-auth.invitation.password'))),
      'mot-de-passe-de-test',
    );
    await user.type(
      screen.getByLabelText(debut(libelle(locale, 'admin-auth.invitation.confirmation'))),
      'mot-de-passe-de-test',
    );
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-auth.invitation.submit')) }),
    );

    expect(await screen.findByText(phraseAttendue(locale))).toBeDefined();
    expect(screen.queryByText(phraseEvincee(locale))).toBeNull();
    // Le seul refus que cet écran nomme lui-même est le lien dépensé : il ne doit
    // pas déborder sur un refus qui n'est pas le sien.
    expect(screen.queryByText(libelle(locale, 'admin-auth.invitation.expiredLink'))).toBeNull();
  });

  it('les réglages de l’établissement le nomment', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue(refusEtablissement(locale));

    render(<TenantSettingsForm tenant={TENANT} tenantSlug={SLUG} />);
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-settings.submit')) }),
    );

    expect(await screen.findByText(phraseAttendue(locale))).toBeDefined();
    expect(screen.queryByText(phraseEvincee(locale))).toBeNull();
    expect(screen.getByText(libelle(locale, 'admin-settings.verdict.failureTitle'))).toBeDefined();
  });

  it('la langue du compte connecté le nomme', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    saveMemberLocaleAction.mockResolvedValue(refusEtablissement(locale));

    render(<MemberLocaleForm profile={MEMBRE} tenantSlug={SLUG} />);
    // Le bouton reste inerte tant que rien n'a changé : il faut donc choisir une
    // langue avant de pouvoir soumettre.
    await user.selectOptions(
      screen.getByRole('combobox', { name: debut(libelle(locale, 'admin-settings.member.label')) }),
      'en',
    );
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-settings.member.submit')) }),
    );

    expect(await screen.findByText(phraseAttendue(locale))).toBeDefined();
    expect(screen.queryByText(phraseEvincee(locale))).toBeNull();
  });

  it('le panneau d’abonnement le nomme, plutôt qu’une session expirée', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    openBillingPortalAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <BillingPanel
        billing={ABONNEMENT}
        countryCode="MG"
        retour={null}
        tenantSlug={SLUG}
        timeZone={TENANT.timezone}
      />,
    );
    await user.click(
      screen.getByRole('button', {
        name: debut(libelle(locale, 'admin-subscription.status.active.action')),
      }),
    );

    expect(await screen.findByText(phraseAttendue(locale))).toBeDefined();
    expect(screen.queryByText(phraseEvincee(locale))).toBeNull();
    // Sa table de codes nomme la session expirée : un refus d'établissement ne
    // doit pas s'y confondre, ce qui aurait envoyé se reconnecter pour rien.
    expect(
      screen.queryByText(libelle(locale, 'admin-subscription.redirect.errors.session')),
    ).toBeNull();
    expect(
      screen.getByText(libelle(locale, 'admin-subscription.redirect.failureTitle')),
    ).toBeDefined();
  });
});

/**
 * …et le refus de saisie de chaque geste n'a rien perdu.
 *
 * Ce ticket ajoute un code à cinq sites, il ne change pas ce que les écrans font
 * des autres. Un seul suffit à le prouver, et c'est celui dont le repli est le plus
 * chargé — la connexion, seule à porter un titre par code : la règle est la même
 * pour les cinq, puisque ce qui décide de la phrase est le repli de `refusalMessage`,
 * écrit une fois (`lib/refusal.ts`).
 */
describe('le refus de saisie garde sa phrase', () => {
  it('la connexion dit toujours la tournure du refus de validation', async () => {
    const user = userEvent.setup();
    adminLoginAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'),
    });

    render(<AdminLoginForm notice={null} tenantSlug={SLUG} />);
    await user.type(
      screen.getByLabelText(debut(libelle('fr', 'admin-auth.login.email'))),
      'claire@maison-lotus.test',
    );
    await user.type(
      screen.getByLabelText(debut(libelle('fr', 'admin-auth.login.password'))),
      'MotDePasse123!',
    );
    await user.click(
      screen.getByRole('button', { name: debut(libelle('fr', 'admin-auth.login.submit')) }),
    );

    expect(await screen.findByText(phraseEvincee('fr'))).toBeDefined();
    expect(screen.queryByText(phraseAttendue('fr'))).toBeNull();
  });
});
