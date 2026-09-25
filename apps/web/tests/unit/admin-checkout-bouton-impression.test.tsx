import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locale, SaleReceipt } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/** Ce fichier, d'où part la racine d'`apps/web` lue par la garde de lint. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Le bouton qui imprime le ticket de caisse, dans la langue de la session —
 * #1199.
 *
 * ## Ce que cette suite protège
 *
 * #1248 a traduit le **rouleau** ; le bouton qui l'imprime, lui, tenait son
 * libellé d'une prop à défaut français (`label = 'Imprimer le ticket'`) que son
 * unique appelant ne passait pas. Sur l'écran anglais, le pied de l'aperçu
 * disait donc « Imprimer le ticket », « Receipt PDF », « A4 invoice » — un mot
 * français au milieu de deux boutons traduits, sous une pièce comptable
 * entièrement en anglais. C'est le dernier écart relevé par la recette de #850.
 *
 * Quatre choses sont vérifiées, et elles ne sont pas de même nature :
 *
 * - **le libellé suit la langue**, et c'est bien la phrase du catalogue qui
 *   s'affiche — comparée au catalogue lu sur le disque, pas à une chaîne
 *   recopiée ici, qui ne prouverait que sa propre existence ;
 * - **rien ne reste en français** sur le bouton anglais — l'assertion qui
 *   attrape un retour en arrière, là où la première se contenterait de constater
 *   que l'anglais est juste ;
 * - **le mécanisme d'impression n'a pas bougé** : la copie du ticket se monte
 *   sous `<body>`, `<html>` porte `data-printing="ticket"`, et ce qui part à
 *   l'imprimante est le rouleau dans la langue de la session — pas un second
 *   rendu figé sur une autre ;
 * - **la règle de lint anti-texte-en-dur couvre le périmètre du ticket**, sans
 *   quoi un littéral pourrait y revenir sans qu'aucun outil ne le dise.
 *
 * ## La langue bouge, et c'est la doublure partagée qui la déplace
 *
 * L'amorce des suites fixe la langue à `fr` (#845, `tests/support/next-intl.ts`).
 * Ce qu'on veut éprouver est le **changement** de langue : `nextIntlMobile()`
 * remplace les crochets par une doublure dont `fixerLangue()` choisit la langue
 * avant chaque rendu (`tests/support/langue-mobile.ts`, #1192, #1277). Elle est
 * partagée et non recopiée ici : chaque suite a son propre registre de modules,
 * si bien que la variable de langue ne franchit pas la frontière d'un fichier —
 * et deux copies du même `vi.mock` se seraient mises à diverger.
 */

vi.mock('next-intl', () => nextIntlMobile());

import { ReceiptTicket } from '@/app/(admin)/[tenantSlug]/admin/components/receipt-ticket';
import { TicketPrinter } from '@/app/(admin)/[tenantSlug]/admin/components/ticket-printer';

/** Le message rangé à ce chemin, ou l'échec du test s'il manque au catalogue. */
function message(tree: MessageTree, chemin: string): string {
  let courant: MessageTree | string = tree;

  for (const segment of chemin.split('.')) {
    if (typeof courant === 'string') {
      throw new Error(`« ${chemin} » traverse un message, pas un groupe`);
    }

    const suivant: MessageTree | string | undefined = courant[segment];

    if (suivant === undefined) {
      throw new Error(`« ${chemin} » manque au catalogue`);
    }

    courant = suivant;
  }

  if (typeof courant !== 'string') {
    throw new Error(`« ${chemin} » désigne un groupe, pas un message`);
  }

  return courant;
}

/**
 * Le libellé attendu, lu sur le catalogue — jamais recopié dans le test.
 *
 * Par `loadMessages`, qui **possède** la convention
 * `messages/<langue>/<namespace>.json` (`i18n/messages.ts`) : un chemin
 * reconstruit ici en serait la seconde copie, et survivrait muet au jour où la
 * première changerait.
 */
function catalogPrintLabel(locale: Locale): string {
  return message(loadMessages(locale), 'admin-checkout.receipt.print');
}

/** Le pied du rouleau, qui dit dans quelle langue la copie s'est rendue. */
function catalogThanks(locale: Locale): string {
  return message(loadMessages(locale), 'admin-checkout.receipt.thanks');
}

/** L'instant de la pièce : 07:05 UTC, soit 10:05 au salon d'Antananarivo. */
const ISSUED_AT = '2026-09-05T07:05:00.000Z';

