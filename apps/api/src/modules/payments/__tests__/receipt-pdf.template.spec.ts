import { renderReceipt, type TemplateContext } from '../receipt-pdf/receipt-pdf.template';
import type { SaleReceipt } from '../receipt.types';
import {
  ariaryReceiptFixture,
  receiptFixture,
  RecordingSurface,
  tippedReceiptFixture,
} from './receipt-pdf.doubles';

/**
 * Ce que le ticket porte, et dans quel ordre — #819, troisième, quatrième,
 * cinquième et septième critères ; #1230, troisième critère, pour les deux
 * langues.
 *
 * La planche enregistre au lieu de dessiner : voir `receipt-pdf.doubles.ts` pour
 * la raison. Ce que le PDF réel prouve en plus est dans
 * `receipt-pdf.service.spec.ts`.
 */

const BOOKING_URL = 'https://app.spa.test/barber-tana/reservation';

function context(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    variant: 'ticket-80',
    receiptNumber: 'TIC-2026-000123',
    bookingUrl: BOOKING_URL,
    locale: 'fr',
    ...overrides,
  };
}

function render(receipt = receiptFixture(), ctx = context()): RecordingSurface {
  const surface = new RecordingSurface();

  renderReceipt(surface, receipt, ctx);

  return surface;
}

