import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  formatReceiptNumber,
  formatRefundReceiptNumber,
  LEGAL_ID_TYPES,
  saleReceiptSchema,
  type LegalIdType,
  type SaleReceipt as SaleReceiptContract,
} from '@spa/shared';
import type { z } from 'zod';

import { SALE_ITEM_KINDS, type SaleItemKind } from '../pos.types';
import type {
  ReceiptLine,
  ReceiptRefund,
  ReceiptSettlement,
  ReceiptTaxLine,
  SaleReceipt,
} from '../receipt.types';
import { MoneyDto, toMoneyDto } from './sale.dto';

/**
 * Le ticket de caisse tel qu'il franchit la frontière HTTP — #818, cinquième et
 * septième critères.
 *
 * **La forme est celle du contrat partagé**, et la garde est en fin de fichier :
 * `saleReceiptSchema` de `packages/shared` est la source de vérité, ce fichier
 * n'en est que la déclaration OpenAPI. Le front importe `SaleReceipt` de
 * `@spa/shared` et ne redéclare rien (CLAUDE.md).
 *
 * ## Absent plutôt que `null`
 *
 * Les champs facultatifs de l'émetteur — raison sociale, identifiant
 * d'entreprise, adresse, mentions de pied — sont **omis** quand ils manquent,
 * jamais rendus `null`. Même régime que la vitrine publique, et pour la même
 * raison : un écran n'a pas à distinguer « pas renseigné » de « renseigné
 * vide ». Les champs du ticket lui-même — numéro, date de pièce, cliente,
 * praticien — sont en revanche **nullables** : leur absence est un fait à
 * afficher, pas une donnée manquante. Un ticket sans numéro est un ticket
 * ouvert, et le reçu doit le dire.
 *
 * ## Ce qui n'y est pas
 *
 * Ni `tenantId`, ni le moindre identifiant de personne, ni rien qui approche une
 * donnée de carte : un règlement porte son moyen et son montant, et c'est tout
 * (payments-stripe §1, tenant-isolation §4, CDC §5.1).
 */

/** Une personne nommée sur la pièce — un nom d'affichage, et rien d'autre. */
export class ReceiptPartyDto {
  @ApiProperty({ example: 'Camille Roux' })
  public displayName!: string;
}

/** L'adresse postale de l'établissement, telle que la pièce l'imprime. */
export class ReceiptAddressDto {
  @ApiProperty({ example: '12 rue des Lilas' })
  public line1!: string;

  @ApiPropertyOptional({ example: 'Bâtiment B' })
  public line2?: string;

  @ApiPropertyOptional({ example: '75011' })
  public postalCode?: string;

  @ApiProperty({ example: 'Paris' })
  public city!: string;

  @ApiProperty({ example: 'FR', minLength: 2, maxLength: 2 })
  public country!: string;
}

/** L'émetteur de la pièce — identité légale et coordonnées du salon. */
export class ReceiptIssuerDto {
  @ApiProperty({ example: 'Barber Tana', description: 'Le nom commercial — l’enseigne.' })
  public name!: string;

  @ApiPropertyOptional({
    example: 'TANA COIFFURE SARL',
    description: 'La raison sociale, quand elle diffère de l’enseigne.',
  })
  public legalName?: string;

  @ApiPropertyOptional({ enum: LEGAL_ID_TYPES })
  public legalIdType?: LegalIdType;

  @ApiPropertyOptional({ example: '73282932000074' })
  public legalId?: string;

  @ApiPropertyOptional({ example: 'FR40303265045' })
  public vatNumber?: string;

  @ApiPropertyOptional({ type: ReceiptAddressDto })
  public address?: ReceiptAddressDto;

  @ApiPropertyOptional({ example: 'contact@barber-tana.test' })
  public contactEmail?: string;

  @ApiPropertyOptional({ example: '+261 34 12 345 67' })
  public contactPhone?: string;

  @ApiPropertyOptional({
    example: 'Merci de votre visite. Aucun remboursement après 14 jours.',
    description: 'Mentions imprimées en pied de ticket.',
  })
  public footer?: string;
}

/** Une ligne du reçu — le prix unitaire est **TTC** (#816). */
export class ReceiptLineDto {
  @ApiProperty({ example: 0, minimum: 0 })
  public position!: number;

