import { ERROR_CODES, type TenantBilling } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingPanel } from '@/app/(admin)/[tenantSlug]/admin/components/billing-panel';
import { planPriceLabel } from '@/lib/plan';

/**
 * L'abonnement du salon en français et en anglais — #1105.
 *
 * La doublure de `next-intl` est celle de `signup-i18n.test.tsx`, et pour la
 * même raison : l'amorce des suites fixe la langue à `fr` (#845), or c'est le
 * **changement** de langue qui est ici la promesse du ticket.
 *
 * ## Ce qu'elle protège
 *
 * Les quatre statuts que le ticket nomme — essai, actif, impayé, résilié — plus
 * les deux que l'écran connaît par ailleurs, avec le geste que chacun propose.
 * Et deux choses qui ne sont pas des libellés : le **prix**, qui reste un entier
 * mis en forme selon la langue, et la **date d'échéance**, qui suit la langue
 * mais garde le fuseau du salon (`CLAUDE.md`, « Fuseaux horaires »).
 */

const state = vi.hoisted(() => ({ locale: 'fr' as 'fr' | 'en' }));

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('@/i18n/messages');

  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;

  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => state.locale,
    useTranslations: (namespace?: string) => {
      const key = `${state.locale}:${namespace ?? ''}`;
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const messages = loadMessages(state.locale);
      const made = translator(
        namespace === undefined
          ? { locale: state.locale, messages }
          : { locale: state.locale, messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

const startBillingCheckoutAction = vi.fn();
const openBillingPortalAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  startBillingCheckoutAction: (...args: unknown[]) => startBillingCheckoutAction(...args),
  openBillingPortalAction: (...args: unknown[]) => openBillingPortalAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  state.locale = 'fr';
});

afterEach(() => {
  cleanup();
  startBillingCheckoutAction.mockReset();
  openBillingPortalAction.mockReset();
  refresh.mockReset();
});

/** Le salon de référence : Montréal, donc un fuseau qui n'est pas celui d'ici. */
const TIME_ZONE = 'America/Toronto';
const COUNTRY = 'CA';

function billing(overrides: Partial<TenantBilling> = {}): TenantBilling {
  return {
    status: 'trialing',
    trialEndsAt: '2026-10-06T03:00:00.000Z',
    currentPeriodEndsAt: null,
    hasBillingAccount: true,
    ...overrides,
  };
}

function afficher(overrides: Partial<TenantBilling> = {}): void {
  render(
    <BillingPanel
      tenantSlug="maison-lotus"
      billing={billing(overrides)}
      retour={null}
      timeZone={TIME_ZONE}
      countryCode={COUNTRY}
    />,
  );
}

/** Le texte d'espaces insécables ramené à une seule forme — voir `signup-i18n`. */
function normalise(text: string | null): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim();
}

describe('les statuts de l’abonnement sont traduits (#1105)', () => {
  const CAS = [
    {
      statut: 'pending',
      fr: 'Votre essai gratuit n’a pas encore commencé',
      en: 'Your free trial has not started yet',
      action: { fr: 'Démarrer mon essai gratuit', en: 'Start my free trial' },
    },
    {
      statut: 'active',
      fr: 'Abonnement actif',
      en: 'Subscription active',
      action: { fr: 'Gérer mon abonnement', en: 'Manage my subscription' },
    },
    {
      statut: 'past_due',
      fr: 'Le dernier paiement a échoué',
      en: 'The last payment failed',
      action: { fr: 'Mettre à jour ma carte', en: 'Update my card' },
    },
    {
      statut: 'canceled',
      fr: 'Abonnement résilié',
      en: 'Subscription cancelled',
      action: { fr: 'Réactiver mon abonnement', en: 'Reactivate my subscription' },
    },
    {
      statut: 'managed',
      fr: 'Salon accompagné par la plateforme',
      en: 'Salon supported by the platform',
      action: null,
    },
  ] as const;

  it.each(CAS)('rend « $statut » en français', ({ statut, fr, action }) => {
    afficher({ status: statut });

    expect(screen.getByText(fr)).toBeDefined();

    if (action === null) {
      // Un salon accompagné n'a rien à régler : lui proposer un geste de
      // paiement serait lui promettre une facture qui n'existe pas.
      expect(screen.queryByRole('button')).toBeNull();
    } else {
      expect(screen.getByRole('button', { name: action.fr })).toBeDefined();
    }
  });

  it.each(CAS)('rend « $statut » en anglais', ({ statut, fr, en, action }) => {
    state.locale = 'en';
    afficher({ status: statut });

    expect(screen.getByText(en)).toBeDefined();
    expect(screen.queryByText(fr)).toBeNull();

    if (action !== null) {
      expect(screen.getByRole('button', { name: action.en })).toBeDefined();
    }
  });
});

