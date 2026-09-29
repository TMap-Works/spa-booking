import { LOCALES, type Locale } from '@spa/shared';

import {
  bookingUrl,
  contentDisposition,
  formatDate,
  formatDateTime,
  formatMoney,
  formatSettlementMethod,
  formatTaxRate,
  printable,
  receiptFileName,
} from '../receipt-pdf/receipt-pdf.format';
import { type ReceiptDisplay } from '../receipt-pdf/receipt-pdf.locale';
import { receiptVocabulary } from '../receipt-pdf/receipt-pdf.vocabulary';

/**
 * La mise en forme de ce qui s'imprime — #819, cinquième et septième critères ;
 * #1230 pour les deux langues ; #1325 pour la région et le cycle horaire.
 *
 * Ce qui se prouve ici : qu'un entier devient le bon montant dans sa devise, que
 * les instants sont rendus dans le fuseau du salon, qu'aucune ligne de règlement
 * ne porte quoi que ce soit d'une carte — et que **la langue change l'écriture,
 * jamais la valeur**.
 *
 * ## Deux salons, quatre contextes — #1325, quatrième critère
 *
 * Chaque attente d'écriture est jouée pour un salon **parisien** et pour un salon
 * **new-yorkais**, dans les deux langues. C'est la seule façon de distinguer ce
 * que la **langue** décide — les mots — de ce que le **pays du salon** décide —
 * l'ordre d'une date, le cycle horaire, les séparateurs d'un nombre. Une suite
 * qui n'aurait que `'fr'` et `'en'` laisserait passer exactement la faute que
 * #1325 ferme : une pièce datée à l'américaine pour un salon parisien, au seul
 * motif qu'elle sortait en anglais.
 *
 * ## Les tests miroir, et à quoi ils servent
 *
 * Les chaînes attendues ici sont **les mêmes** que celles de
 * `apps/web/tests/unit/format.test.ts` et de
 * `apps/web/tests/unit/receipt-ticket.test.ts` pour les mêmes entrées. C'est ce
 * qui tient le premier critère de #1325 — *une seule fonction de locale de mise
 * en forme, utilisée par le front ET le PDF de l'API* — tant que `packages/shared`
 * n'héberge pas la fonction commune (voir l'en-tête de `receipt-pdf.locale.ts`).
 * Une divergence d'un côté fait rougir les deux suites, ce qu'une consigne de
 * relecture n'aurait pas donné.
 */

const PARIS = 'Europe/Paris';
const TANA = 'Indian/Antananarivo';
const NEW_YORK = 'America/New_York';

/** Un salon parisien — `fr-FR` en français, `en-FR` en anglais. */
const enFrance = (locale: Locale): ReceiptDisplay => ({ locale, countryCode: 'FR' });

/** Un salon new-yorkais — `fr-US` en français, `en-US` en anglais. */
const auxEtatsUnis = (locale: Locale): ReceiptDisplay => ({ locale, countryCode: 'US' });

/**
 * Les quatre contextes d'affichage du produit : deux langues × deux pays.
 *
 * Les garanties qui ne dépendent **ni** de la langue **ni** du pays — les
 * décimales d'une devise, le symbole étroit, l'absence d'espace fine insécable —
 * se rejouent sur les quatre : ce sont celles qu'un ticket doit tenir où qu'il
 * s'imprime, et les énumérer est ce qui empêche qu'un marché nouveau les perde.
 */
const SALONS: readonly ReceiptDisplay[] = LOCALES.flatMap((locale) => [
  enFrance(locale),
  auxEtatsUnis(locale),
]);

/**
 * L'espace insécable ordinaire — U+00A0 —, celle que `printable` substitue à
 * l'espace fine, et donc celle qui sépare les milliers sur le papier.
 *
 * Écrites par leur point de code plutôt qu'en littéral : deux espaces insécables
 * ne se distinguent pas à l'œil dans un fichier source, et c'est précisément la
 * distinction que ce module garantit.
 */