describe('le ticket 80 mm', () => {
  /**
   * Le troisième critère énumère huit sections « dans l'ordre d'un ticket de
   * caisse ». C'est cet ordre-là qui est figé ici : une section déplacée casse
   * ce test, ce qu'aucune inspection du PDF n'aurait dit.
   */
  it('porte les huit sections dans l’ordre du ticket de caisse', () => {
    const surface = render();

    const ranks = [
      surface.indexOf('Barber Tana'), // 1 — en-tête
      surface.indexOf('TIC-2026-000123'), // 2 — numéro de pièce
      surface.indexOf('Camille Roux'), // 3 — caissier
      surface.indexOf('Soin éclat 45 min'), // 4 — lignes
      surface.indexOf('TVA 20'), // 5 — ventilation
      surface.indexOf('TOTAL'), // 6 — total
      surface.indexOf('Espèces'), // 7 — règlement
      surface.indexOf('Merci de votre visite'), // 8 — pied
    ];

    expect(ranks).not.toContain(-1);
    expect(ranks).toStrictEqual([...ranks].sort((left, right) => left - right));
  });

  it('porte l’identité légale et les coordonnées du salon', () => {
    const text = render().text_;

    expect(text).toContain('TANA COIFFURE SARL');
    expect(text).toContain('SIRET 73282932000074');
    expect(text).toContain('TVA FR40303265045');
    expect(text).toContain('12 rue des Lilas');
    expect(text).toContain('75011 Paris');
    expect(text).toContain('contact@barber-tana.test');
  });

  it('date la pièce dans le fuseau du salon', () => {
    expect(render().text_).toContain('17/09/2026 à 11:30');
  });

  it('nomme le caissier et le praticien', () => {
    const text = render().text_;

    expect(text).toContain('Caissier');
    expect(text).toContain('Camille Roux');
    expect(text).toContain('Praticien');
    expect(text).toContain('Léa Martin');
  });

  it('porte chaque ligne avec son total, et le détail des quantités', () => {
    const text = render().text_;

    expect(text).toContain('Soin éclat 45 min');
    expect(text).toContain('65,00');
    expect(text).toContain('Huile capillaire 100 ml');
    expect(text).toContain('31,00');
    expect(text).toContain('2 × 15,50');
  });

  /**
   * Sixième critère : « une vente multi-lignes à **deux taux** ».
   *
   * L'espace qui précède le pour-cent est une **insécable** — `Intl` la pose, et
   * Roboto la porte, à la différence de l'espace fine que `printable` remplace.
   * Le test l'écrit telle quelle plutôt que de la normaliser : c'est ce qui
   * s'imprime, et un jour où elle deviendrait une espace fine, il faut que ce
   * soit ici que cela se voie.
   */
  it('ventile la taxe taux par taux', () => {
    const text = render().text_;

    expect(text).toContain('TVA 20\u00A0%');
    expect(text).toContain('10,83');
    expect(text).toContain('TVA 5,5\u00A0%');
    expect(text).toContain('1,62');
    expect(text).toContain('Total TVA');
    expect(text).toContain('12,45');
    expect(text).not.toContain('\u202F');
  });

  it('n’imprime aucune ventilation quand le salon n’est pas assujetti', () => {
    const receipt = receiptFixture({
      taxBreakdown: [],
      taxTotal: { amountMinor: 0, currency: 'EUR' },
    });

    expect(render(receipt).text_).not.toContain('TVA 0');
    expect(render(receipt).text_).not.toContain('Total TVA');
  });

  it('porte le total', () => {
    const surface = render();
    const total = surface.calls.find((call) => call.label === 'TOTAL');

    expect(total?.amount).toContain('96,00');
    expect(total?.weight).toBe('bold');
  });

  it('imprime le pourboire lorsqu’il y en a un, et se tait sinon', () => {
    expect(render().text_).not.toContain('Pourboire');
    expect(render(tippedReceiptFixture()).text_).toContain('Pourboire');
  });

  /**
   * **Le constat de la recette de #819**, figé ici.
   *
   * `composeSale` matérialise la taxe et le pourboire en `sale_items` en plus
   * des colonnes qui les agrègent (`pos.totals.ts`). Les imprimer dans la
   * section des lignes **et** dans les sections qui leur sont dédiées les
   * affichait deux fois : sur une vente réelle de 34,00 €, le ticket portait
   * « Pourboire 3,00 € » deux fois et ne tombait plus sur son total.
   *
   * La garantie est comptée, et non cherchée : exactement une occurrence.
   */
  it('n’imprime la taxe et le pourboire qu’une fois, malgré leurs lignes de vente', () => {
    const text = render(tippedReceiptFixture()).text_;

    expect(text.match(/Pourboire/g)).toHaveLength(1);
    // L'espace insécable est échappé et non posé au clair : `no-irregular-whitespace`
    // refuse ce caractère dans une source, où il est de toute façon invisible.
    expect(text.match(/TVA 20\u00A0%/g)).toHaveLength(1);

    // Et les montants de la colonne de droite tombent sur le total : les lignes
    // vendues seules, puis la ventilation, puis le total.
    const amounts = render(tippedReceiptFixture())
      .calls.filter((call) => call.kind === 'row' && call.amount !== '')
      .map((call) => `${call.label}=${call.amount}`);

    expect(amounts.filter((entry) => entry.startsWith('Pourboire='))).toHaveLength(1);
  });

  /** Septième critère : « quand une vente a plusieurs règlements, il les liste tous ». */
  it('liste tous les règlements, et la monnaie rendue', () => {
    const text = render().text_;

    expect(text).toContain('Espèces');
    expect(text).toContain('50,00');
    expect(text).toContain('Carte bancaire (TPE)');
    expect(text).toContain('46,00');
    expect(text).toContain('Reçu');
    expect(text).toContain('60,00');
    expect(text).toContain('Rendu');
    expect(text).toContain('10,00');
  });

  /**
   * **Septième critère, la garantie qui compte.** Ce n'est pas un masquage : le
   * modèle du reçu ne porte aucune de ces données, et il n'y a donc rien à
   * filtrer (payments-stripe §1).
   */
  it('ne porte aucune donnée de carte', () => {
    const surface = render();
    const text = surface.text_;

    expect(text).not.toMatch(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/);
    expect(text).not.toMatch(/\*{4}/);
    expect(text).not.toMatch(/\b(visa|mastercard|amex|cvc|cvv|pan)\b/i);

    // Le libellé d'un règlement est l'un des deux, au caractère près : c'est là,
    // et nulle part ailleurs, qu'une donnée de carte aurait pu se glisser.
    const methods = surface.calls
      .filter((call) => call.amount.includes('€') && call.label !== 'TOTAL')
      .map((call) => call.label);

    // Depuis #834, la ligne porte **la référence du ticket du TPE** quand le
    // caissier l'a relevée. Ce n'est pas un relâchement de la garantie
    // ci-dessus : `A0000123` est un identifiant d'opération émis par la banque
    // du salon, la frontière HTTP refuse en 400 ce qui ressemble à un numéro de
    // carte, et les trois assertions précédentes continuent de l'exiger ici.
    expect(methods).toContain('Carte bancaire (TPE) — réf. A0000123');
    expect(methods.filter((label) => label.toLowerCase().includes('carte'))).toStrictEqual([
      'Carte bancaire (TPE) — réf. A0000123',
    ]);
  });

  it('porte les mentions du salon, le remerciement et le QR du lien de réservation', () => {
    const surface = render();

    expect(surface.text_).toContain('Aucun remboursement après 14 jours.');
    expect(surface.text_).toContain('Merci de votre visite !');
    expect(surface.calls.some((call) => call.kind === 'qr')).toBe(true);
  });

  it('liste les avoirs émis sur la vente', () => {
    const receipt = receiptFixture({
      refunds: [
        {
          rank: 1,
          amount: { amountMinor: 2000, currency: 'EUR' },
          issuedAt: new Date('2026-09-18T08:00:00.000Z'),
          reason: 'Prestation écourtée',
        },
      ],
    });
    const text = render(receipt).text_;

    expect(text).toContain('Avoirs');
    expect(text).toContain('TIC-2026-000123-R1');
    expect(text).toContain('20,00');
    expect(text).toContain('Prestation écourtée');
    expect(text).toContain('18/09/2026');
  });

  /**
   * Un ticket non clos n'a pas de numéro (#818). Le document doit le dire :
   * laisser circuler un document d'allure comptable qui n'en est pas un est pire
   * que n'en produire aucun.
   */
  it('se déclare provisoire tant que la vente n’est pas close', () => {
    const receipt = receiptFixture({ sequence: null, issuedAt: null });
    const text = render(receipt, context({ receiptNumber: null })).text_;

    expect(text).toContain('TICKET PROVISOIRE');
    expect(text).toContain('n’est pas une pièce comptable');
    expect(text).not.toContain('TIC-2026-000123');
  });

  it('dit qu’aucun règlement n’a encore été pris', () => {
    expect(render(receiptFixture({ settlements: [] })).text_).toContain(
      'Aucun règlement enregistré.',
    );
  });
});

