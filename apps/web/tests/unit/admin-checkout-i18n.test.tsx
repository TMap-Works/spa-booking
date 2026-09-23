import type { Appointment, AppointmentStatus, Locale } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * L'encaissement du back-office en français et en anglais — #850.
 *
 * ## Ce que cette suite protège, critère par critère
 *
 * - **Tous les textes du périmètre viennent de `admin-checkout`** : ceux des
 *   composants par `useTranslations`, ceux que `lib/admin/checkout-summary.ts`
 *   compose hors de React par import direct des deux mêmes fichiers.
 * - **Les montants sont formatés selon la langue et restent des entiers** : le
 *   même `{ amountMinor: 3500, currency: 'EUR' }` s'écrit « 35,00 € » en
 *   français et « €35.00 » en anglais. Aucune fonction du comptoir n'en fait
 *   l'arithmétique — c'est l'invariant de `payments-stripe` §5, et il ne bouge
 *   pas d'un pouce avec la langue.
 * - **Stripe Elements reçoit la langue courante** (option `locale`), et c'est ce
 *   qui fait que ses propres messages — carte refusée comprise — arrivent dans
 *   la langue de l'interface plutôt que dans celle de son défaut.
 * - **Les moyens de paiement, les statuts de règlement et le reçu sont
 *   traduits**, y compris les refus que l'API rend en 409.
 * - **Le périmètre PCI ne change pas** : il n'y a toujours aucun champ de carte
 *   dans notre DOM, et l'anglais n'en ajoute pas.
 *
 * Le rendu d'un composant en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : la
 * doublure ci-dessous lit le **vrai** catalogue anglais, par le même
 * `loadMessages` que le serveur.
 */

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');
  const messages = loadMessages('en');
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) => {
      const key = namespace ?? '';
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const made = translator(
        namespace === undefined
          ? { locale: 'en', messages }
          : { locale: 'en', messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

const settleInCashAction = vi.fn();
const openCardPaymentAction = vi.fn();
const loadReceiptAction = vi.fn();
const refresh = vi.fn();
const confirmPayment = vi.fn();
const loadStripeSdk = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  settleInCashAction: (...args: unknown[]) => settleInCashAction(...args),
  openCardPaymentAction: (...args: unknown[]) => openCardPaymentAction(...args),
  loadReceiptAction: (...args: unknown[]) => loadReceiptAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

// Le module réel est doublé — il irait chercher un script chez `js.stripe.com`,
// ce qui n'a pas de sens dans jsdom et prouve à soi seul que la frontière PCI
// tient : il n'y a **rien** à monter chez nous. `StripeLoadError` est repris du
// vrai module, le composant s'en servant pour classer un échec de chargement.
vi.mock('@/lib/admin/payment-stripe', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/payment-stripe')>(
      '@/lib/admin/payment-stripe',
    );

  return {
    ...actual,
    loadStripeSdk: (...args: unknown[]) => loadStripeSdk(...args),
  };
});

import { createTranslator } from 'next-intl';

import { CheckoutCardForm } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-card-form';
import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';
import { CheckoutReceipt } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-receipt';
import { loadMessages } from '@/i18n/messages';
import {
  checkoutBlocker,
  checkoutFailureMessage,
  completionUnavailableMessage,
  methodHint,
  methodLabel,
  methodPhrase,
  providerUnreachableMessage,
  receiptDisclaimer,
  saleTotalRows,
  settledReceiptDisclaimer,
  settlementBadge,
  type SettlementState,
} from '@/lib/admin/checkout-summary';
import type { PaymentTransaction, SaleSummary } from '@/lib/admin/payment-contract';
import { formatMoney } from '@/lib/format';

/** Le traducteur du namespace de l'écran, dans la langue demandée. */
function checkout(locale: Locale): (key: string, values?: Record<string, unknown>) => string {
  const make = createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace: string;
  }) => (key: string, values?: Record<string, unknown>) => string;

  return make({ locale, messages: loadMessages(locale), namespace: 'admin-checkout' });
}

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Trente-cinq euros, en entiers — jamais autre chose, dans aucune langue. */
const DUE = { amountMinor: 3500, currency: 'EUR' } as const;