const MILLIERS = '\u00a0';

/** L'espace fine insécable — U+202F —, que Roboto ne porte pas. */
const ESPACE_FINE = '\u202f';

describe('formatMoney', () => {
  it('rend un montant en euros avec ses deux décimales', () => {
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' }, enFrance('fr'))).toContain('65,00');
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' }, enFrance('fr'))).toContain('€');
  });

  /**
   * #1230, deuxième critère : la même valeur, écrite comme l'anglais l'écrit — et
   * #1325, deuxième critère : comme l'anglais **de ce pays-là** l'écrit. Un salon
   * parisien garde la virgule décimale de son écran quand sa pièce sort en
   * anglais ; c'est un salon new-yorkais qui prend le point.
   */
  it('rend le même montant à l’anglaise, dans la région du salon', () => {
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' }, enFrance('en'))).toBe('€65,00');
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' }, auxEtatsUnis('en'))).toBe('€65.00');
  });

  /**
   * **#1325, deuxième critère.** CLDR déclare pour `en-FR` des séparateurs
   * **monétaires** distincts de ceux du nombre ordinaire : `Intl` seul rendrait
   * « €9,999.99 » juste au-dessus d'un taux écrit « 5,5% ». Un rouleau n'admet
   * qu'une convention à la fois, et c'est celle du nombre ordinaire.
   */
  it('n’emploie pas les séparateurs que CLDR réserve à la monnaie', () => {
    expect(formatMoney({ amountMinor: 999_999, currency: 'EUR' }, enFrance('en'))).toBe(
      `€9${MILLIERS}999,99`,
    );
    expect(formatTaxRate(550, enFrance('en'))).toBe('5,5%');

    // La même paire chez un salon new-yorkais : virgule et point, des deux côtés.
    expect(formatMoney({ amountMinor: 999_999, currency: 'EUR' }, auxEtatsUnis('en'))).toBe(
      '€9,999.99',
    );
    expect(formatTaxRate(550, auxEtatsUnis('en'))).toBe('5.5%');
  });

  /**
   * Le cœur du cinquième critère : « les décimales de la devise : 0 pour le
   * MGA ». Un `/100` en dur aurait rendu « 65,00 Ar » d'un ticket de 6 500 Ar.
   *
   * La garantie vaut dans les deux langues : c'est la **devise** qui décide du
   * nombre de décimales, et elle n'a rien à voir avec la langue du document.
   */
  it('rend un montant en ariary sans décimale, et sans le diviser', () => {
    for (const display of SALONS) {
      const formatted = formatMoney({ amountMinor: 6500, currency: 'MGA' }, display);

      expect(formatted).toContain('6');
      expect(formatted).toContain('500');
      expect(formatted).toContain('Ar');
      expect(formatted).not.toContain('65,00');
      expect(formatted).not.toContain('65.00');
    }
  });

  it('rend le symbole étroit, jamais le code à trois lettres', () => {
    for (const display of SALONS) {
      expect(formatMoney({ amountMinor: 24_000, currency: 'MGA' }, display)).not.toContain('MGA');
    }
  });

  it('ne perd pas un centime sur un montant qui n’est pas rond', () => {
    expect(formatMoney({ amountMinor: 1, currency: 'EUR' }, enFrance('fr'))).toContain('0,01');
    expect(formatMoney({ amountMinor: 9_999_99, currency: 'EUR' }, enFrance('fr'))).toContain(
      '99,99',
    );
    expect(formatMoney({ amountMinor: 1, currency: 'EUR' }, auxEtatsUnis('en'))).toContain('0.01');
    expect(formatMoney({ amountMinor: 9_999_99, currency: 'EUR' }, auxEtatsUnis('en'))).toContain(
      '99.99',
    );
  });

  /**
   * **#1230, deuxième critère.** Deux pièces de la même vente dans les deux
   * langues portent la **même valeur** — seuls les signes changent. C'est la
   * garantie qui protège le rapprochement comptable d'une traduction.
   */
  it('n’altère jamais la valeur d’un montant d’une langue à l’autre', () => {
    const chiffres = (formatted: string): string => formatted.replaceAll(/\D/g, '');

    for (const amountMinor of [1, 6500, 9_999_99, 1_234_567]) {
      expect(chiffres(formatMoney({ amountMinor, currency: 'EUR' }, enFrance('fr')))).toBe(
        chiffres(formatMoney({ amountMinor, currency: 'EUR' }, enFrance('en'))),
      );
      // Et d'un **pays** à l'autre : l'écriture change, la valeur non (#1325).
      expect(chiffres(formatMoney({ amountMinor, currency: 'EUR' }, auxEtatsUnis('en')))).toBe(
        chiffres(formatMoney({ amountMinor, currency: 'EUR' }, enFrance('fr'))),
      );
    }
  });

  /**
   * La panne que la police a révélée : `Intl` sépare les milliers par U+202F en
   * `fr-FR`, et **Roboto ne porte pas ce caractère**. Sans substitution, la
   * séparation s'imprime en rectangle vide — invisible ici, visible sur le
   * papier de la cliente.
   */
  it('n’émet jamais l’espace fine insécable, que la police embarquée ignore', () => {
    for (const display of SALONS) {
      for (const currency of ['EUR', 'MGA']) {
        expect(formatMoney({ amountMinor: 1_234_567, currency }, display)).not.toContain(
          ESPACE_FINE,
        );
      }
    }

    expect(printable(`6${ESPACE_FINE}500`)).toBe(`6${MILLIERS}500`);
  });
});