describe('le ticket en ariary', () => {
  /** Sixième critère : « rendu d'une vente multi-lignes à deux taux, en MGA ». */
  it('rend les montants sans décimale et avec le symbole Ar', () => {
    const text = render(ariaryReceiptFixture()).text_;

    expect(text).toContain('Ar');
    expect(text).not.toContain('MGA');
    expect(text).not.toContain('240,00');
    expect(text).toContain('24');
    expect(text).toContain('000');
  });

  it('date la pièce dans le fuseau malgache', () => {
    expect(render(ariaryReceiptFixture()).text_).toContain('17/09/2026 à 12:30');
  });

  it('rend la monnaie en ariary entiers', () => {
    const surface = render(ariaryReceiptFixture());
    const change = surface.calls.find((call) => call.label === 'Rendu');

    expect(change?.amount).toContain('1');
    expect(change?.amount).toContain('000');
    expect(change?.amount).not.toContain(',');
  });
});

describe('la facture A4', () => {
  const invoice = context({ variant: 'a4' });

  /** Quatrième critère : « la mention *Facture n° …* ». */
  it('porte la mention « Facture n° »', () => {
    expect(render(receiptFixture(), invoice).text_).toContain('Facture n° TIC-2026-000123');
  });

  /**
   * Quatrième critère : « l'adresse de la cliente **quand elle est connue** ».
   * Elle ne l'est jamais — `users` ne porte aucune adresse —, la facture nomme
   * donc la cliente et rien de plus. Voir l'en-tête de `parties`.
   */
  it('nomme la cliente à facturer', () => {
    const text = render(receiptFixture(), invoice).text_;

    expect(text).toContain('Facturé à');
    expect(text).toContain('Awa Diallo');
  });

  it('porte les mêmes données que le ticket', () => {
    const text = render(receiptFixture(), invoice).text_;

    expect(text).toContain('TANA COIFFURE SARL');
    expect(text).toContain('Soin éclat 45 min');
    expect(text).toContain('TVA 20\u00A0%');
    expect(text).toContain('TOTAL');
    expect(text).toContain('Carte bancaire (TPE)');
    expect(text).toContain('Merci de votre visite !');
  });

  it('se déclare proforma tant que la vente n’est pas close', () => {
    const receipt = receiptFixture({ sequence: null, issuedAt: null });

    expect(render(receipt, context({ variant: 'a4', receiptNumber: null })).text_).toContain(
      'FACTURE PROFORMA',
    );
  });
});