  @ApiProperty({ enum: SALE_ITEM_KINDS })
  public kind!: SaleItemKind;

  @ApiProperty({ example: 'Soin éclat 45 min' })
  public label!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  public quantity!: number;

  @ApiProperty({ type: MoneyDto, description: 'Prix unitaire **TTC**, figé à la vente.' })
  public unitPrice!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: '`unitPrice × quantity`.' })
  public total!: MoneyDto;
}

/** Une ventilation de taxe, pour un taux donné. */
export class ReceiptTaxLineDto {
  @ApiProperty({
    example: 2000,
    description: 'Taux en points de base — `2000` vaut 20 %, jamais un flottant.',
  })
  public rateBps!: number;

  @ApiProperty({ type: MoneyDto, description: 'Assiette hors taxe.' })
  public base!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Taxe **comprise dans** les prix affichés.' })
  public tax!: MoneyDto;
}

/** Un règlement porté sur la pièce. */
export class ReceiptSettlementDto {
  @ApiProperty({ enum: ['CASH', 'CARD'] })
  public method!: 'CASH' | 'CARD';

  @ApiProperty({ type: MoneyDto })
  public amount!: MoneyDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    description: 'Ce que la cliente a tendu — espèces seulement.',
  })
  public tendered?: MoneyDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    description: '`tendered − amount` : la monnaie rendue, jamais encaissée.',
  })
  public change?: MoneyDto;

  @ApiPropertyOptional({
    example: 'A0000123',
    description:
      'Le numéro du ticket du TPE, quand le caissier l’a saisi — #834. Il ' +
      's’imprime à côté du moyen : « Carte bancaire (TPE) — réf. A0000123 ». ' +
      'Absent partout ailleurs, et **jamais une donnée de carte**.',
  })
  public terminalReference?: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  public capturedAt!: string | null;
}

/** L'avoir d'un remboursement — sa pièce cite la vente d'origine. */
export class ReceiptRefundDto {
  @ApiProperty({
    example: 'TIC-2026-000123-R1',
    nullable: true,
    type: String,
    description: 'La pièce de cet avoir. `null` tant que la vente d’origine n’est pas close.',
  })
  public number!: string | null;

  @ApiProperty({
    example: 'TIC-2026-000123',
    nullable: true,
    type: String,
    description:
      'La vente que cet avoir annule, en tout ou partie — elle **garde** son numéro. ' +
      '`null` tant qu’elle n’est pas close, et il n’y a alors rien à citer.',
  })
  public origin!: string | null;

  @ApiProperty({ type: MoneyDto })
  public amount!: MoneyDto;

  @ApiProperty({ format: 'date-time' })
  public issuedAt!: string;

  @ApiPropertyOptional({ example: 'Prestation écourtée' })
  public reason?: string;
}

/** Le ticket de caisse complet. */
export class SaleReceiptDto {
  @ApiProperty({ format: 'uuid' })
  public saleId!: string;

  @ApiProperty({
    example: 'TIC-2026-000123',
    nullable: true,
    type: String,
    description:
      'Le numéro de pièce, attribué **à la clôture**. `null` tant que le ticket ' +
      'n’est pas soldé : le reçu qu’on en tire est alors un proforma.',
  })
  public number!: string | null;

