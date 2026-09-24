import type { Locale, SaleReceipt } from '@spa/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Le ticket de caisse imprimé, en français **et** en anglais — #1248.
 *
 * ## Ce que cette suite protège
 *
 * Le rouleau de 80 mm tendu à la cliente écrivait ses libellés en dur, en
 * français, alors que le produit sert l'**anglais par défaut** depuis
 * l'internationalisation : un salon dont la session est en anglais tendait une
 * pièce comptable en français, et treize clés du catalogue `admin-checkout` que
 * personne ne lisait n'étaient relues, ni corrigées, ni traduites par personne.
 *
 * Trois choses sont vérifiées ici, et elles ne sont pas de même nature :
 *
 * - **les mots suivent la langue**, du titre du document au pied de ticket, en
 *   passant par le libellé de règlement et la nature de l'identifiant légal ;
 * - **rien ne reste en français** quand la session est en anglais — c'est
 *   l'assertion qui attrape le libellé oublié, là où la première se contenterait
 *   de constater que le reste est traduit ;
 * - **les chiffres, eux, ne bougent pas** : le numéro de pièce est le même
 *   caractère pour caractère, le montant porte les mêmes entiers, et l'heure
 *   reste celle du fuseau du salon. Seule leur écriture suit la langue, par
 *   `lib/format.ts` (`CLAUDE.md`).
 *
 * ## Comment les deux langues coexistent dans un seul fichier
 *
 * L'amorce des suites fixe la langue à `fr` (#845, `tests/support/next-intl.ts`).
 * La doublure ci-dessous est celle d'`admin-billing-panel.test.tsx` : un état
 * hissé porte la langue, et chaque rendu la choisit. C'est le **changement** de
 * langue qui est la promesse du ticket — le figer à `en` pour tout le fichier,
 * comme le fait `admin-checkout-i18n.test.tsx`, ne prouverait que la moitié.
 */

const state = vi.hoisted(() => ({ locale: 'fr' as Locale }));

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

import { ReceiptTicket } from '@/app/(admin)/[tenantSlug]/admin/components/receipt-ticket';
import { formatTicketDateTime } from '@/lib/format';

afterEach(() => {
  cleanup();
  state.locale = 'fr';
});

/** Le salon de référence : Antananarivo, donc un fuseau qui n'est pas celui d'ici. */
const TIME_ZONE = 'Indian/Antananarivo';
/** 07:05 UTC — 10:05 au salon. C'est cette heure-là qui doit s'imprimer. */
const ISSUED_AT = '2026-09-05T07:05:00.000Z';
const NUMBER = 'TIC-2026-000123';

/** Soixante-cinq euros, en entiers — jamais autre chose, dans aucune langue. */
const TOTAL = { amountMinor: 6500, currency: 'EUR' } as const;

const RECEIPT: SaleReceipt = {
  saleId: '99999999-0000-4000-8000-000000000009',
  number: NUMBER,
  sequence: 123,
  issuedAt: ISSUED_AT,
  openedAt: '2026-09-05T06:50:00.000Z',
  timezone: TIME_ZONE,
  issuer: {
    name: 'Maison Lotus',
    legalName: 'Maison Lotus SARL',
    legalIdType: 'OTHER',
    legalId: '3000123456',
    vatNumber: 'FR12345678901',
    address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'MG' },
    contactPhone: '+261341234567',
    footer: 'Prestation de services — TVA acquittée sur les encaissements.',
  },
  cashier: { displayName: 'Hasina' },
  client: { displayName: 'Rina Andriamana' },
  practitioner: { displayName: 'Fara' },
  lines: [
    {
      position: 0,
      kind: 'SERVICE',
      label: 'Massage suédois',
      quantity: 2,
      unitPrice: { amountMinor: 2500, currency: 'EUR' },
      total: { amountMinor: 5000, currency: 'EUR' },
    },
    {
      position: 1,
      kind: 'PRODUCT',
      label: 'Huile de massage',
      quantity: 1,
      unitPrice: { amountMinor: 1500, currency: 'EUR' },
      total: { amountMinor: 1500, currency: 'EUR' },
    },
  ],
  taxBreakdown: [
    {
      rateBps: 2000,
      base: { amountMinor: 5417, currency: 'EUR' },
      tax: { amountMinor: 1083, currency: 'EUR' },
    },
  ],
  subtotal: { amountMinor: 5417, currency: 'EUR' },
  taxTotal: { amountMinor: 1083, currency: 'EUR' },
  tip: { amountMinor: 500, currency: 'EUR' },
  total: { ...TOTAL },
  settlements: [
    {
      method: 'CASH',
      cardChannel: null,
      amount: { amountMinor: 6500, currency: 'EUR' },
      tendered: { amountMinor: 7000, currency: 'EUR' },
      change: { amountMinor: 500, currency: 'EUR' },
      capturedAt: ISSUED_AT,
    },
  ],
  refunds: [
    {
      number: 'TIC-2026-000123-R1',
      origin: NUMBER,
      amount: { amountMinor: 1000, currency: 'EUR' },
      issuedAt: '2026-09-06T07:05:00.000Z',
    },
  ],
};