describe('formatTaxRate', () => {
  it('rend les points de base en pourcentage', () => {
    expect(formatTaxRate(2000, enFrance('fr'))).toContain('20');
    expect(formatTaxRate(2000, enFrance('fr'))).toContain('%');
    expect(formatTaxRate(550, enFrance('fr'))).toContain('5,5');
  });

  /** Le même taux, à l'anglaise : décimale au point, et pas d'espace avant le signe. */
  it('rend le taux à l’anglaise', () => {
    expect(formatTaxRate(2000, auxEtatsUnis('en'))).toBe('20%');
    expect(formatTaxRate(550, auxEtatsUnis('en'))).toBe('5.5%');
  });

  it('n’imprime pas de décimales inutiles', () => {
    expect(formatTaxRate(2000, enFrance('fr'))).not.toContain('20,00');
    expect(formatTaxRate(2000, auxEtatsUnis('en'))).not.toContain('20.00');
  });
});

describe('les dates', () => {
  /**
   * Cinquième critère : « les dates sont dans le fuseau du salon ». Le même
   * instant tombe le 17 à Paris et le 17 à Tananarive, mais à deux heures
   * différentes — et à 21 h 30 UTC, il tomberait le 18 chez l'un et pas l'autre.
   */
  it('rend l’instant dans le fuseau du salon, et non en UTC', () => {
    const instant = new Date('2026-09-17T09:30:00.000Z');

    expect(formatDateTime(instant, PARIS, enFrance('fr'))).toBe('17/09/2026 à 11:30');
    expect(formatDateTime(instant, TANA, enFrance('fr'))).toBe('17/09/2026 à 12:30');
  });

  /**
   * **#1230, deuxième critère**, corrigé par **#1325, deuxième critère.**
   *
   * Le mot change — « à » devient « at » — mais **l'ordre de la date et le cycle
   * horaire ne changent pas** : ils viennent du pays du salon. C'est exactement
   * ce que la pièce faisait mal, et le quatrième constat de #1325 : elle sortait
   * « 09/17/2026 at 11:30 AM » pour un salon parisien dont l'écran de caisse
   * venait d'écrire « 17/09/2026 11:30 ».
   *
   * C'est le même **instant** dans le même **fuseau** : la région décide de
   * l'écriture, le fuseau décide du jour.
   */
  it('garde l’écriture du salon quand la pièce sort en anglais', () => {
    const instant = new Date('2026-09-17T09:30:00.000Z');

    expect(formatDateTime(instant, PARIS, enFrance('en'))).toBe('17/09/2026 at 11:30');
    expect(formatDateTime(instant, TANA, enFrance('en'))).toBe('17/09/2026 at 12:30');
  });

  /**
   * **#1325, deuxième critère — le salon américain, une seule convention.**
   *
   * Le cycle horaire n'est plus forcé par la langue : il est celui du pays. Un
   * salon new-yorkais imprime donc « 05:30 AM » lu en anglais et « 05:30 » lu en
   * français — une convention par document, jamais deux, et la même que celle de
   * la gouttière de son planning et de sa grille de créneaux.
   */
  it('écrit un salon américain à l’américaine, mois d’abord et 12 heures', () => {
    const instant = new Date('2026-09-17T09:30:00.000Z');

    expect(formatDateTime(instant, NEW_YORK, auxEtatsUnis('en'))).toBe('09/17/2026 at 05:30 AM');
    expect(formatDateTime(instant, NEW_YORK, auxEtatsUnis('fr'))).toBe('17/09/2026 à 05:30');
  });

  it('date la pièce du bon jour de part et d’autre de minuit local', () => {
    const instant = new Date('2026-09-17T22:30:00.000Z');

    expect(formatDate(instant, PARIS, enFrance('fr'))).toBe('18/09/2026');
    expect(formatDate(instant, 'UTC', enFrance('fr'))).toBe('17/09/2026');
    expect(formatDate(instant, PARIS, auxEtatsUnis('en'))).toBe('09/18/2026');
    expect(formatDate(instant, 'UTC', auxEtatsUnis('en'))).toBe('09/17/2026');
  });

  /**
   * Certaines versions d'ICU glissent une espace fine insécable avant « AM » ;
   * Roboto ne la porte pas davantage qu'entre les milliers. Le `printable` de
   * `formatDateTime` couvre les deux, et c'est ici qu'on l'exige.
   */
  it('n’émet aucune espace fine insécable, dans aucun des quatre contextes', () => {
    for (const display of SALONS) {
      for (const zone of [PARIS, NEW_YORK]) {
        expect(formatDateTime(new Date('2026-09-17T09:30:00.000Z'), zone, display)).not.toContain(
          ESPACE_FINE,
        );
      }
    }
  });
});