/**
 * **#1230, troisième critère** — le même gabarit, en anglais.
 *
 * Ce bloc est le pendant exact du premier : mêmes sections, même ordre, même
 * jeu d'essai. Ce qu'il ajoute est ce qu'aucun test français ne peut dire — que
 * pas un libellé n'est resté écrit en dur.
 */
describe('le ticket 80 mm en anglais', () => {
  const english = context({ locale: 'en' });

  it('porte les huit sections dans l’ordre du ticket de caisse', () => {
    const surface = render(receiptFixture(), english);

    const ranks = [
      surface.indexOf('Barber Tana'), // 1 — en-tête
      surface.indexOf('TIC-2026-000123'), // 2 — numéro de pièce
      surface.indexOf('Camille Roux'), // 3 — caissier
      surface.indexOf('Soin éclat 45 min'), // 4 — lignes
      surface.indexOf('VAT 20'), // 5 — ventilation
      surface.indexOf('TOTAL'), // 6 — total
      // « Tendered », et non « Cash » : « Cashier » le contient, et le repère de
      // la septième section serait tombé sur la troisième.
      surface.indexOf('Tendered'), // 7 — règlement
      surface.indexOf('Thank you for your visit'), // 8 — pied
    ];

    expect(ranks).not.toContain(-1);
    expect(ranks).toStrictEqual([...ranks].sort((left, right) => left - right));
  });

  it('nomme les parties et les totaux en anglais', () => {
    const text = render(receiptFixture(), english).text_;

    expect(text).toContain('Cashier');
    expect(text).toContain('Practitioner');
    expect(text).toContain('Client');
    expect(text).toContain('Subtotal excl. tax');
    expect(text).toContain('Total VAT');
    expect(text).toContain('VAT FR40303265045');
  });

  it('nomme les règlements et la monnaie rendue en anglais', () => {
    const text = render(receiptFixture(), english).text_;

    expect(text).toContain('Cash');
    expect(text).toContain('Card (terminal) — ref. A0000123');
    expect(text).toContain('Tendered');
    expect(text).toContain('Change');
  });

  it('imprime le pourboire et les avoirs en anglais', () => {
    expect(render(tippedReceiptFixture(), english).text_).toContain('Tip');

    const refunded = receiptFixture({
      refunds: [
        {
          rank: 1,
          amount: { amountMinor: 2000, currency: 'EUR' },
          issuedAt: new Date('2026-09-18T08:00:00.000Z'),
          reason: 'Service cut short',
        },
      ],
    });
    const text = render(refunded, english).text_;

    expect(text).toContain('Refunds');
    expect(text).toContain('TIC-2026-000123-R1');
    // Le salon de la doublure est **parisien** : l'avoir garde donc l'ordre
    // français même sur une pièce anglaise (#1325). C'était « 09/18/2026 ».
    expect(text).toContain('18/09/2026');
  });

  it('se déclare provisoire en anglais tant que la vente n’est pas close', () => {
    const receipt = receiptFixture({ sequence: null, issuedAt: null });
    const text = render(receipt, context({ locale: 'en', receiptNumber: null })).text_;

    expect(text).toContain('PROVISIONAL RECEIPT');
    expect(text).toContain('not an accounting record');
    expect(text).toContain('Sale opened on');
  });

  it('dit qu’aucun règlement n’a encore été pris, en anglais', () => {
    expect(render(receiptFixture({ settlements: [] }), english).text_).toContain(
      'No payment recorded.',
    );
  });

  /**
   * **La garantie que la traduction ne relâche rien.** Le septième critère de
   * #819 tient dans les deux langues : le vocabulaire anglais est exactement
   * l'endroit où une donnée de carte pourrait se glisser sans relecture.
   */
  it('ne porte aucune donnée de carte', () => {
    const text = render(receiptFixture(), english).text_;

    expect(text).not.toMatch(/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/);
    expect(text).not.toMatch(/\*{4}/);
    expect(text).not.toMatch(/\b(visa|mastercard|amex|cvc|cvv|pan)\b/i);
  });
});

/**
 * **#1230, premier et deuxième critères** — la frontière entre ce qui suit la
 * langue et ce qui ne la suit jamais.
 */
