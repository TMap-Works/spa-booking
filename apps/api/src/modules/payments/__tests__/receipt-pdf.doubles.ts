import type { QrMatrix } from '../receipt-pdf/receipt-pdf.qr';
import type {
  ReceiptSurface,
  RowOptions,
  RuleOptions,
  TextOptions,
} from '../receipt-pdf/receipt-pdf.canvas';
import type { SaleReceipt } from '../receipt.types';

/**
 * Les doubles de l'impression du ticket — #819.
 *
 * ## La planche qui enregistre
 *
 * Le troisième critère porte sur **l'ordre et le contenu** des huit sections du
 * ticket. Ni l'un ni l'autre ne se relit dans un PDF : le texte y est encodé en
 * indices de glyphes de la police sous-ensemblée, et un `expect(pdf).toContain`
 * ne trouverait jamais « TOTAL ». Cette planche-ci capte ce que le gabarit lui
 * demande, dans l'ordre, et rend le critère assertable ligne à ligne.
 *
 * Ce que le PDF réel prouve en plus — qu'il en est un, à la bonne taille de page
 * et de hauteur ajustée — est vérifié par `receipt-pdf.service.spec.ts`, qui
 * l'ouvre vraiment. Les deux suites sont complémentaires, aucune ne remplace
 * l'autre.
 */

/** Ce qu'une demande au gabarit laisse comme trace. */
export interface SurfaceCall {
  readonly kind: 'text' | 'row' | 'rule' | 'gap' | 'qr';
  readonly label: string;
  readonly amount: string;
  readonly weight: string;
}

export class RecordingSurface implements ReceiptSurface {
  public readonly calls: SurfaceCall[] = [];

  public text(value: string, options: TextOptions = {}): void {
    this.calls.push({
      kind: 'text',
      label: value,
      amount: '',
      weight: options.weight ?? 'regular',
    });
  }

  public row(label: string, amount: string, options: RowOptions = {}): void {
    this.calls.push({ kind: 'row', label, amount, weight: options.weight ?? 'regular' });
  }

  public rule(_options: RuleOptions = {}): void {
    this.calls.push({ kind: 'rule', label: '', amount: '', weight: 'regular' });
  }

  public gap(_height: number): void {
    this.calls.push({ kind: 'gap', label: '', amount: '', weight: 'regular' });
  }

  public qr(matrix: QrMatrix, _size: number): void {
    this.calls.push({
      kind: 'qr',
      label: `qr:${matrix.length}`,
      amount: '',
      weight: 'regular',
    });
  }

  /** Tout ce qui a été écrit, à plat — libellés et montants confondus. */
  public get written(): string[] {
    return this.calls
      .filter((call) => call.kind === 'text' || call.kind === 'row')
      .flatMap((call) => (call.amount === '' ? [call.label] : [call.label, call.amount]));
  }

  /** Le texte entier, pour les assertions de présence et d'absence. */
  public get text_(): string {
    return this.written.join('\n');
  }

  /** Le rang de la première écriture qui contient `needle`, ou `-1`. */
  public indexOf(needle: string): number {
    return this.written.findIndex((value) => value.includes(needle));
  }
}

const TIMEZONE = 'Europe/Paris';

/**
 * Le ticket de référence — **multi-lignes, deux taux**, en euros.
 *
 * C'est le jeu que le sixième critère nomme en premier. Les deux taux sont
 * portés par `taxBreakdown`, que `ReceiptService` compose : le MVP applique un
 * taux par établissement, mais la ventilation **est** un tableau, et une pièce
 * qui n'en imprimerait que la première ligne serait fausse le jour où une
 * prestation portera son propre taux.
 */