describe('formatSettlementMethod', () => {
  /** Un règlement réduit à ce dont le libellé a besoin. */
  const settlement = (
    method: 'CASH' | 'CARD',
    cardChannel: 'STRIPE' | 'TERMINAL' | null,
    terminalReference: string | null = null,
  ): Parameters<typeof formatSettlementMethod>[0] => ({ method, cardChannel, terminalReference });

  it('nomme les espèces', () => {
    expect(formatSettlementMethod(settlement('CASH', null), 'fr')).toBe('Espèces');
    expect(formatSettlementMethod(settlement('CASH', null), 'en')).toBe('Cash');
  });

  /**
   * **Septième critère.** Le libellé ne porte aucune donnée de carte — dans
   * aucune des deux langues. Un vocabulaire est exactement l'endroit où un PAN
   * pourrait se glisser sans que personne ne relise ; la garantie est donc
   * rejouée langue par langue.
   */
  it('nomme la carte sans aucune donnée de carte', () => {
    for (const locale of LOCALES) {
      for (const channel of ['TERMINAL', 'STRIPE', null] as const) {
        const label = formatSettlementMethod(settlement('CARD', channel), locale);

        expect(label).toMatch(/^(Carte bancaire|Card) /);
        expect(label).not.toMatch(/\d{4}/);
        expect(label).not.toMatch(/visa|mastercard|cb|\*{4}/i);
      }
    }
  });

  /**
   * **#1027, premier point.** Le libellé se décide sur le **canal**, jamais sur
   * le seul moyen : une carte en ligne libellée « TPE » envoie le rapprochement
   * chercher sur le relevé du terminal une ligne qui n'y est pas.
   */
  it('ne nomme le terminal que sur un passage au terminal', () => {
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL'), 'fr')).toBe(
      'Carte bancaire (TPE)',
    );
    expect(formatSettlementMethod(settlement('CARD', 'STRIPE'), 'fr')).toBe(
      'Carte bancaire (en ligne)',
    );
    expect(formatSettlementMethod(settlement('CARD', 'STRIPE'), 'fr')).not.toMatch(/TPE|terminal/i);
  });

  /** La même distinction en anglais — le canal, et non le moyen. */
  it('distingue le terminal de la ligne, en anglais aussi', () => {
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL'), 'en')).toBe('Card (terminal)');
    expect(formatSettlementMethod(settlement('CARD', 'STRIPE'), 'en')).toBe('Card (online)');
  });

  /**
   * Une carte sans canal est **antérieure à #834** : le TPE n'existait pas, elle
   * ne peut être qu'une intention du tunnel public. Elle s'imprime donc comme
   * telle, et surtout pas comme un passage au terminal.
   */
  it('imprime une carte au canal nul comme une carte en ligne', () => {
    expect(formatSettlementMethod(settlement('CARD', null), 'fr')).toBe('Carte bancaire (en ligne)');
    expect(formatSettlementMethod(settlement('CARD', null), 'en')).toBe('Card (online)');
  });

  it('porte la référence TPE quand le caissier l’a saisie (#834)', () => {
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL', 'A0000123'), 'fr')).toBe(
      'Carte bancaire (TPE) — réf. A0000123',
    );
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL', 'A0000123'), 'en')).toBe(
      'Card (terminal) — ref. A0000123',
    );
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL', '   '), 'fr')).toBe(
      'Carte bancaire (TPE)',
    );
    expect(formatSettlementMethod(settlement('CARD', 'TERMINAL', '   '), 'en')).toBe(
      'Card (terminal)',
    );
  });

  /**
   * `payments_terminal_reference_check` interdit déjà qu'une carte en ligne en
   * porte une. Le libellé ne s'y fie pas moins : une reprise de données qui
   * poserait l'une sans l'autre imprimerait sinon « en ligne — réf. … ».
   */
  it('n’accroche pas de référence à un règlement qui n’est pas passé au terminal', () => {
    for (const locale of LOCALES) {
      expect(formatSettlementMethod(settlement('CARD', 'STRIPE', 'A0000123'), locale)).not.toContain(
        'A0000123',
      );
      expect(formatSettlementMethod(settlement('CASH', null, 'A0000123'), locale)).not.toContain(
        'A0000123',
      );
    }
  });
});