/**
 * Le laissez-passer d'intention remis au formulaire de carte.
 *
 * Une constante, et non un littéral dans le JSX : `clientSecret="…"` écrit en
 * clair fait lever un `generic-api-key` à gitleaks, qui n'a aucune façon de
 * distinguer une valeur de test d'une vraie. Sa forme est délibérément sans
 * entropie — rien ici ne ressemble à un laissez-passer Stripe, et il n'y a
 * d'ailleurs jamais eu de secret dans ce dépôt (payments-stripe §7).
 */
const INTENT_PASS = 'intention-de-recette-850';

function appointment(status: AppointmentStatus = 'confirmed'): Appointment {
  return {
    id: APPOINTMENT_ID,
    reference: 'RDV-8F3K-27',
    status,
    client: {
      id: 'cccccccc-0000-4000-8000-000000000002',
      firstName: 'Rina',
      lastName: 'Andriamana',
    },
    staff: { id: 'dddddddd-0000-4000-8000-000000000003', displayName: 'Hasina' },
    service: {
      id: 'eeeeeeee-0000-4000-8000-000000000004',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { ...DUE },
    },
    startsAt: '2026-09-05T06:00:00.000Z',
    endsAt: '2026-09-05T07:00:00.000Z',
    price: { ...DUE },
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

const CASH_TRANSACTION: PaymentTransaction = {
  id: 'ffffffff-0000-4000-8000-000000000005',
  appointmentId: APPOINTMENT_ID,
  amount: { ...DUE },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'cash',
  status: 'succeeded',
  capturedAt: '2026-09-05T07:05:00.000Z',
  createdAt: '2026-09-05T07:05:00.000Z',
};

afterEach(() => {
  cleanup();
  settleInCashAction.mockReset();
  openCardPaymentAction.mockReset();
  loadReceiptAction.mockReset();
  confirmPayment.mockReset();
  loadStripeSdk.mockReset();
  refresh.mockReset();
});

describe('les moyens de paiement et leurs états', () => {
  it('nomme les deux moyens dans les deux langues, en libellé et en phrase', () => {
    // Deux formes et non une : le libellé coiffe une case à cocher, la phrase
    // complète un bandeau — « Réglé en espèces », « Settled in cash ».
    expect(methodLabel('cash', 'fr')).toBe('Espèces');
    expect(methodLabel('card', 'fr')).toBe('Carte');
    expect(methodLabel('cash', 'en')).toBe('Cash');
    expect(methodLabel('card', 'en')).toBe('Card');
    expect(methodPhrase('cash', 'fr')).toBe('en espèces');
    expect(methodPhrase('card', 'en')).toBe('by card');
  });

  it('garde le français par défaut, pour les appelants pas encore branchés', () => {
    expect(methodLabel('cash')).toBe('Espèces');
    expect(methodHint('card')).toContain('Stripe');
  });

  it('dit dans les deux langues qu’aucun numéro de carte n’est saisi au salon', () => {
    // La mention PCI n'est pas décorative : l'opérateur doit savoir qu'il n'a
    // nulle part où saisir un numéro, dans l'une comme dans l'autre langue
    // (payments-stripe §1).
    expect(methodHint('card', 'fr')).toMatch(/aucun numéro n’est saisi/i);
    expect(methodHint('card', 'en')).toMatch(/no number is entered/i);
  });

  it('traduit la pastille de règlement, et son cas remboursé', () => {
    const settled: SettlementState = { kind: 'regle', payment: CASH_TRANSACTION };
    const refunded: SettlementState = {
      kind: 'regle',
      payment: { ...CASH_TRANSACTION, status: 'partially_refunded' },
    };

    expect(settlementBadge(settled, 'fr').label).toBe('réglé');
    expect(settlementBadge(settled, 'en').label).toBe('settled');
    expect(settlementBadge(refunded, 'en').label).toBe('partially refunded');
    // La nuance ne suit pas la langue : c'est une classe CSS, pas un mot.
    expect(settlementBadge(refunded, 'en').modifier).toBe('refunded');
    expect(settlementBadge({ kind: 'du' }, 'en').label).toBe('to settle');
  });

  it('explique dans les deux langues pourquoi un moyen est fermé', () => {
    expect(checkoutBlocker('cancelled', 'cash', { kind: 'du' }, 'fr')).toMatch(/annulé/i);
    expect(checkoutBlocker('cancelled', 'cash', { kind: 'du' }, 'en')).toMatch(/cancelled/i);
    expect(checkoutBlocker('completed', 'card', { kind: 'du' }, 'en')).toMatch(/no-show/i);
    expect(
      checkoutBlocker('confirmed', 'cash', { kind: 'ouvert', payment: CASH_TRANSACTION }, 'en'),
    ).toMatch(/card payment is already open/i);
  });
});

describe('les refus de l’API, lus sur leur code', () => {
  it('traduit « déjà encaissé » sans jamais reprendre le message de l’API', () => {
    // L'écran réagit sur le **code**, jamais sur le message (web-frontend §2) :
    // c'est ce qui permet de le traduire du tout.
    expect(checkoutFailureMessage('PAYMENT_ALREADY_SETTLED', 'ignoré', 'fr')).toMatch(
      /déjà été encaissé/i,
    );
    expect(checkoutFailureMessage('PAYMENT_ALREADY_SETTLED', 'ignored', 'en')).toMatch(
      /already been settled/i,
    );
    expect(checkoutFailureMessage('SALE_ALREADY_SETTLED', 'ignored', 'en')).toMatch(
      /already been settled/i,
    );
  });

  it('traduit le silence du prestataire, dans les deux langues et en un seul texte', () => {
    expect(providerUnreachableMessage('fr')).toMatch(/n’a pas répondu/i);
    expect(providerUnreachableMessage('en')).toMatch(/did not answer/i);
    expect(checkoutFailureMessage('SERVICE_UNAVAILABLE', 'x', 'en')).toBe(
      providerUnreachableMessage('en'),
    );
  });

  it('laisse parler l’API sur un code qu’il ne connaît pas', () => {
    // Le repli n'est pas traduit, et c'est délibéré : c'est l'API qui nomme un
    // refus qu'aucun code connu ne couvre, et une phrase générique de notre cru
    // n'apprendrait rien au comptoir.
    expect(checkoutFailureMessage('UN_CODE_INEDIT', 'Ce que l’API a dit.', 'en')).toBe(
      'Ce que l’API a dit.',
    );
  });
});

describe('les montants : mis en forme selon la langue, entiers de bout en bout', () => {
  it('écrit le même entier des deux façons, sans jamais le changer', () => {
    // Le montant reste `{ amountMinor: 3500, currency: 'EUR' }` : seule son
    // écriture suit la langue et la région (`CLAUDE.md`, payments-stripe §5).
    //
    // Les espaces sont normalisées avant comparaison : `Intl` sépare les
    // milliers et la devise par une espace fine insécable (U+202F), et comparer
    // au caractère près ferait échouer ce test sur une subtilité de typographie
    // qui n'est pas son propos.
    const spaceless = (text: string): string => text.replace(/\s/gu, ' ');

    expect(spaceless(formatMoney(DUE, { locale: 'fr', countryCode: 'FR' }))).toBe('35,00 €');
    expect(spaceless(formatMoney(DUE, { locale: 'en', countryCode: 'US' }))).toBe('€35.00');
    expect(DUE.amountMinor).toBe(3500);
    expect(DUE.currency).toBe('EUR');
  });

  it('nomme les lignes de totaux d’un ticket dans les deux langues, sans rien additionner', () => {
    const sale = {
      subtotal: { amountMinor: 3500, currency: 'EUR' },
      tax: { amountMinor: 700, currency: 'EUR' },
      tip: { amountMinor: 0, currency: 'EUR' },
      // Volontairement **différent** de la somme des lignes : c'est le total du
      // serveur qui est affiché, et ce test échouerait si le front le
      // recomposait.
      total: { amountMinor: 4300, currency: 'EUR' },
    } as unknown as SaleSummary;

    expect(saleTotalRows(sale, 'fr').map((row) => row.label)).toEqual([
      'Sous-total',
      'Taxe',
      'Total',
    ]);
    expect(saleTotalRows(sale, 'en').map((row) => row.label)).toEqual([
      'Subtotal',
      'Tax',
      'Total',
    ]);
    expect(saleTotalRows(sale, 'en').at(-1)?.amount.amountMinor).toBe(4300);
  });
});

describe('le panneau d’encaissement, rendu en anglais', () => {
  it('offre les deux moyens et annonce le montant dans la langue', () => {
    render(
      <CheckoutPanel
        appointment={appointment()}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByRole('group', { name: 'Payment method' })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Cash/u })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Take €35.00 in cash' })).toBeDefined();
  });

  it('n’expose aucun champ de carte — la frontière PCI ne dépend pas de la langue', () => {
    render(
      <CheckoutPanel
        appointment={appointment()}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    // Ni champ de saisie, ni libellé qui en promettrait un : ce que Stripe monte
    // est une iframe servie depuis son domaine (payments-stripe §1).
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText(/card number|numéro de carte/iu)).toBeNull();
  });

  it('annonce un règlement déjà inscrit dans la langue, avec sa phrase de moyen', () => {
    render(
      <CheckoutPanel
        appointment={appointment()}
        countryCode="US"
        settlement={{ kind: 'regle', payment: CASH_TRANSACTION }}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Settled in cash — €35.00')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reprint the receipt' })).toBeDefined();
  });

  it('bascule en anglais sur le refus 409, plutôt que de laisser le bouton actif', async () => {
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'SALE_ALREADY_SETTLED',
      message: 'Ce ticket a déjà été réglé.',
    });
    render(
      <CheckoutPanel
        appointment={appointment()}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Take €35.00 in cash' }));

    expect(await screen.findByText('Appointment already settled')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Take/u })).toBeNull();
  });

  it('dit en anglais qu’il n’y a rien à encaisser sur un rendez-vous annulé', () => {
    render(
      <CheckoutPanel
        appointment={appointment('cancelled')}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Nothing to settle')).toBeDefined();
    expect(screen.getByText(/the slot has been released/iu)).toBeDefined();
  });
});