/** Un ticket clos minimal — ce qu'il faut pour que le rouleau se rende. */
const RECEIPT: SaleReceipt = {
  saleId: '99999999-0000-4000-8000-000000000011',
  number: 'TIC-2026-000199',
  sequence: 199,
  issuedAt: ISSUED_AT,
  openedAt: '2026-09-05T06:50:00.000Z',
  timezone: 'Indian/Antananarivo',
  issuer: { name: 'Maison Lotus' },
  cashier: { displayName: 'Hasina' },
  client: { displayName: 'Rina Andriamana' },
  practitioner: null,
  lines: [
    {
      position: 0,
      kind: 'SERVICE',
      label: 'Massage suédois',
      quantity: 1,
      unitPrice: { amountMinor: 6500, currency: 'EUR' },
      total: { amountMinor: 6500, currency: 'EUR' },
    },
  ],
  taxBreakdown: [],
  subtotal: { amountMinor: 6500, currency: 'EUR' },
  taxTotal: { amountMinor: 0, currency: 'EUR' },
  tip: { amountMinor: 0, currency: 'EUR' },
  total: { amountMinor: 6500, currency: 'EUR' },
  settlements: [
    {
      method: 'CASH',
      cardChannel: null,
      amount: { amountMinor: 6500, currency: 'EUR' },
      capturedAt: ISSUED_AT,
    },
  ],
  refunds: [],
};

/** Les appels à `window.print()` — jsdom n'imprime pas, il faut les compter. */
let printCalls = 0;

beforeEach(() => {
  printCalls = 0;
  // `defineProperty` et non `vi.spyOn` : jsdom déclare `print` en lecture seule
  // sur le prototype de la fenêtre, et l'espion échouerait à le remplacer.
  Object.defineProperty(window, 'print', {
    configurable: true,
    writable: true,
    value: () => {
      printCalls += 1;
    },
  });
});

afterEach(() => {
  cleanup();
  fixerLangue('fr');
  document.documentElement.removeAttribute('data-printing');
});

/** Monte le bouton dans une langue, le rouleau de la vente en enfant. */
function mount(locale: Locale): HTMLButtonElement {
  fixerLangue(locale);

  render(
    <TicketPrinter>
      <ReceiptTicket receipt={RECEIPT} />
    </TicketPrinter>,
  );

  return screen.getByRole('button');
}

/** Ce que le portail d'impression porte, ou `''` s'il n'est pas monté. */
function printedCopy(): string {
  return document.querySelector('[data-print-ticket]')?.textContent ?? '';
}

describe('le bouton d’impression du ticket de caisse', () => {
  it('dit « Imprimer le ticket » quand la session est en français', () => {
    expect(mount('fr').textContent).toBe(catalogPrintLabel('fr'));
  });

  it('le dit en anglais quand la session est en anglais', () => {
    expect(mount('en').textContent).toBe(catalogPrintLabel('en'));
  });

  it('ne laisse plus un mot français sur le bouton anglais', () => {
    const label = mount('en').textContent ?? '';

    expect(label).not.toMatch(/imprimer|ticket de caisse/iu);
    expect(label.trim()).not.toBe('');
  });

  it('ne dit pas la même chose dans les deux langues', () => {
    // Le garde-fou des deux assertions précédentes : deux catalogues qui
    // porteraient la même phrase les laisseraient passer sans rien prouver.
    expect(catalogPrintLabel('fr')).not.toBe(catalogPrintLabel('en'));
  });
});

describe('ce que la traduction du libellé ne change pas', () => {
  it('n’imprime rien tant que personne n’a cliqué', () => {
    mount('fr');

    expect(printCalls).toBe(0);
    expect(printedCopy()).toBe('');
    expect(document.documentElement.hasAttribute('data-printing')).toBe(false);
  });

  it('monte la copie sous « body » et lance l’impression au clic', async () => {
    await userEvent.click(mount('fr'));

    expect(printCalls).toBe(1);
    expect(printedCopy()).toContain(catalogThanks('fr'));
  });

  it('imprime le rouleau dans la langue de la session, pas dans une autre', async () => {
    // C'est le deuxième critère du ticket : ce qui part à l'imprimante est ce
    // que l'aperçu montre — le portail rend le même composant, sous la même
    // langue.
    await userEvent.click(mount('en'));

    expect(printedCopy()).toContain(catalogThanks('en'));
    expect(printedCopy()).not.toContain(catalogThanks('fr'));
  });

  it('réimprime au second clic, sans attendre « afterprint »', async () => {
    // Le compteur de `TicketPrinter`, et non un booléen : un navigateur qui ne
    // signale pas la fin de l'impression ne doit pas empêcher d'imprimer à
    // nouveau.
    const button = mount('fr');

    await userEvent.click(button);
    await userEvent.click(button);

    expect(printCalls).toBe(2);
  });
});

describe('la règle de lint anti-texte-en-dur couvre le périmètre du ticket', () => {
  /**
   * Le premier critère de #1199 ne demande pas seulement que le libellé vienne
   * du catalogue : il demande que la **règle soit active** sur le bouton comme
   * sur le module du rouleau. Sans cette garde, retirer `ticket-printer.tsx` du
   * marqueur **partagé** d'`admin/components/`, ou le marqueur de `lib/admin/`
   * tout entier, ne ferait échouer aucun test : `eslint` passerait sans rien
   * regarder, et « Imprimer le ticket » réécrit en dur reviendrait sans un mot.
   */
  it('vise le bouton d’impression et les règles pures du ticket', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));

    expect(globs).toContain(
      'app/\\(admin\\)/\\[tenantSlug\\]/admin/components/ticket-printer.tsx',
    );
    expect(globs).toContain('lib/admin/receipt-ticket.ts');
  });
});