describe('ce que la langue change, et ce qu’elle ne change pas', () => {
  const amountsOf = (locale: 'fr' | 'en'): string[] =>
    render(tippedReceiptFixture(), context({ locale }))
      .calls.filter((call) => call.kind === 'row' && call.amount !== '')
      .map((call) => call.amount.replaceAll(/\D/g, ''));

  /**
   * Les chiffres des deux pièces, dans le même ordre, sont identiques. Seuls
   * les séparateurs et la place du symbole diffèrent — c'est ce qui permet de
   * rapprocher une pièce anglaise d'un relevé sans la retraduire.
   */
  it('porte exactement les mêmes montants dans les deux langues', () => {
    expect(amountsOf('en')).toStrictEqual(amountsOf('fr'));
    expect(amountsOf('fr').length).toBeGreaterThan(0);
  });

  /**
   * **#1325, deuxième critère.** Le salon de la doublure est parisien : ses deux
   * pièces portent donc la **même** écriture des nombres, et seuls les mots
   * changent. La place du symbole, elle, suit bien la langue — c'est une règle de
   * CLDR sur laquelle le produit ne revient pas.
   *
   * L'anglais rendait « €65.00 » : la région venait alors de la langue, et non du
   * salon.
   */
  it('écrit ces montants dans la convention du salon, dans les deux langues', () => {
    expect(render(receiptFixture(), context({ locale: 'fr' })).text_).toContain('65,00');
    expect(render(receiptFixture(), context({ locale: 'en' })).text_).toContain('65,00');
  });

  /**
   * Le fuseau décide de **quel jour** on parle, le **pays du salon** de comment
   * on l'écrit, la langue des seuls mots (#1325). Les deux pièces datent du même
   * 17 septembre, à la même heure, et l'écrivent pareil : ce salon est parisien.
   *
   * L'anglais rendait « 09/17/2026 at 11:30 AM », c'est-à-dire l'écriture d'un
   * salon américain pour un salon du 11e arrondissement.
   */
  it('date la pièce du même instant, et l’écrit de la même façon', () => {
    expect(render(receiptFixture(), context({ locale: 'fr' })).text_).toContain(
      '17/09/2026 à 11:30',
    );
    expect(render(receiptFixture(), context({ locale: 'en' })).text_).toContain(
      '17/09/2026 at 11:30',
    );
  });

  /**
   * **#1325, deuxième critère — le salon américain.** Le même instant, le même
   * fuseau, un salon dont le pays est `US` : la pièce passe en 12 heures et en
   * mois d'abord, et c'est la seule chose qui change.
   *
   * C'est le cas que la recette de #1325 n'avait pas pu vérifier — « aucun salon
   * US n'est actif en local ». Il se vérifie ici.
   */
  it('écrit un salon américain à l’américaine, mois d’abord et 12 heures', () => {
    const americain = receiptFixture({
      issuer: { ...receiptFixture().issuer, countryCode: 'US', timezone: 'America/New_York' },
    });

    expect(render(americain, context({ locale: 'en' })).text_).toContain('09/17/2026 at 05:30 AM');
    expect(render(americain, context({ locale: 'en' })).text_).toContain('€65.00');
    // Le même salon lu en français : 24 heures, parce que c'est la convention
    // que porte `fr-US` — mais une seule convention, sur toute la pièce.
    expect(render(americain, context({ locale: 'fr' })).text_).toContain('17/09/2026 à 05:30');
  });

  /**
   * L'enseigne, l'identité légale, le libellé d'une prestation, les mentions de
   * pied : ce sont des **saisies du salon**, pas des libellés. Les traduire
   * reviendrait à réécrire ce que le gérant a écrit.
   */
  it('n’altère jamais ce que le salon a saisi', () => {
    const text = render(receiptFixture(), context({ locale: 'en' })).text_;

    expect(text).toContain('Barber Tana');
    expect(text).toContain('TANA COIFFURE SARL');
    expect(text).toContain('SIRET 73282932000074');
    expect(text).toContain('Soin éclat 45 min');
    expect(text).toContain('Aucun remboursement après 14 jours.');
  });

  /** Le nombre de décimales vient de la devise, jamais de la langue. */
  it('rend l’ariary sans décimale dans les deux langues', () => {
    for (const locale of ['fr', 'en'] as const) {
      const surface = render(ariaryReceiptFixture(), context({ locale }));
      const total = surface.calls.find((call) => call.label === 'TOTAL');

      expect(total?.amount).toContain('Ar');
      expect(total?.amount).not.toContain('MGA');
      expect(total?.amount?.replaceAll(/\D/g, '')).toBe('24000');
    }
  });
});