describe('Stripe Elements reçoit la langue courante', () => {
  it('passe `locale` à la fabrique — c’est ce qui traduit ses refus de carte', async () => {
    loadStripeSdk.mockResolvedValue({
      elements: () => ({ create: () => ({ mount: vi.fn(), unmount: vi.fn(), destroy: vi.fn() }) }),
      confirmPayment: (...args: unknown[]) => confirmPayment(...args),
    });

    render(
      <CheckoutCardForm
        amount={DUE}
        clientSecret={INTENT_PASS}
        countryCode="US"
        onAccepted={vi.fn()}
        publishableKey="pk_test_51ABC"
      />,
    );

    await waitFor(() => {
      expect(loadStripeSdk).toHaveBeenCalledWith('pk_test_51ABC', 'en');
    });
    expect(screen.getByRole('button', { name: 'Take €35.00 by card' })).toBeDefined();
  });

  it('affiche tel quel le message que Stripe rend — il arrive déjà traduit', async () => {
    // C'est tout l'intérêt de lui passer `locale` : recopier « carte refusée »
    // dans notre catalogue l'aurait fait diverger de ce que la cliente lit dans
    // le champ, qui appartient à Stripe.
    loadStripeSdk.mockResolvedValue({
      elements: () => ({ create: () => ({ mount: vi.fn(), unmount: vi.fn(), destroy: vi.fn() }) }),
      confirmPayment: (...args: unknown[]) => confirmPayment(...args),
    });
    confirmPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });

    render(
      <CheckoutCardForm
        amount={DUE}
        clientSecret={INTENT_PASS}
        countryCode="US"
        onAccepted={vi.fn()}
        publishableKey="pk_test_51ABC"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Take €35.00 by card' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: 'Take €35.00 by card' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Your card was declined.',
    );
  });

  it('traduit l’indisponibilité du module, que le module lui-même ne nomme pas', async () => {
    const { StripeLoadError } =
      await vi.importActual<typeof import('@/lib/admin/payment-stripe')>(
        '@/lib/admin/payment-stripe',
      );
    loadStripeSdk.mockRejectedValue(new StripeLoadError('script'));

    render(
      <CheckoutCardForm
        amount={DUE}
        clientSecret={INTENT_PASS}
        countryCode="US"
        onAccepted={vi.fn()}
        publishableKey="pk_test_51ABC"
      />,
    );

    expect(await screen.findByText('Card payment unavailable')).toBeDefined();
    expect(screen.getByText(/Stripe’s payment module could not be loaded/u)).toBeDefined();
    expect(screen.getByText('Settling in cash is still possible.')).toBeDefined();
  });
});