describe('le prix et l’échéance suivent la langue, le fuseau reste celui du salon (#1105)', () => {
  it('annonce le prix mensuel dans la langue lue', () => {
    afficher({ status: 'pending' });
    // Le montant et sa période sont deux `<span>` d'un même paragraphe : c'est
    // lui qu'il faut lire, pas l'un des deux.
    const ligne = screen.getByText(/mois, sans engagement/u).parentElement;

    expect(normalise(ligne?.textContent ?? null)).toContain(
      normalise(planPriceLabel({ locale: 'fr', countryCode: COUNTRY })),
    );
  });

  it('annonce le même prix, écrit pour l’anglais', () => {
    state.locale = 'en';
    afficher({ status: 'pending' });
    const ligne = screen.getByText(/month, no commitment/u).parentElement;

    expect(normalise(ligne?.textContent ?? null)).toContain(
      normalise(planPriceLabel({ locale: 'en', countryCode: COUNTRY })),
    );
  });

  it('écrit la fin d’essai en français, dans le fuseau du salon', () => {
    // 2026-10-06T03:00Z est encore le 5 octobre à Toronto (UTC−4) : c'est la
    // date du salon qui doit s'afficher, jamais celle du serveur.
    afficher({ status: 'trialing', trialEndsAt: '2026-10-06T03:00:00.000Z' });

    expect(screen.getByText(/Essai gratuit jusqu’au 5 octobre 2026/u)).toBeDefined();
  });

  it('écrit la même fin d’essai en anglais, dans le même fuseau', () => {
    state.locale = 'en';
    afficher({ status: 'trialing', trialEndsAt: '2026-10-06T03:00:00.000Z' });

    expect(screen.getByText(/Free trial until October 5, 2026/u)).toBeDefined();
  });

  it('se passe de date quand l’API n’en donne pas', () => {
    afficher({ status: 'trialing', trialEndsAt: null });

    expect(screen.getByText('Essai gratuit en cours')).toBeDefined();
  });

  it('annonce la prochaine échéance d’un abonnement actif, ou rien', () => {
    afficher({ status: 'active', currentPeriodEndsAt: '2026-11-02T14:00:00.000Z' });

    expect(screen.getByText(/Prochaine échéance le 2 novembre 2026/u)).toBeDefined();

    cleanup();
    afficher({ status: 'active', currentPeriodEndsAt: null });

    expect(screen.getByText('Votre salon est ouvert.')).toBeDefined();
  });
});