export function receiptFixture(overrides: Partial<SaleReceipt> = {}): SaleReceipt {
  const currency = 'EUR';

  return {
    saleId: '6a7f1f52-3f1e-4b19-9c0a-1d4e2f5b6c7d',
    sequence: 123,
    issuedAt: new Date('2026-09-17T09:30:00.000Z'),
    openedAt: new Date('2026-09-17T09:00:00.000Z'),
    issuer: {
      name: 'Barber Tana',
      slug: 'barber-tana',
      legalName: 'TANA COIFFURE SARL',
      legalIdType: 'SIRET',
      legalId: '73282932000074',
      vatNumber: 'FR40303265045',
      addressLine1: '12 rue des Lilas',
      addressLine2: null,
      postalCode: '75011',
      city: 'Paris',
      countryCode: 'FR',
      contactEmail: 'contact@barber-tana.test',
      contactPhone: '+33 1 23 45 67 89',
      footer: 'Aucun remboursement après 14 jours.',
      receiptPrefix: 'TIC',
      timezone: TIMEZONE,
      // Le salon de référence tient sa caisse en français : c'est ce qui rend
      // assertable le **repli** de #1230 — sans langue demandée, la pièce sort
      // dans celle de l'établissement, et non dans celle du système.
      defaultLocale: 'fr',
    },
    cashier: { displayName: 'Camille Roux' },
    client: { displayName: 'Awa Diallo' },
    practitioner: { displayName: 'Léa Martin' },
    lines: [
      {
        position: 0,
        kind: 'SERVICE',
        label: 'Soin éclat 45 min',
        quantity: 1,
        unitAmount: { amountMinor: 6500, currency },
        lineAmount: { amountMinor: 6500, currency },
      },
      {
        position: 1,
        kind: 'PRODUCT',
        label: 'Huile capillaire 100 ml',
        quantity: 2,
        unitAmount: { amountMinor: 1550, currency },
        lineAmount: { amountMinor: 3100, currency },
      },
      // `composeSale` matérialise **toujours** la taxe et le pourboire en
      // `sale_items` (`pos.totals.ts`, `COMPOSED_LINE_ORDER`). Les omettre ici
      // donnerait un jeu d'essai qu'aucune caisse ne peut produire — et c'est
      // précisément ce qui avait laissé passer le double affichage que la
      // recette de #819 a relevé sur une vente réelle.
      {
        position: 2,
        kind: 'TAX',
        label: 'TVA 20 %',
        quantity: 1,
        unitAmount: { amountMinor: 1245, currency },
        lineAmount: { amountMinor: 1245, currency },
      },
    ],
    taxBreakdown: [
      { rateBps: 2000, base: { amountMinor: 5417, currency }, tax: { amountMinor: 1083, currency } },
      { rateBps: 550, base: { amountMinor: 2938, currency }, tax: { amountMinor: 162, currency } },
    ],
    subtotal: { amountMinor: 8355, currency },
    taxTotal: { amountMinor: 1245, currency },
    tip: { amountMinor: 0, currency },
    total: { amountMinor: 9600, currency },
    settlements: [
      {
        method: 'CASH',
        cardChannel: null,
        amount: { amountMinor: 5000, currency },
        tendered: { amountMinor: 6000, currency },
        change: { amountMinor: 1000, currency },
        terminalReference: null,
        capturedAt: new Date('2026-09-17T09:29:00.000Z'),
      },
      {
        method: 'CARD',
        // Le tuyau, et non le seul moyen : c'est lui qui décide du libellé
        // depuis #1027. Ce ticket-ci est passé au TPE du salon.
        cardChannel: 'TERMINAL',
        amount: { amountMinor: 4600, currency },
        tendered: null,
        change: null,
        // La référence du ticket du TPE, telle que le caissier l'a relevée —
        // #834. C'est ce que la ligne « Carte bancaire (TPE) — réf. … » imprime.
        terminalReference: 'A0000123',
        capturedAt: new Date('2026-09-17T09:30:00.000Z'),
      },
    ],
    refunds: [],
    ...overrides,
  };
}

/**
 * Le même ticket, **avec un pourboire** — et la ligne de vente qui l'accompagne.
 *
 * Le pourboire vit à deux endroits en base, et c'est voulu : une ligne
 * `sale_items` de nature `TIP`, et la colonne `sales.tip_amount_minor` qui
 * l'agrège. Un jeu d'essai qui ne poserait que la seconde ne dirait rien du
 * risque réel, qui est de l'imprimer deux fois.
 */
export function tippedReceiptFixture(): SaleReceipt {
  const currency = 'EUR';
  const base = receiptFixture();

  return {
    ...base,
    tip: { amountMinor: 500, currency },
    total: { amountMinor: 10_100, currency },
    lines: [
      ...base.lines,
      {
        position: 3,
        kind: 'TIP',
        label: 'Pourboire',
        quantity: 1,
        unitAmount: { amountMinor: 500, currency },
        lineAmount: { amountMinor: 500, currency },
      },
    ],
  };
}

/**
 * Le même ticket, **en ariary** — la devise sans sous-unité du sixième critère.
 *
 * Les entiers sont ceux d'une caisse malgache : `24_000` ariary valent
 * vingt-quatre mille ariary, et non deux cent quarante. C'est exactement ce
 * qu'une division en dur par cent aurait faux.
 */
export function ariaryReceiptFixture(): SaleReceipt {
  const currency = 'MGA';
  const base = receiptFixture();

  return {
    ...base,
    issuer: { ...base.issuer, timezone: 'Indian/Antananarivo' },
    lines: [
      {
        position: 0,
        kind: 'SERVICE',
        label: 'Coupe homme',
        quantity: 1,
        unitAmount: { amountMinor: 18_000, currency },
        lineAmount: { amountMinor: 18_000, currency },
      },
      {
        position: 1,
        kind: 'PRODUCT',
        label: 'Cire coiffante',
        quantity: 3,
        unitAmount: { amountMinor: 2000, currency },
        lineAmount: { amountMinor: 6000, currency },
      },
      {
        position: 2,
        kind: 'TAX',
        label: 'TVA 20 %',
        quantity: 1,
        unitAmount: { amountMinor: 3313, currency },
        lineAmount: { amountMinor: 3313, currency },
      },
    ],
    taxBreakdown: [
      {
        rateBps: 2000,
        base: { amountMinor: 15_000, currency },
        tax: { amountMinor: 3000, currency },
      },
      { rateBps: 550, base: { amountMinor: 5687, currency }, tax: { amountMinor: 313, currency } },
    ],
    subtotal: { amountMinor: 20_687, currency },
    taxTotal: { amountMinor: 3313, currency },
    tip: { amountMinor: 0, currency },
    total: { amountMinor: 24_000, currency },
    settlements: [
      {
        method: 'CASH',
        cardChannel: null,
        amount: { amountMinor: 24_000, currency },
        tendered: { amountMinor: 25_000, currency },
        change: { amountMinor: 1000, currency },
        terminalReference: null,
        capturedAt: new Date('2026-09-17T09:30:00.000Z'),
      },
    ],
  };
}