describe('le reçu remis à la cliente', () => {
  it('traduit le ticket réduit, ses colonnes et son total', () => {
    render(
      <CheckoutReceipt
        appointment={appointment()}
        countryCode="US"
        method="cash"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        transaction={{ ...CASH_TRANSACTION, saleId: null } as PaymentTransaction}
      />,
    );

    expect(screen.getByText('Settlement recorded — €35.00')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Till receipt' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Qty' })).toBeDefined();
    expect(screen.getByText('Thank you for your visit!')).toBeDefined();
    expect(screen.getByRole('article', { name: 'Receipt' })).toBeDefined();
  });

  it('dit en anglais qu’un reçu carte est provisoire, et le contraire une fois inscrit', () => {
    // La distinction vient de payments-stripe §2 et ne se perd pas à la
    // traduction : le navigateur n'a jamais autorité pour déclarer un paiement
    // abouti, c'est le webhook signé qui l'inscrit.
    expect(receiptDisclaimer('card', 'en')).toMatch(/not the capture/i);
    expect(receiptDisclaimer('cash', 'en')).toMatch(/recorded and timestamped/i);
    expect(settledReceiptDisclaimer('card', 'en')).toMatch(/final/i);
    expect(receiptDisclaimer('card', 'fr')).toMatch(/pas de capture/i);
  });

  it('traduit la mention du passage en « honoré » que l’API ne sert pas encore', () => {
    expect(completionUnavailableMessage('cash', 'en')).toMatch(/not served by the API yet/i);
    expect(completionUnavailableMessage('card', 'fr')).toMatch(/webhook/i);
  });
});

describe('les deux catalogues', () => {
  it('ne laisse aucune clé du namespace intraduite entre les deux langues', () => {
    // La parité générale est tenue par `messages-parity`; ce test-ci dit la même
    // chose sur ce namespace, et échoue en le nommant — c'est ce qu'on veut lire
    // quand une clé a été ajoutée d'un seul côté.
    const flatten = (tree: unknown, prefix = ''): string[] =>
      typeof tree === 'object' && tree !== null
        ? Object.entries(tree).flatMap(([key, value]) =>
            flatten(value, prefix === '' ? key : `${prefix}.${key}`),
          )
        : [prefix];

    const french = flatten(loadMessages('fr')['admin-checkout']).sort();
    const english = flatten(loadMessages('en')['admin-checkout']).sort();

    expect(french).toEqual(english);
    expect(french.length).toBeGreaterThan(50);
  });

  it('sert le titre de l’écran dans les deux langues', () => {
    expect(checkout('fr')('title')).toBe('Encaissement');
    expect(checkout('en')('title')).toBe('Checkout');
  });
});
