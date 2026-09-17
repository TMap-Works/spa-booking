import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LegalIdType } from '@spa/shared';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';

/**
 * La lecture du **ticket de caisse** — #818, cinquième critère.
 *
 * Une seule lecture, et elle rapporte tout ce qu'une pièce comptable porte : le
 * ticket, ses lignes, son établissement, les personnes qu'elle nomme, ses
 * règlements et ses avoirs. Un reçu composé de six allers-retours aurait été six
 * occasions de lire un état intermédiaire — un règlement inscrit entre deux
 * requêtes fait un total qui ne correspond à aucun instant.
 *
 * Il injecte le client **scopé** : un ticket du salon voisin est *introuvable*,
 * la lecture rend `null`, le service lève `NotFoundError`, la route répond 404 —
 * jamais 403 (tenant-isolation §4). Aucun `prismaUnscoped` : rien ici n'est
 * légitimement inter-tenant.
 *
 * ## Pourquoi il lit `users` et `staff`
 *
 * Parce qu'une pièce de caisse **nomme** les parties : « caissier (nom
 * affiché), cliente et praticien » est l'énoncé du critère, et ces trois noms
 * vivent dans `identity` et dans `catalog`. C'est la même dette assumée que
 * celle de `pos.repository.ts` vis-à-vis d'api-module §3 — `UsersService`
 * n'expose aujourd'hui aucune lecture de fiche par identifiant, et
 * `StaffService` ne rend qu'une liste complète.
 *
 * Elle est **bornée** à ce que le reçu imprime : un prénom, un nom, un nom
 * public de praticien. Ni adresse, ni téléphone, ni e-mail de la cliente, ni
 * note interne — ce qu'on ne lit pas ne peut pas fuiter (CDC §5.1). Une issue de
 * suivi porte la dette.
 */

/** L'établissement, tel que l'en-tête de la pièce le nomme. */
const ISSUER_SELECT = {
  name: true,
  legalName: true,
  legalIdType: true,
  legalId: true,
  vatNumber: true,
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  city: true,
  countryCode: true,
  contactEmail: true,
  contactPhone: true,
  receiptFooter: true,
  receiptPrefix: true,
  timezone: true,
} as const;

/** Un nom d'affichage, et **rien d'autre** — voir l'en-tête de ce fichier. */
const PARTY_SELECT = { firstName: true, lastName: true } as const;

const RECEIPT_SELECT = {
  id: true,
  receiptNumber: true,
  settledAt: true,
  createdAt: true,
  currency: true,
  subtotalAmountMinor: true,
  taxAmountMinor: true,
  taxRateBps: true,
  tipAmountMinor: true,
  totalAmountMinor: true,
  tenant: { select: ISSUER_SELECT },
  cashier: { select: PARTY_SELECT },
  appointment: {
    select: {
      client: { select: PARTY_SELECT },
      staff: { select: { displayName: true } },
    },
  },
  items: {
    select: {
      position: true,
      kind: true,
      label: true,
      quantity: true,
      unitAmountMinor: true,
      lineAmountMinor: true,
      currency: true,
    },
    orderBy: { position: 'asc' },
  },
  payments: {
    // Seuls les encaissements **aboutis** figurent sur un reçu : une intention
    // en vol n'a rien pris, et une carte refusée n'est pas un règlement. Les
    // statuts remboursés y restent — l'argent a bien été encaissé, et l'avoir
    // se lit plus bas.
    where: { status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
    select: {
      method: true,
      amountMinor: true,
      currency: true,
      tenderedAmountMinor: true,
      capturedAt: true,
      refunds: {
        // Un avoir n'existe que lorsque le prestataire — ou la caisse — a rendu
        // l'argent. Une demande en attente ou échouée ne produit aucune pièce.
        where: { status: 'SUCCEEDED' },
        // `id` n'est pas servi : il **départage** deux avoirs inscrits dans la
        // même milliseconde, pour que le rang qui compose le numéro de la pièce
        // d'avoir soit stable d'une lecture à l'autre.
        select: { id: true, amountMinor: true, currency: true, reason: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  // Pas de `as const` ici, à la différence des projections voisines : les
  // `orderBy` sont des tableaux, et `as const` les rendrait `readonly`, ce que
  // le type d'argument de Prisma refuse.
} satisfies Prisma.SaleSelect;

/** Ce que la lecture rapporte — la ligne brute, avant toute mise en forme. */
export interface ReceiptRow {
  id: string;
  receiptNumber: number | null;
  settledAt: Date | null;
  createdAt: Date;
  currency: string;
  subtotalAmountMinor: number;
  taxAmountMinor: number;
  taxRateBps: number;
  tipAmountMinor: number;
  totalAmountMinor: number;
  tenant: {
    name: string;
    legalName: string | null;
    legalIdType: LegalIdType | null;
    legalId: string | null;
    vatNumber: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    receiptFooter: string | null;
    receiptPrefix: string;
    timezone: string;
  };
  cashier: { firstName: string; lastName: string };
  appointment: {
    client: { firstName: string; lastName: string };
    staff: { displayName: string };
  } | null;
  items: {
    position: number;
    kind: string;
    label: string;
    quantity: number;
    unitAmountMinor: number;
    lineAmountMinor: number;
    currency: string;
  }[];
  payments: {
    method: string;
    amountMinor: number;
    currency: string;
    tenderedAmountMinor: number | null;
    capturedAt: Date | null;
    refunds: {
      id: string;
      amountMinor: number;
      currency: string;
      reason: string;
      createdAt: Date;
    }[];
  }[];
}

@Injectable()
export class ReceiptRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Le ticket de l'établissement courant et tout ce que sa pièce porte, ou
   * `null`.
   *
   * `findFirst` et non `findUnique` : `findUnique` exige que le `where` désigne
   * exactement une clé unique déclarée, où l'extension ne peut pas ajouter
   * `tenantId`. Même raison que dans `pos.repository.ts`.
   */
  public async findReceiptBySaleId(saleId: string): Promise<ReceiptRow | null> {
    return this.prisma.sale.findFirst({ where: { id: saleId }, select: RECEIPT_SELECT });
  }
}