describe('les gestes de l’écran d’abonnement (#1105)', () => {
  it('ouvre le paiement Stripe sans jamais demander de carte ici', async () => {
    // payments-stripe §1 : la carte se saisit sur une page hébergée par Stripe.
    // Cet écran n'a pas de champ, et le bouton n'est qu'un départ.
    startBillingCheckoutAction.mockResolvedValue({ ok: true, data: 'https://checkout.stripe.test/s' });
    const user = userEvent.setup();
    afficher({ status: 'pending' });

    expect(screen.queryByLabelText(/carte|card/iu)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Démarrer mon essai gratuit' }));

    expect(startBillingCheckoutAction).toHaveBeenCalledWith('maison-lotus', 'fr');
  });

  it('ouvre le portail Stripe depuis un abonnement actif', async () => {
    openBillingPortalAction.mockResolvedValue({ ok: true, data: 'https://portal.stripe.test/s' });
    const user = userEvent.setup();
    afficher({ status: 'active' });

    await user.click(screen.getByRole('button', { name: 'Gérer mon abonnement' }));

    expect(openBillingPortalAction).toHaveBeenCalledWith('maison-lotus', 'fr');
  });

  it('annonce en anglais l’échec d’ouverture de Stripe, message compris', async () => {
    // Le message du refus est écrit côté serveur, donc en français : c'est le
    // **code** qui décide de ce que le back-office anglais affiche.
    state.locale = 'en';
    openBillingPortalAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
      message: 'Le prestataire de paiement est momentanément indisponible.',
    });
    const user = userEvent.setup();
    afficher({ status: 'active' });

    await user.click(screen.getByRole('button', { name: 'Manage my subscription' }));

    expect(await screen.findByText('Stripe could not be opened')).toBeDefined();
    expect(
      screen.getByText('Stripe is momentarily unavailable. Please try again in a few seconds.'),
    ).toBeDefined();
    expect(
      screen.queryByText('Le prestataire de paiement est momentanément indisponible.'),
    ).toBeNull();
  });

  it.each(['fr', 'en'] as const)(
    'transmet la langue lue — %s — aux deux pages hébergées par Stripe (#1261)',
    async (langue) => {
      // Le défaut de #1231 : un gérant dont le compte est en français bascule
      // l'interface en anglais et repart sur une page Stripe française. C'est le
      // sélecteur de langue qui doit gagner, comme partout ailleurs (#845).
      state.locale = langue;
      startBillingCheckoutAction.mockResolvedValue({
        ok: true,
        data: 'https://checkout.stripe.test/s',
      });
      openBillingPortalAction.mockResolvedValue({ ok: true, data: 'https://portal.stripe.test/s' });
      const user = userEvent.setup();
      const libelles =
        langue === 'fr'
          ? { essai: 'Démarrer mon essai gratuit', gestion: 'Gérer mon abonnement' }
          : { essai: 'Start my free trial', gestion: 'Manage my subscription' };

      afficher({ status: 'pending' });
      await user.click(screen.getByRole('button', { name: libelles.essai }));

      expect(startBillingCheckoutAction).toHaveBeenCalledWith('maison-lotus', langue);

      cleanup();
      afficher({ status: 'active' });
      await user.click(screen.getByRole('button', { name: libelles.gestion }));

      expect(openBillingPortalAction).toHaveBeenCalledWith('maison-lotus', langue);
    },
  );

  it('retombe sur le message du refus pour un code qu’il ne connaît pas', async () => {
    openBillingPortalAction.mockResolvedValue({
      ok: false,
      code: 'CODE_QUI_NEXISTE_PAS',
      message: 'Un refus que le front ne sait pas nommer.',
    });
    const user = userEvent.setup();
    afficher({ status: 'active' });

    await user.click(screen.getByRole('button', { name: 'Gérer mon abonnement' }));

    expect(await screen.findByText('Un refus que le front ne sait pas nommer.')).toBeDefined();
  });
});

describe('les encarts de retour de paiement sont traduits (#1105)', () => {
  it('accueille la gérante en français au retour d’un essai ouvert', () => {
    render(
      <BillingPanel
        tenantSlug="maison-lotus"
        billing={billing({ status: 'trialing' })}
        retour="paiement"
        timeZone={TIME_ZONE}
        countryCode={COUNTRY}
      />,
    );

    expect(screen.getByText('Bienvenue ! Votre salon est ouvert')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Ajouter mes prestations' })).toBeDefined();
  });

  it('l’accueille en anglais', () => {
    state.locale = 'en';
    render(
      <BillingPanel
        tenantSlug="maison-lotus"
        billing={billing({ status: 'trialing' })}
        retour="paiement"
        timeZone={TIME_ZONE}
        countryCode={COUNTRY}
      />,
    );

    expect(screen.getByText('Welcome! Your salon is open')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Add my services' })).toBeDefined();
  });

  it('explique un paiement interrompu dans la langue lue', () => {
    state.locale = 'en';
    render(
      <BillingPanel
        tenantSlug="maison-lotus"
        billing={billing({ status: 'pending', trialEndsAt: null })}
        retour="annule"
        timeZone={TIME_ZONE}
        countryCode={COUNTRY}
      />,
    );

    expect(screen.getByText('Payment interrupted')).toBeDefined();
  });
});