/** Un ticket dont la vente n'est pas close : ni numéro, ni date de pièce. */
const PROVISIONAL: SaleReceipt = { ...RECEIPT, number: null, sequence: null, issuedAt: null };

interface Printed {
  /** Tout le texte du rouleau, tel qu'il s'imprime. */
  readonly text: string;
  /** Le nom accessible de la pièce — l'`aria-label` de la région. */
  readonly name: string;
  /** Le grand total, seul, tel que la ligne le porte. */
  readonly grandTotal: string;
}

/**
 * Rend le rouleau dans une langue et en ressort du **texte**.
 *
 * Démonté avant de rendre la main : les deux langues se comparent dans le même
 * test, et deux tickets montés en même temps rendraient chaque requête
 * ambiguë.
 */
function print(
  locale: Locale,
  receipt: SaleReceipt = RECEIPT,
  countryCode: string | null = null,
): Printed {
  state.locale = locale;

  const { container, unmount } = render(
    <ReceiptTicket countryCode={countryCode} receipt={receipt} />,
  );
  const printed: Printed = {
    text: container.textContent ?? '',
    name: container.querySelector('article')?.getAttribute('aria-label') ?? '',
    grandTotal: container.querySelector('.spa-ticket__row--grand dd')?.textContent ?? '',
  };

  unmount();

  return printed;
}

/** Les seuls chiffres d'une chaîne — « 65,00 € » et « €65.00 » rendent « 6500 ». */
function digits(text: string): string {
  return text.replace(/\D/gu, '');
}

describe('le ticket de caisse imprimé', () => {
  it('se rend entièrement en français', () => {
    const { text, name } = print('fr');

    expect(name).toBe(`Ticket n° ${NUMBER}`);

    for (const phrase of [
      `Ticket n° ${NUMBER}`,
      'Immatriculation 3000123456',
      'TVA intracom. FR12345678901',
      'Client',
      'Praticien',
      'Caisse',
      'Lignes du reçu',
      'Article',
      'Qté',
      'Montant',
      '3 articles',
      'Total HT',
      'Pourboire',
      'Total TTC',
      'Règlement',
      'Espèces',
      'Rendu',
      'Détail de la TVA',
      'Avoirs',
      'Merci de votre visite !',
    ]) {
      expect(text, `« ${phrase} » manque au ticket français`).toContain(phrase);
    }
  });

  it('se rend entièrement en anglais', () => {
    const { text, name } = print('en');

    expect(name).toBe(`Receipt no. ${NUMBER}`);

    for (const phrase of [
      `Receipt no. ${NUMBER}`,
      'Registration no. 3000123456',
      'VAT no. FR12345678901',
      'Client',
      'Practitioner',
      'Cashier',
      'Receipt lines',
      'Item',
      'Qty',
      'Amount',
      '3 items',
      'Subtotal excl. tax',
      'Tip',
      'Total incl. tax',
      'Payment',
      'Cash',
      'Change',
      'Tax breakdown',
      'Credit notes',
      'Thank you for your visit!',
    ]) {
      expect(text, `« ${phrase} » manque au ticket anglais`).toContain(phrase);
    }
  });

  it('ne laisse plus un seul mot français sur le ticket anglais', () => {
    // L'assertion qui attrape le libellé oublié : la précédente se contenterait
    // de constater que le reste est traduit.
    const { text } = print('en');

    for (const french of [
      'Ticket n°',
      'Praticien',
      'Qté',
      'Total HT',
      'Total TTC',
      'Pourboire',
      'Espèces',
      'Immatriculation',
      'Détail de la TVA',
      'Avoirs',
      'Merci de votre visite',
    ]) {
      expect(text, `« ${french} » est resté en français`).not.toContain(french);
    }
  });

  it('dit « ticket provisoire » dans les deux langues tant que la vente n’est pas close', () => {
    const french = print('fr', PROVISIONAL);

    expect(french.name).toBe('Ticket provisoire');
    expect(french.text).toContain('Ticket provisoire');
    expect(french.text).toContain('n’est pas une pièce comptable');

    const english = print('en', PROVISIONAL);

    expect(english.name).toBe('Provisional receipt');
    expect(english.text).toContain('Provisional receipt');
    expect(english.text).toContain('is not an accounting record');
    expect(english.text).not.toContain('pièce comptable');
  });

  it('nomme le moyen de règlement dans la langue de la session', () => {
    // Le libellé vient de `settlementLabel`, qui lit déjà le catalogue : c'est
    // le composant qui ne lui passait pas la langue, et la ligne de règlement
    // était la seule à rester en français sur un ticket anglais.
    const card: SaleReceipt = {
      ...RECEIPT,
      settlements: [
        {
          method: 'CARD',
          cardChannel: 'TERMINAL',
          amount: { ...TOTAL },
          terminalReference: 'A0000123',
          capturedAt: ISSUED_AT,
        },
      ],
    };

    expect(print('fr', card).text).toContain('Carte bancaire (TPE) — réf. A0000123');
    expect(print('en', card).text).toContain('Bank card (terminal) — ref. A0000123');
  });

  it('dit dans les deux langues qu’aucun règlement n’est encore inscrit', () => {
    const unsettled: SaleReceipt = { ...RECEIPT, settlements: [] };

    expect(print('fr', unsettled).text).toContain('Aucun règlement enregistré.');
    expect(print('en', unsettled).text).toContain('No settlement recorded.');
  });
});