  @ApiProperty({
    example: 123,
    nullable: true,
    type: Number,
    description: 'Le rang dans la suite de l’établissement — la suite n’a aucun trou.',
  })
  public sequence!: number | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Instant UTC de la clôture — la date de la pièce.',
  })
  public issuedAt!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de composition du ticket.' })
  public openedAt!: string;

  @ApiProperty({
    example: 'Europe/Paris',
    description:
      'Fuseau de l’établissement. Les deux instants ci-dessus sont en UTC ; ' +
      'c’est avec celui-ci qu’ils s’affichent en heure locale.',
  })
  public timezone!: string;

  @ApiProperty({ type: ReceiptIssuerDto })
  public issuer!: ReceiptIssuerDto;

  @ApiProperty({ type: ReceiptPartyDto })
  public cashier!: ReceiptPartyDto;

  @ApiProperty({
    type: ReceiptPartyDto,
    nullable: true,
    description: 'La cliente, quand la vente est adossée à un rendez-vous.',
  })
  public client!: ReceiptPartyDto | null;

  @ApiProperty({ type: ReceiptPartyDto, nullable: true })
  public practitioner!: ReceiptPartyDto | null;

  @ApiProperty({ type: [ReceiptLineDto] })
  public lines!: ReceiptLineDto[];

  @ApiProperty({
    type: [ReceiptTaxLineDto],
    description: 'Vide lorsque l’établissement n’applique aucun taux.',
  })
  public taxBreakdown!: ReceiptTaxLineDto[];

  @ApiProperty({ type: MoneyDto })
  public subtotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  public taxTotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  public tip!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  public total!: MoneyDto;

  @ApiProperty({ type: [ReceiptSettlementDto] })
  public settlements!: ReceiptSettlementDto[];

  @ApiProperty({ type: [ReceiptRefundDto] })
  public refunds!: ReceiptRefundDto[];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * L'année civile d'un instant **dans le fuseau de l'établissement**.
 *
 * Un ticket clos le 1er janvier à 00 h 05 à Paris l'a été le 31 décembre à
 * 23 h 05 en UTC : lire l'année sur l'instant brut aurait daté sa pièce de
 * l'exercice précédent. L'année ne décide d'aucun rang — la suite est continue
 * (`receipt.numbering.ts`) —, mais elle **s'imprime**, et une pièce datée du
 * mauvais exercice est une pièce qu'un contrôle relève.
 *
 * `en-CA` rend `AAAA-MM-JJ` : la seule locale dont le format est stable et
 * trivialement décomposable.
 */
function yearInTimeZone(instant: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(instant);

  return Number(formatted);
}

/**
 * Le numéro affiché d'une pièce, ou `null` si le ticket n'est pas clos.
 *
 * Les trois morceaux viennent de trois endroits, et c'est voulu : le préfixe de
 * l'établissement — modifiable, sans réécrire les tickets passés —, l'année de
 * la pièce, et le rang figé en base. La composition vit dans le contrat partagé
 * (`formatReceiptNumber`), pour que le front affiche exactement la même chaîne.
 */
export function receiptNumberOf(receipt: SaleReceipt): string | null {
  if (receipt.sequence === null || receipt.issuedAt === null) {
    return null;
  }

  return formatReceiptNumber(
    receipt.issuer.receiptPrefix,
    yearInTimeZone(receipt.issuedAt, receipt.issuer.timezone),
    receipt.sequence,
  );
}

/**
 * L'émetteur, ses champs facultatifs **omis** plutôt que rendus `null`.
 *
 * L'adresse suit la règle du triplet minimal de `postalAddressSchema` : elle
 * n'est servie que si la rue, la ville et le pays sont là. Une adresse sans
 * ville n'oriente personne, et publier faux coûte plus cher que ne pas publier
 * (#343).
 */
function toIssuerDto(receipt: SaleReceipt): ReceiptIssuerDto {
  const issuer = receipt.issuer;
  const hasAddress =
    issuer.addressLine1 !== null && issuer.city !== null && issuer.countryCode !== null;

  return {
    name: issuer.name,
    ...(issuer.legalName === null ? {} : { legalName: issuer.legalName }),
    ...(issuer.legalIdType === null ? {} : { legalIdType: issuer.legalIdType }),
    ...(issuer.legalId === null ? {} : { legalId: issuer.legalId }),
    ...(issuer.vatNumber === null ? {} : { vatNumber: issuer.vatNumber }),
    ...(hasAddress
      ? {
          address: {
            line1: issuer.addressLine1 ?? '',
            ...(issuer.addressLine2 === null ? {} : { line2: issuer.addressLine2 }),
            ...(issuer.postalCode === null ? {} : { postalCode: issuer.postalCode }),
            city: issuer.city ?? '',
            country: issuer.countryCode ?? '',
          },
        }
      : {}),
    ...(issuer.contactEmail === null ? {} : { contactEmail: issuer.contactEmail }),
    ...(issuer.contactPhone === null ? {} : { contactPhone: issuer.contactPhone }),
    ...(issuer.footer === null ? {} : { footer: issuer.footer }),
  };
}

function toLineDto(line: ReceiptLine): ReceiptLineDto {
  return {
    position: line.position,
    kind: line.kind,
    label: line.label,
    quantity: line.quantity,
    unitPrice: toMoneyDto(line.unitAmount),
    total: toMoneyDto(line.lineAmount),
  };
}