/**
 * **#1334** — l'ordre de la localité suit le pays du salon, sur le PDF comme sur
 * la vitrine.
 *
 * Le gabarit recomposait `[postalCode, city].join(' ')` de son côté, faute de
 * pouvoir atteindre le module du front qui portait la règle. Un salon de
 * Manhattan imprimait donc « 10118 New York » sur son reçu pendant que sa page
 * publique annonçait déjà « New York 10118 ».
 *
 * Les deux cas sont exigés par le quatrième critère : un salon US et un salon FR,
 * sur chaque surface.
 */
describe('l’adresse de l’émetteur suit le pays du salon', () => {
  function issuedFrom(issuer: Partial<SaleReceipt['issuer']>): string {
    const base = receiptFixture();

    return render(receiptFixture({ issuer: { ...base.issuer, ...issuer } })).text_;
  }

  it('écrit la ville avant le code postal pour un salon américain', () => {
    const text = issuedFrom({
      addressLine1: '350 5th Avenue',
      postalCode: '10118',
      city: 'New York',
      countryCode: 'US',
    });

    expect(text).toContain('New York 10118');
    expect(text).not.toContain('10118 New York');
  });

  it('écrit le code postal en tête pour un salon français', () => {
    const text = issuedFrom({ postalCode: '75011', city: 'Paris', countryCode: 'FR' });

    expect(text).toContain('75011 Paris');
    expect(text).not.toContain('Paris 75011');
  });

  /**
   * L'État, et la virgule qui l'accompagne (#1335). `region` ne remontait pas
   * jusqu'à la pièce : le reçu écrivait « New York 10118 » là où la vitrine du
   * même salon annonçait déjà « New York, NY 10118 ».
   */
  it('écrit l’État d’un salon nord-américain', () => {
    const text = issuedFrom({
      addressLine1: '350 5th Avenue',
      postalCode: '10118',
      city: 'New York',
      region: 'NY',
      countryCode: 'US',
    });

    expect(text).toContain('New York, NY 10118');
  });

  /**
   * Un salon passé des États-Unis à la France garde « NY » en colonne : la règle
   * du contrat ne l'écrit pas dans une adresse qui ne sait pas où le mettre.
   */
  it('n’écrit pas d’État sur un salon d’un pays qui n’en porte pas', () => {
    const text = issuedFrom({
      postalCode: '75011',
      city: 'Paris',
      region: 'NY',
      countryCode: 'FR',
    });

    expect(text).toContain('75011 Paris');
    expect(text).not.toContain('NY');
  });

  /**
   * La langue de la pièce (#1230) ne réordonne rien : c'est le pays du salon qui
   * décide, parce que c'est ce qu'on écrit sur l'enveloppe qu'on lui poste.
   */
  it('garde l’ordre du pays quel que soit la langue du document', () => {
    const base = receiptFixture();
    const manhattan = receiptFixture({
      issuer: { ...base.issuer, postalCode: '10118', city: 'New York', countryCode: 'US' },
    });

    expect(render(manhattan, context({ locale: 'fr' })).text_).toContain('New York 10118');
    expect(render(base, context({ locale: 'en' })).text_).toContain('75011 Paris');
  });
});

describe('la facture A4 en anglais', () => {
  const invoice = context({ variant: 'a4', locale: 'en' });

  it('porte la mention « Invoice no. »', () => {
    expect(render(receiptFixture(), invoice).text_).toContain('Invoice no. TIC-2026-000123');
  });

  it('nomme la cliente à facturer', () => {
    const text = render(receiptFixture(), invoice).text_;

    expect(text).toContain('Billed to');
    expect(text).toContain('Awa Diallo');
  });

  it('se déclare proforma tant que la vente n’est pas close', () => {
    const receipt = receiptFixture({ sequence: null, issuedAt: null });

    expect(
      render(receipt, context({ variant: 'a4', locale: 'en', receiptNumber: null })).text_,
    ).toContain('PRO FORMA INVOICE');
  });
});