/**
 * Le quatrième critère de #1248, et l'invariant de `CLAUDE.md` derrière lui :
 * **la langue ne touche à aucune valeur**. Les montants restent des entiers
 * accompagnés d'un code devise, les instants restent en UTC, le fuseau reste
 * celui du salon, et le numéro de pièce est une identité — pas une phrase.
 */
describe('ce que la langue ne change pas', () => {
  it('imprime le même numéro de pièce, caractère pour caractère', () => {
    expect(print('fr').text).toContain(NUMBER);
    expect(print('en').text).toContain(NUMBER);
    // L'avoir cite le numéro d'origine : lui non plus ne se traduit pas.
    expect(print('fr').text).toContain('TIC-2026-000123-R1');
    expect(print('en').text).toContain('TIC-2026-000123-R1');
  });

  it('porte les mêmes entiers dans les deux langues, écrits autrement', () => {
    const french = print('fr').grandTotal;
    const english = print('en').grandTotal;

    // Le montant reste `{ amountMinor: 6500, currency: 'EUR' }` : seule son
    // écriture suit la langue et la région (payments-stripe §5).
    expect(digits(french)).toBe(String(TOTAL.amountMinor));
    expect(digits(english)).toBe(String(TOTAL.amountMinor));
    expect(digits(french)).toBe(digits(english));
    // Et le front n'a rien recomposé : 54,17 HT + 10,83 de TVA + 5,00 de
    // pourboire font bien les 65,00 que le serveur a figés, mais c'est le
    // serveur qui le dit.
    expect(TOTAL.amountMinor).toBe(6500);
  });

  it('garde l’heure du salon, quelle que soit la langue du ticket', () => {
    for (const locale of ['fr', 'en'] as const) {
      const { text } = print(locale);

      // 07:05 UTC, soit 10:05 à Antananarivo. Un ticket horodaté en UTC — ou
      // dans le fuseau du navigateur — est un bug de sévérité haute
      // (`CLAUDE.md`).
      expect(text, `l’heure du salon manque au ticket « ${locale} »`).toContain('10:05');
      expect(text, `le ticket « ${locale} » horodate en UTC`).not.toContain('07:05');
    }
  });

  it('met en forme l’instant par `lib/format.ts`, et par rien d’autre', () => {
    // La mise en forme suit la langue — c'est ce que le critère autorise — mais
    // elle passe par le module qui impose le fuseau, jamais par un
    // `toLocaleString` posé dans le composant.
    for (const locale of ['fr', 'en'] as const) {
      expect(print(locale).text).toContain(
        formatTicketDateTime(ISSUED_AT, TIME_ZONE, { locale, countryCode: 'MG' }),
      );
    }
  });

  /**
   * La région vient du **pays du salon**, et le comptoir la tient de sa page.
   *
   * L'adresse de la pièce porte bien le même pays, mais l'API l'omet **en
   * entier** tant que la rue, la ville et le pays ne sont pas tous les trois
   * renseignés (`toIssuerDto`). Un salon malgache sans rue publiée retomberait
   * alors sur `en-US` et daterait son rouleau « 09/05/2026 » — à l'américaine —
   * sous un bandeau qui, lui, dit « 05/09/2026 ».
   */
  it('date le rouleau dans la région du salon même sans adresse publiée', () => {
    const { address: _omitted, ...issuer } = RECEIPT.issuer;
    const anonymous: SaleReceipt = { ...RECEIPT, issuer };

    expect(print('en', anonymous, 'MG').text).toContain('05/09/2026');
    expect(print('en', anonymous, 'MG').text).not.toContain('09/05/2026');
    // Sans pays passé, et sans adresse sur la pièce, le repli documenté de
    // `lib/format.ts` s'applique — `en` → `en-US`.
    expect(print('en', anonymous).text).toContain('09/05/2026');
  });
});