function toTaxLineDto(tax: ReceiptTaxLine): ReceiptTaxLineDto {
  return { rateBps: tax.rateBps, base: toMoneyDto(tax.base), tax: toMoneyDto(tax.tax) };
}

function toSettlementDto(settlement: ReceiptSettlement): ReceiptSettlementDto {
  return {
    method: settlement.method,
    amount: toMoneyDto(settlement.amount),
    ...(settlement.tendered === null ? {} : { tendered: toMoneyDto(settlement.tendered) }),
    ...(settlement.change === null ? {} : { change: toMoneyDto(settlement.change) }),
    ...(settlement.terminalReference === null
      ? {}
      : { terminalReference: settlement.terminalReference }),
    capturedAt: settlement.capturedAt === null ? null : settlement.capturedAt.toISOString(),
  };
}

/**
 * L'avoir et sa pièce — sixième critère.
 *
 * Le numéro d'origine est **requis** pour composer celui de l'avoir : la pièce
 * d'un avoir n'existe que par la vente qu'elle annule. Un encaissement abouti
 * peut pourtant ne solder qu'une part du ticket — et être remboursé avant que le
 * reste ne le soit : la vente n'est alors pas close, elle n'a pas de numéro, et
 * il n'y a **rien à citer**. Les deux champs sont nuls ensemble. Composer
 * `-R1` sur une origine vide aurait produit un numéro de pièce qui ne désigne
 * aucune vente — et que `receiptRefundSchema` refuse.
 */
function toRefundDto(refund: ReceiptRefund, origin: string | null): ReceiptRefundDto {
  return {
    number: origin === null ? null : formatRefundReceiptNumber(origin, refund.rank),
    origin,
    amount: toMoneyDto(refund.amount),
    issuedAt: refund.issuedAt.toISOString(),
    ...(refund.reason === null ? {} : { reason: refund.reason }),
  };
}

/** Le ticket de caisse tel qu'il franchit la frontière HTTP. */
export function toSaleReceiptDto(receipt: SaleReceipt): SaleReceiptDto {
  const number = receiptNumberOf(receipt);

  return {
    saleId: receipt.saleId,
    number,
    sequence: receipt.sequence,
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    issuedAt: receipt.issuedAt === null ? null : receipt.issuedAt.toISOString(),
    openedAt: receipt.openedAt.toISOString(),
    timezone: receipt.issuer.timezone,
    issuer: toIssuerDto(receipt),
    cashier: { displayName: receipt.cashier.displayName },
    client: receipt.client === null ? null : { displayName: receipt.client.displayName },
    practitioner:
      receipt.practitioner === null ? null : { displayName: receipt.practitioner.displayName },
    lines: receipt.lines.map((line) => toLineDto(line)),
    taxBreakdown: receipt.taxBreakdown.map((tax) => toTaxLineDto(tax)),
    subtotal: toMoneyDto(receipt.subtotal),
    taxTotal: toMoneyDto(receipt.taxTotal),
    tip: toMoneyDto(receipt.tip),
    total: toMoneyDto(receipt.total),
    settlements: receipt.settlements.map((settlement) => toSettlementDto(settlement)),
    refunds: receipt.refunds.map((refund) => toRefundDto(refund, number)),
  };
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * Le septième critère, rendu vérifiable.
 *
 * « Le contrat du ticket est décrit dans `packages/shared`, qui reste la source
 * de vérité » ne se prouve pas en écrivant les deux formes côte à côte : il se
 * prouve en faisant échouer la compilation dès qu'elles divergent. Un champ
 * ajouté ici sans l'être au contrat casse, et l'inverse aussi.
 *
 * Même réserve que pour `TenantDto` sur les tableaux — `readonly` d'un côté,
 * mutable de l'autre : l'assignabilité est vérifiée sur les clés, et chaque
 * élément l'est par son propre `ApiProperty`.
 */
type ReceiptWire = z.input<typeof saleReceiptSchema>;

type AssertNever<T extends never> = T;

type _ReceiptDtoHasTheContractKeys = AssertNever<
  Exclude<keyof SaleReceiptDto, keyof ReceiptWire> | Exclude<keyof ReceiptWire, keyof SaleReceiptDto>
>;

type _ContractTypeIsTheOneWeExport = AssertNever<
  Exclude<keyof SaleReceiptContract, keyof SaleReceiptDto>
>;