describe('bookingUrl', () => {
  it('pointe le tunnel de réservation du salon', () => {
    expect(bookingUrl('https://app.spa.test', 'barber-tana')).toBe(
      'https://app.spa.test/barber-tana/reservation',
    );
  });

  it('ne double pas la barre oblique quand l’origine en porte une', () => {
    expect(bookingUrl('https://app.spa.test/', 'barber-tana')).toBe(
      'https://app.spa.test/barber-tana/reservation',
    );
  });

  it('encode le slug plutôt que de le recopier', () => {
    expect(bookingUrl('https://app.spa.test', 'a/b')).toBe('https://app.spa.test/a%2Fb/reservation');
  });
});

describe('receiptFileName', () => {
  /** Sixième critère : « `Content-Disposition` porte le numéro de pièce ». */
  it('porte le numéro de pièce', () => {
    expect(receiptFileName('TIC-2026-000123', 'ticket-80', 'fr')).toBe(
      'ticket-TIC-2026-000123.pdf',
    );
    expect(receiptFileName('TIC-2026-000123', 'a4', 'fr')).toBe('facture-TIC-2026-000123.pdf');
  });

  /** #1230 : le nom du fichier suit la langue, le numéro de pièce non. */
  it('nomme le fichier dans la langue du document', () => {
    expect(receiptFileName('TIC-2026-000123', 'ticket-80', 'en')).toBe(
      'receipt-TIC-2026-000123.pdf',
    );
    expect(receiptFileName('TIC-2026-000123', 'a4', 'en')).toBe('invoice-TIC-2026-000123.pdf');
  });

  it('se rabat sur « proforma » tant que la vente n’est pas close', () => {
    expect(receiptFileName(null, 'ticket-80', 'fr')).toBe('ticket-proforma.pdf');
    expect(receiptFileName(null, 'ticket-80', 'en')).toBe('receipt-proforma.pdf');
  });

  /**
   * Le préfixe de numérotation est saisi par le salon : rien ne garantit qu'il
   * ne porte ni accent, ni séparateur de chemin. Les deux disparaissent — et le
   * nom reste de toute façon préfixé par un mot du vocabulaire, si bien qu'il ne
   * peut pas commencer par une remontée de répertoire. La garantie est rejouée
   * dans les deux langues : c'est le vocabulaire qui fournit désormais le
   * préfixe, et un préfixe vide rouvrirait la faille.
   */
  it('borne le nom à l’ASCII sûr', () => {
    expect(receiptFileName('../../etc/passwd', 'a4', 'fr')).toBe('facture-..-..-etc-passwd.pdf');
    expect(receiptFileName('TIC é 1', 'a4', 'fr')).toBe('facture-TIC---1.pdf');
    expect(receiptFileName('a b"c', 'ticket-80', 'fr')).toBe('ticket-a-b-c.pdf');

    for (const locale of LOCALES) {
      expect(receiptFileName('../../etc/passwd', 'a4', locale)).not.toContain('/');
      expect(receiptFileName(null, 'ticket-80', locale)).toMatch(/^[a-z]+-proforma\.pdf$/);
    }
  });
});

