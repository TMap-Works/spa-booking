import type { Appointment, AppointmentStatus, Locale } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
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

const openCheckoutTicketAction = vi.fn();
const settleTicketAction = vi.fn();
const loadReceiptAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  openCheckoutTicketAction: (...args: unknown[]) => openCheckoutTicketAction(...args),
  settleTicketAction: (...args: unknown[]) => settleTicketAction(...args),
  loadReceiptAction: (...args: unknown[]) => loadReceiptAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

import { createTranslator } from 'next-intl';

import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';
import { CheckoutReceipt } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-receipt';
import { loadMessages } from '@/i18n/messages';
import {
  checkoutBlocker,
  checkoutFailureMessage,
  completionUnavailableMessage,
  meanHint,
  methodLabel,
  methodPhrase,
  providerUnreachableMessage,
  receiptDisclaimer,
  saleTotalRows,
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

/*
 * ## Le laissez-passer d'intention a disparu d'ici — #835, ADR 0015
 *
 * `INTENT_PASS` tenait le `clientSecret` remis au formulaire de carte, sorti en
 * constante pour ne pas faire lever un `generic-api-key` à gitleaks. Le comptoir
 * ne monte plus aucun formulaire de carte : la carte se règle sur le TPE
 * autonome de la banque du salon, et il n'y a plus d'intention à ouvrir — donc
 * plus rien à faire passer pour un secret.
 */

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

/**
 * Mille deux cents euros — le montant dont l'écriture anglaise porte une virgule
 * de milliers, et c'est elle qui était refusée à la saisie (#1123).
 */
const LARGE = { amountMinor: 120000, currency: 'EUR' } as const;

const SALE_ID = '99999999-0000-4000-8000-000000000009';

/** Un rendez-vous dont le prix dépasse le millier, prix de la prestation compris. */
function largeAppointment(): Appointment {
  const base = appointment();

  return { ...base, price: { ...LARGE }, service: { ...base.service, price: { ...LARGE } } };
}

/** Le ticket qu'`openCheckoutTicketAction` rend, entièrement dû. */
function ticketFor(total: { readonly amountMinor: number; readonly currency: string }): SaleSummary {
  return {
    id: SALE_ID,
    appointmentId: APPOINTMENT_ID,
    cashierUserId: 'bbbbbbbb-0000-4000-8000-000000000008',
    subtotal: { ...total },
    tax: { amountMinor: 0, currency: total.currency },
    tip: { amountMinor: 0, currency: total.currency },
    total: { ...total },
    settled: { amountMinor: 0, currency: total.currency },
    remaining: { ...total },
    settledAt: null,
    createdAt: '2026-09-05T07:00:00.000Z',
  };
}

const CASH_TRANSACTION: PaymentTransaction = {
  id: 'ffffffff-0000-4000-8000-000000000005',
  appointmentId: APPOINTMENT_ID,
  // L'API ne l'omet jamais (`PaymentTransactionDto`), et c'est lui qui donne au
  // panneau la pièce à réimprimer : sans lui, le bouton de réimpression n'a
  // rien à ouvrir et le panneau ne le propose plus.
  saleId: '99999999-0000-4000-8000-000000000009',
  amount: { ...DUE },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'cash',
  status: 'succeeded',
  capturedAt: '2026-09-05T07:05:00.000Z',
  createdAt: '2026-09-05T07:05:00.000Z',
};

afterEach(() => {
  cleanup();
  openCheckoutTicketAction.mockReset();
  settleTicketAction.mockReset();
  loadReceiptAction.mockReset();
  refresh.mockReset();
});

describe('les moyens de paiement et leurs états', () => {
  it('nomme les deux moyens dans les deux langues, en libellé et en phrase', () => {
    // Deux formes et non une : le libellé coiffe une case à cocher, la phrase
    // complète un bandeau — « Réglé en espèces », « Settled in cash ».
    expect(methodLabel('cash', 'fr')).toBe('Espèces');
    expect(methodLabel('card', 'fr')).toBe('Carte bancaire (TPE)');
    expect(methodLabel('cash', 'en')).toBe('Cash');
    expect(methodLabel('card', 'en')).toBe('Bank card (terminal)');
    expect(methodPhrase({ method: 'cash', cardChannel: null }, 'fr')).toBe('en espèces');
    expect(methodPhrase({ method: 'card', cardChannel: 'TERMINAL' }, 'en')).toBe(
      'by bank card (terminal)',
    );
  });

  it('fige les quatre phrases du règlement dans les deux langues — #1245', () => {
    /*
     * Le tableau de #1245, et rien d'autre : la phrase se décide sur le **canal**
     * de la carte, jamais sur son seul moyen. Le bandeau du rendez-vous réglé
     * relit la pièce préexistante — tunnel public compris —, là où la liste des
     * règlements pris à ce poste ne peut porter qu'un passage au TPE.
     *
     * Les deux langues sont figées ensemble parce que le produit sert l'anglais
     * par défaut : une clé posée dans un seul catalogue laisserait l'autre
     * afficher son identifiant brut, et c'est précisément ce que le troisième
     * critère interdit.
     *
     * Le canal nul est du côté du tunnel : `null` — ou la clé absente, le contrat
     * la déclarant `optional` — ne peut désigner qu'une carte antérieure à #834,
     * le TPE n'existant pas alors (`receipt-ticket.ts`, #1217).
     */
    const table = [
      { channel: 'TERMINAL', fr: 'par carte bancaire (TPE)', en: 'by bank card (terminal)' },
      { channel: 'STRIPE', fr: 'par carte bancaire (en ligne)', en: 'by bank card (online)' },
      { channel: null, fr: 'par carte bancaire (en ligne)', en: 'by bank card (online)' },
    ] as const;

    for (const row of table) {
      const card = { ...CASH_TRANSACTION, method: 'card', cardChannel: row.channel } as const;

      expect(methodPhrase(card, 'fr')).toBe(row.fr);
      expect(methodPhrase(card, 'en')).toBe(row.en);
    }

    expect(methodPhrase(CASH_TRANSACTION, 'fr')).toBe('en espèces');
    expect(methodPhrase(CASH_TRANSACTION, 'en')).toBe('in cash');

    // Aucune donnée de carte dans la phrase : ni marque, ni porteur, ni chiffre
    // (payments-stripe §1). Le canal est le nom d'un tuyau.
    for (const locale of ['fr', 'en'] as const) {
      for (const channel of ['TERMINAL', 'STRIPE', null] as const) {
        expect(methodPhrase({ method: 'card', cardChannel: channel }, locale)).not.toMatch(/\d/);
      }
    }
  });

  it('garde le français par défaut, pour les appelants pas encore branchés', () => {
    expect(methodLabel('cash')).toBe('Espèces');
    expect(meanHint('CARD_TERMINAL')).toContain('terminal');
  });

  it('dit dans les deux langues qu’aucun numéro de carte n’est saisi au salon', () => {
    // La mention PCI n'est pas décorative : l'opérateur doit savoir qu'il n'a
    // nulle part où saisir un numéro, dans l'une comme dans l'autre langue
    // (payments-stripe §1).
    expect(meanHint('CARD_TERMINAL', 'fr')).toMatch(/aucun numéro de carte n’est saisi/i);
    expect(meanHint('CARD_TERMINAL', 'en')).toMatch(/no card number is entered/i);
  });

  it('ne nomme plus Stripe au comptoir, dans aucune des deux langues', () => {
    // ADR 0015 : le formulaire a quitté l'écran, et une aide qui le nommerait
    // encore décrirait un geste qui n'existe plus.
    for (const locale of ['fr', 'en'] as const) {
      expect(meanHint('CARD_TERMINAL', locale)).not.toMatch(/stripe/i);
      expect(meanHint('CASH', locale)).not.toMatch(/stripe/i);
    }
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

  it('nomme le règlement partiel dans les deux langues — #1240', () => {
    // Un ticket de 78,00 € dont 50,00 € ont été pris : la pastille disait
    // « réglé », et le gérant relisait sa journée en y croyant.
    const partial: SettlementState = {
      kind: 'partiel',
      payment: CASH_TRANSACTION,
      ticket: {
        id: 'dddddddd-0000-4000-8000-000000000009',
        appointmentId: CASH_TRANSACTION.appointmentId,
        cashierUserId: 'cccccccc-0000-4000-8000-000000000003',
        subtotal: { amountMinor: 6500, currency: 'EUR' },
        tax: { amountMinor: 1300, currency: 'EUR' },
        tip: { amountMinor: 0, currency: 'EUR' },
        total: { amountMinor: 7800, currency: 'EUR' },
        settled: { amountMinor: 5000, currency: 'EUR' },
        remaining: { amountMinor: 2800, currency: 'EUR' },
        settledAt: null,
        createdAt: '2026-09-04T08:45:00.000Z',
      },
    };

    expect(settlementBadge(partial, 'fr').label).toBe('partiellement réglé');
    expect(settlementBadge(partial, 'en').label).toBe('partially settled');
    // Et il ne ferme rien : le reste dû se prend encore, par l'un ou l'autre moyen.
    expect(checkoutBlocker('completed', partial, 'fr')).toBeNull();
    expect(checkoutBlocker('completed', partial, 'en')).toBeNull();
  });

  it('explique l’écart de tarif avant le clic, dans les deux langues — #1240', () => {
    // Le refus qui tombait après : `POST /sales` relit le catalogue, et l'écran
    // n'avait sous la main que le prix figé à la réservation.
    for (const [locale, needle] of [
      ['fr', /tarif de cette prestation a changé/i],
      ['en', /price changed since the booking/i],
    ] as const) {
      expect(
        checkout(locale)('ticket.priceDriftAhead', {
          catalogue: '65,00 €',
          booked: '78,00 €',
          charged: '65,00 €',
        }),
      ).toMatch(needle);
    }
  });

  it('explique dans les deux langues pourquoi un moyen est fermé', () => {
    expect(checkoutBlocker('cancelled', { kind: 'du' }, 'fr')).toMatch(/annulé/i);
    expect(checkoutBlocker('cancelled', { kind: 'du' }, 'en')).toMatch(/cancelled/i);
    expect(
      checkoutBlocker('confirmed', { kind: 'ouvert', payment: CASH_TRANSACTION }, 'en'),
    ).toMatch(/online payment is still in flight/i);
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

    // Le seul champ de saisie libre du panneau des espèces est le montant remis
    // par la cliente : aucun ne porte, ni ne promet, une donnée de carte. Le
    // terminal du salon est autonome (ADR 0015, payments-stripe §1).
    //
    // L'identité des champs est examinée, et non les textes de l'écran : l'aide
    // du moyen carte **dit** « No card number is entered », et c'est
    // précisément ce qu'on veut y lire.
    const freeText = /^(?:text|tel|number|password|email|search)$/u;

    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('autocomplete') ?? '').not.toMatch(/^cc-/u);

      if (!freeText.test(field.getAttribute('type') ?? 'text')) {
        continue;
      }

      expect([field.id, field.name, field.getAttribute('placeholder') ?? ''].join(' ')).not.toMatch(
        /carte|card|cvc|cvv|expirat/iu,
      );
    }

    expect(document.body.textContent).not.toMatch(/Stripe/iu);
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
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: ticketFor(DUE) });
    settleTicketAction.mockResolvedValue({
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

  /**
   * Les montants **saisis** au comptoir, et non plus seulement ceux qu'on y lit —
   * #1123.
   *
   * `parseAmountInput` était figé sur les séparateurs français : sur un comptoir
   * anglais, l'opérateur lisait « €1,200.00 » dans la pile des totaux et se
   * voyait refuser « Unreadable amount » en recopiant ce montant dans « Amount
   * handed over ». Le panneau lui passe désormais son contexte d'affichage, celui
   * dont `formatMoney` se sert déjà.
   */
  it('relit le montant tendu tel que l’écran anglais l’a écrit, virgule de milliers comprise', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: ticketFor(LARGE) });
    // Le ticket soldé monte le reçu, qui lit la pièce dès son effet : sans cette
    // doublure, la promesse absente ferait tomber le composant.
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: {
        saleId: SALE_ID,
        payment: { ...CASH_TRANSACTION, amount: { ...LARGE } },
        settled: { ...LARGE },
        remaining: { amountMinor: 0, currency: 'EUR' },
        settledAt: '2026-09-05T07:05:00.000Z',
        change: { amountMinor: 0, currency: 'EUR' },
        replayed: false,
      },
    });
    render(
      <CheckoutPanel
        appointment={largeAppointment()}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    await userEvent.type(
      screen.getByLabelText('Amount handed over by the client'),
      // Exactement ce que la pile des totaux affiche, symbole retiré.
      '1,200.00',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Take €1,200.00 in cash' }));

    expect(settleTicketAction).toHaveBeenCalledWith(
      SLUG,
      SALE_ID,
      { method: 'CASH', tenderedAmountMinor: 120000 },
      expect.any(String),
    );
    expect(screen.queryByText(/Unreadable amount/u)).toBeNull();
  });

  it('accepte aussi la virgule décimale tapée sur un écran anglais', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: ticketFor(LARGE) });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: {
        saleId: SALE_ID,
        payment: { ...CASH_TRANSACTION, amount: { amountMinor: 1250, currency: 'EUR' } },
        settled: { amountMinor: 1250, currency: 'EUR' },
        remaining: { amountMinor: 118750, currency: 'EUR' },
        settledAt: null,
        change: { amountMinor: 0, currency: 'EUR' },
        replayed: false,
      },
    });
    render(
      <CheckoutPanel
        appointment={largeAppointment()}
        countryCode="US"
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    await userEvent.click(screen.getByLabelText(/Settle part of it/u));
    // Une virgule décimale sous un écran anglais : c'est ce qu'une opératrice
    // francophone tape, et ce n'est pas une faute de saisie.
    await userEvent.type(screen.getByLabelText('Amount for this settlement'), '12,50');
    await userEvent.click(screen.getByRole('button', { name: /Take €12\.50 in cash/u }));

    expect(settleTicketAction).toHaveBeenCalledWith(
      SLUG,
      SALE_ID,
      { method: 'CASH', amountMinor: 1250 },
      expect.any(String),
    );
  });
});

describe('le reçu remis à la cliente', () => {
  it('traduit le bandeau du reçu et son titre', () => {
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    render(
      <CheckoutReceipt
        appointment={appointment()}
        countryCode="US"
        saleId="99999999-0000-4000-8000-000000000009"
        tenantSlug={SLUG}
        transaction={CASH_TRANSACTION}
      />,
    );

    expect(screen.getByText('Settlement recorded — €35.00')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Till receipt' })).toBeDefined();
  });

  it('ne promet plus de confirmation par webhook — le comptoir n’attend personne', () => {
    // ADR 0015 : espèces comme TPE, le règlement est inscrit quand l'API répond.
    // Un reçu « provisoire » décrirait un geste que le comptoir ne fait plus.
    expect(receiptDisclaimer('en')).toMatch(/recorded and timestamped/i);
    expect(receiptDisclaimer('en')).not.toMatch(/webhook/i);
    expect(receiptDisclaimer('fr')).not.toMatch(/webhook/i);
  });

  it('traduit la mention du passage en « honoré », qui reste un geste du salon', () => {
    expect(completionUnavailableMessage('en')).toMatch(/salon gesture/i);
    expect(completionUnavailableMessage('fr')).toMatch(/honoré/i);
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