describe('contentDisposition', () => {
  it('sert les deux formes de la RFC 6266', () => {
    expect(contentDisposition('ticket-TIC-2026-000123.pdf')).toBe(
      'inline; filename="ticket-TIC-2026-000123.pdf"; ' +
        "filename*=UTF-8''ticket-TIC-2026-000123.pdf",
    );
  });

  it('retire les deux caractères qui refermeraient la chaîne citée', () => {
    expect(contentDisposition('a"b\\c.pdf')).toContain('filename="abc.pdf"');
  });
});

describe('receiptVocabulary', () => {
  /**
   * La parité est tenue par le typage — `Readonly<Record<Locale, …>>` —, mais un
   * champ recopié d'une table à l'autre compilerait et ferait sortir un mot
   * français sur une pièce anglaise. Ce test lit les deux tables et exige que
   * chaque clé soit **présente, non vide, et distincte** de son homologue, à
   * l'exception des quelques-unes qui sont les mêmes dans les deux langues.
   */
  const IDENTICAL_BY_DESIGN = new Set(['total']);

  it('traduit chaque clé, sans en laisser une en français sur la pièce anglaise', () => {
    const fr = receiptVocabulary('fr');
    const en = receiptVocabulary('en');

    for (const key of Object.keys(fr) as (keyof typeof fr)[]) {
      expect(typeof en[key]).toBe('string');
      expect(String(en[key]).trim()).not.toBe('');

      if (!IDENTICAL_BY_DESIGN.has(key)) {
        expect(en[key]).not.toBe(fr[key]);
      }
    }
  });

  it('rend une table pour chacune des langues du contrat', () => {
    for (const locale of LOCALES) {
      expect(receiptVocabulary(locale).at.trim()).not.toBe('');
    }
  });

  /**
   * La lecture indexée est **totale** : une langue ajoutée au contrat sans sa
   * table sort dans la langue par défaut du système plutôt que de faire tomber
   * l'impression d'un ticket au comptoir.
   */
  it('ne laisse jamais une langue inconnue faire tomber l’impression', () => {
    expect(receiptVocabulary('de' as Locale)).toBe(receiptVocabulary('en'));
  });
});
