import { PrismaClient } from '@prisma/client';

import { allocateReceiptNumberFor } from './receipt.numbering';

/**
 * La reprise des encaissements inscrits **avant** #817 — septième critère de
 * l'issue.
 *
 * Jusqu'à #817, `payments` ne se rattachait qu'à un rendez-vous : un règlement
 * n'avait aucune pièce, et une vente ne pouvait recevoir aucun règlement. La
 * base porte donc deux anomalies symétriques, et ce fichier les traite
 * séparément parce qu'elles ne se traitent pas de la même façon :
 *
 * | Ce qu'on trouve | Ce que la reprise fait |
 * |---|---|
 * | un encaissement sans vente | **crée** la vente manquante, et l'y rattache |
 * | une vente sans encaissement | la **liste**, pour décision |
 *
 * La dissymétrie est la règle du critère, et elle est la seule tenable :
 * fabriquer la vente d'un encaissement ne fait qu'écrire la pièce d'un
 * mouvement d'argent qui a réellement eu lieu, tandis que fabriquer
 * l'encaissement d'une vente inventerait une recette. **Ce script n'invente
 * aucun paiement.**
 *
 * ## Ce que la vente créée porte
 *
 * Le montant de l'encaissement, et rien d'autre — une seule ligne, du montant
 * réglé, libellée par le rendez-vous quand il y en a un. Elle n'essaie pas de
 * reconstituer l'addition d'alors : les prix du catalogue ont pu changer, et
 * une pièce comptable reconstituée à partir d'un tarif d'aujourd'hui serait
 * fausse d'une façon qui ne se verrait plus. Ce que la vente affirme est
 * exactement ce que la base sait : « il a été encaissé ce montant-là, ce
 * jour-là ».
 *
 * La taxe n'y est pas ventilée, pour la même raison : le taux d'alors n'est nulle
 * part. `subtotal` porte donc le montant entier et `tax` vaut zéro — ce que
 * `sales_total_amount_minor_check` accepte, et ce que `pos.tax-backfill.ts`
 * classerait `conforme` à taux nul. Les lignes du reçu d'origine n'existant pas,
 * il n'y a rien à mentir.
 *
 * ## Quand un encaissement a déjà une vente à côté de lui
 *
 * Le cas relevé sur `spa_dev` : la vente de 106,80 € de Spa Lumière et
 * l'encaissement de 65,00 € portent le **même rendez-vous** sans se connaître.
 * La reprise les **rattache** plutôt que d'en créer une seconde — c'est la
 * pièce de ce rendez-vous, et en fabriquer une autre doublerait le revenu du
 * jour. L'écart entre les deux montants reste alors visible comme un reste dû,
 * ce qui est précisément l'information qu'on veut voir.
 *
 * ## Deux moitiés, et pourquoi elles cohabitent ici
 *
 * - une partie **pure** — `planSaleBackfill` —, qui décide de ce qu'il faut
 *   faire d'un encaissement à partir de ce que la base en dit, sans effet de
 *   bord. C'est elle que la suite unitaire exerce ;
 * - un **script**, sous `require.main === module`, qui applique cette décision.
 *   Importer ce fichier n'exécute donc rien.
 *
 * ## Ce que le script lit, et pourquoi il n'est pas un repository
 *
 * Il balaie **tous les établissements** : c'est une reprise de données, jouée
 * hors de toute requête HTTP, et il n'existe aucun tenant courant à partir
 * duquel se scoper. Même dérogation que `pos.tax-backfill.ts`, et le client est
 * nommé `prismaUnscoped` pour que la convention de relecture du dépôt continue
 * de valoir (tenant-isolation §3).
 *
 * Chaque ligne reste traitée **dans son établissement** : la vente créée porte
 * le `tenant_id` de son encaissement, jamais un autre.
 *
 * ## Comment on le joue
 *
 * ```bash
 * # 1. le constat, sans rien écrire — c'est le mode par défaut
 * node --require ts-node/register apps/api/src/modules/payments/pos.sale-backfill.ts
 *
 * # 2. la reprise, une fois le constat relu
 * node --require ts-node/register apps/api/src/modules/payments/pos.sale-backfill.ts --apply
 * ```
 *
 * Une fois la reprise jouée et le constat vide, `payments_sale_required_check`
 * peut être validé par une migration ultérieure — ce qui se décide sur l'état
 * réel de la base, pas ici.
 */

/** Le nom du fichier dans les lignes de rapport. */
const REPORT_PREFIX = 'pos.sale-backfill';

/**
 * Le nombre de lignes lues par aller-retour.
 *
 * Même raison que dans `pos.tax-backfill.ts` : la base d'un déployé porte
 * autant d'encaissements qu'il s'est fait de ventes, et les charger d'un seul
 * `findMany` ferait tenir la comptabilité du parc en mémoire.
 */
const SCAN_BATCH_SIZE = 500;

/** Ce que la reprise sait d'un encaissement — rien de plus. */
export interface OrphanPaymentFacts {
  /** Le rendez-vous de l'encaissement, ou `null` pour une vente retail. */
  readonly appointmentId: string | null;
  /** L'identifiant de la vente déjà écrite pour ce rendez-vous, s'il y en a une. */
  readonly existingSaleId: string | null;
  readonly amountMinor: number;
  /** `true` si l'argent a réellement été pris — les autres n'ont pas de pièce à écrire. */
  readonly captured: boolean;
}

/**
 * Ce qu'il faut faire d'un encaissement sans vente.
 *
 * - `attach` — une vente existe déjà pour son rendez-vous : on l'y rattache ;
 * - `create` — il n'y en a pas : on en écrit une, du montant réglé ;
 * - `skip` — l'encaissement n'a rien capturé. Une intention abandonnée ou une
 *   carte refusée n'a pas de pièce comptable à porter, et lui en fabriquer une
 *   ferait apparaître une vente que personne n'a faite.
 */
export type SaleBackfillPlan =
  | { readonly action: 'attach'; readonly saleId: string }
  | { readonly action: 'create' }
  | { readonly action: 'skip'; readonly reason: 'non-capturé' };

/**
 * Décide du sort d'un encaissement sans vente — pure, et c'est le point.
 *
 * Le rattachement l'emporte sur la création, et jamais l'inverse : une seconde
 * vente sur un rendez-vous qui en a déjà une doublerait le revenu de sa journée
 * dès que le reporting lit les ventes réglées (sixième critère).
 */
export function planSaleBackfill(facts: OrphanPaymentFacts): SaleBackfillPlan {
  if (!facts.captured) {
    return { action: 'skip', reason: 'non-capturé' };
  }

  if (facts.existingSaleId !== null) {
    return { action: 'attach', saleId: facts.existingSaleId };
  }

  return { action: 'create' };
}

/** Les statuts pour lesquels de l'argent a réellement été pris. */
const CAPTURED_STATUSES = ['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

/** Le libellé de la ligne unique d'une vente reconstituée. */
export const BACKFILL_LINE_LABEL = 'Encaissement repris';

/** Ce que le balayage lit d'un encaissement orphelin. */
interface OrphanPaymentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly appointmentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly capturedAt: Date | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Le script — rien de ce qui suit ne s'exécute à l'import
// ---------------------------------------------------------------------------

/** Une ligne de rapport, écrite telle quelle sur la sortie standard. */
function report(line: string): void {
  // `process.stdout.write` et non `console.log` : `no-console` n'autorise que
  // `console.error`, et un rapport de reprise n'est pas une erreur.
  process.stdout.write(`${REPORT_PREFIX}: ${line}\n`);
}

/** Le compte rendu d'une reprise — ce que le script rend à son appelant. */
export interface SaleBackfillReport {
  /** Encaissements sans vente rattachés à une vente existante. */
  readonly attached: number;
  /** Encaissements sans vente pour lesquels une vente a été écrite. */
  readonly created: number;
  /** Encaissements sans vente laissés tels quels — rien n'a été capturé. */
  readonly skipped: number;
  /** Ventes sans le moindre encaissement — **listées, jamais réglées**. */
  readonly unpaidSales: number;
}

/**
 * Rattache chaque encaissement à une vente, et liste les ventes sans
 * encaissement.
 *
 * @param apply `true` pour écrire ; le défaut ne fait que rapporter.
 */
export async function runSaleBackfill(
  prismaUnscoped: PrismaClient,
  apply: boolean,
): Promise<SaleBackfillReport> {
  let attached = 0;
  let created = 0;
  let skipped = 0;

  // Pagination par **curseur** sur l'identifiant, et non par décalage.
  //
  // Un `skip` croissant est faux dès que la reprise écrit : les lignes traitées
  // cessent de satisfaire `sale_id IS NULL`, l'ensemble se réduit sous le
  // curseur, et une ligne sur deux serait sautée. Un `skip` toujours nul serait
  // faux dans l'autre sens : les encaissements non capturés restent éligibles et
  // la boucle ne finirait jamais.
  //
  // L'identifiant est un UUID : l'ordre n'a aucun sens métier, mais il est
  // **total et stable**, ce qui est tout ce qu'un curseur demande. Les lignes
  // traitées disparaissent du filtre, les autres restent au-delà du curseur.
  let cursor: string | null = null;

  for (;;) {
    // Annotation explicite : sans elle, TypeScript ne sait pas inférer le type
    // d'une variable dont le `where` dépend du tour précédent (`TS7022`).
    const payments: readonly OrphanPaymentRow[] = await prismaUnscoped.payment.findMany({
      where: { saleId: null, ...(cursor === null ? {} : { id: { gt: cursor } }) },
      select: {
        id: true,
        tenantId: true,
        appointmentId: true,
        amountMinor: true,
        currency: true,
        status: true,
        capturedAt: true,
        createdAt: true,
      },
      orderBy: [{ id: 'asc' }],
      take: SCAN_BATCH_SIZE,
    });

    if (payments.length === 0) {
      break;
    }

    cursor = payments[payments.length - 1]?.id ?? null;

    for (const payment of payments) {
      const existing =
        payment.appointmentId === null
          ? null
          : await prismaUnscoped.sale.findFirst({
              where: { tenantId: payment.tenantId, appointmentId: payment.appointmentId },
              select: { id: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });

      const plan = planSaleBackfill({
        appointmentId: payment.appointmentId,
        existingSaleId: existing?.id ?? null,
        amountMinor: payment.amountMinor,
        captured: (CAPTURED_STATUSES as readonly string[]).includes(payment.status),
      });

      if (plan.action === 'skip') {
        skipped += 1;
        report(
          `${payment.id} (tenant ${payment.tenantId}) : ${payment.status} — ` +
            'rien n’a été capturé, aucune vente créée.',
        );
        continue;
      }

      if (plan.action === 'attach') {
        attached += 1;

        if (apply) {
          await attachToSale(
            prismaUnscoped,
            payment.tenantId,
            payment.id,
            plan.saleId,
            payment.amountMinor,
            payment.capturedAt ?? payment.createdAt,
          );
        }

        report(
          `${payment.id} (tenant ${payment.tenantId}) : rattaché à la vente ${plan.saleId}` +
            (apply ? '' : ' (aucune écriture : relancer avec --apply)'),
        );
        continue;
      }

      created += 1;

      if (apply) {
        const saleId = await createSaleFor(prismaUnscoped, payment);
        report(
          `${payment.id} (tenant ${payment.tenantId}) : vente ${saleId} créée pour ` +
            `${payment.amountMinor} ${payment.currency}`,
        );
        continue;
      }

      report(
        `${payment.id} (tenant ${payment.tenantId}) : vente manquante pour ` +
          `${payment.amountMinor} ${payment.currency} (aucune écriture : relancer avec --apply)`,
      );
    }
  }

  const unpaidSales = await reportUnpaidSales(prismaUnscoped);

  report(
    `${attached} rattaché(s), ${created} vente(s) ${apply ? 'créée(s)' : 'à créer'}, ` +
      `${skipped} ignoré(s), ${unpaidSales} vente(s) sans encaissement — ` +
      `${apply ? 'écritures appliquées' : 'aucune écriture'}.`,
  );

  return { attached, created, skipped, unpaidSales };
}

/**
 * Rattache un encaissement à une vente déjà écrite, et fait avancer son compte.
 *
 * Les deux écritures sont dans la même transaction : une vente rattachée dont
 * le compte n'aurait pas bougé se laisserait régler une seconde fois, ce qui
 * est exactement l'anomalie que #817 referme.
 *
 * Le compte n'est **pas** plafonné ici : si l'encaissement dépasse le total de
 * la vente — le cas de Spa Lumière à l'envers —, `sales_settled_amount_minor_check`
 * annule la transaction, le rapport le montre, et une personne tranche. Écrêter
 * en silence ferait disparaître l'écart que la reprise existe pour révéler.
 *
 * L'ajout est **atomique** — `SET settled = settled + n`, et non une relecture
 * suivie d'une valeur absolue : la reprise se joue sur une base vivante, et un
 * règlement de comptoir qui se glisserait entre la lecture et l'écriture serait
 * sinon effacé.
 *
 * La date du solde est celle de la **capture**, jamais celle du jour où la
 * reprise est jouée : une reprise ne déplace pas une recette de journée, et
 * `sales (tenant_id, settled_at)` est l'axe du rapprochement de caisse.
 */
async function attachToSale(
  prismaUnscoped: PrismaClient,
  tenantId: string,
  paymentId: string,
  saleId: string,
  amountMinor: number,
  settledAt: Date,
): Promise<void> {
  await prismaUnscoped.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { saleId } });
    await tx.sale.update({
      where: { id: saleId },
      data: { settledAmountMinor: { increment: amountMinor } },
    });

    // Relue **après** l'ajout, donc sur la ligne que cette transaction tient
    // désormais verrouillée : « soldé » est une comparaison entre deux colonnes
    // qu'`update` ne sait pas exprimer.
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: { settledAmountMinor: true, totalAmountMinor: true, receiptNumber: true },
    });

    if (sale.settledAmountMinor === sale.totalAmountMinor) {
      // Une vente que cette reprise **clôt** prend son numéro de pièce comme
      // n'importe quelle autre clôture (#818) : la suite d'un salon ne peut pas
      // avoir de vente close sans rang, sans quoi le reçu du ticket rattrapé
      // n'aurait rien à afficher. La migration a numéroté ce qui était déjà
      // clos ; ce bloc couvre ce que la reprise clôt après elle.
      const receiptNumber = sale.receiptNumber ?? (await allocateReceiptNumberFor(tx, tenantId));

      await tx.sale.update({ where: { id: saleId }, data: { settledAt, receiptNumber } });
    }
  });
}

/**
 * Écrit la vente manquante d'un encaissement, et l'y rattache.
 *
 * La vente est **soldée d'emblée** : son total est celui de l'encaissement, et
 * l'argent a été pris. La dater du `captured_at` de l'encaissement plutôt que
 * de maintenant est ce qui fait qu'elle apparaît au bon jour de caisse — une
 * reprise ne doit pas déplacer une recette de journée.
 */
async function createSaleFor(
  prismaUnscoped: PrismaClient,
  payment: {
    readonly id: string;
    readonly tenantId: string;
    readonly appointmentId: string | null;
    readonly amountMinor: number;
    readonly currency: string;
    readonly capturedAt: Date | null;
    readonly createdAt: Date;
  },
): Promise<string> {
  const settledAt = payment.capturedAt ?? payment.createdAt;

  return prismaUnscoped.$transaction(async (tx) => {
    // L'opérateur du ticket n'existe nulle part pour un encaissement d'avant
    // #817 : `payments` n'a pas de colonne d'opérateur, et le journal structuré
    // où elle partait n'est pas une source relisible. C'est donc la cliente du
    // rendez-vous, comme pour un ticket composé par le tunnel en ligne — et, à
    // défaut de rendez-vous, le premier compte d'administration de
    // l'établissement, qui est le seul choix qui ne fabrique pas d'identité.
    const appointment = await resolveAppointment(tx, payment.tenantId, payment.appointmentId);
    const cashierUserId = appointment?.clientId ?? (await resolveAdmin(tx, payment.tenantId));

    const sale = await tx.sale.create({
      data: {
        tenantId: payment.tenantId,
        appointmentId: payment.appointmentId,
        cashierUserId,
        subtotalAmountMinor: payment.amountMinor,
        taxAmountMinor: 0,
        tipAmountMinor: 0,
        totalAmountMinor: payment.amountMinor,
        settledAmountMinor: payment.amountMinor,
        settledAt,
        // La vente naît **close** : elle prend donc son numéro de pièce dans la
        // transaction qui l'écrit (#818). Le rang suit celui de la migration,
        // qui a numéroté l'existant — une reprise jouée après elle continue la
        // suite au lieu d'en ouvrir une seconde.
        receiptNumber: await allocateReceiptNumberFor(tx, payment.tenantId),
        currency: payment.currency,
        createdAt: payment.createdAt,
      },
      select: { id: true },
    });

    // La ligne du reçu n'est écrite que lorsqu'elle a une **référence** à
    // porter. `sale_items_reference_check` l'exige : une ligne `SERVICE` désigne
    // une prestation, une ligne `PRODUCT` un article, et aucune des deux ne se
    // laisse écrire avec les deux colonnes nulles. Un encaissement d'avant #817
    // ne dit pas ce qui a été vendu ; la seule référence qu'on puisse retrouver
    // sans rien inventer est la prestation de son rendez-vous.
    //
    // Sans rendez-vous, la vente reste donc **sans ligne** : le total dit ce qui
    // a été encaissé, et il n'y a rien à mentir sur le détail. Fabriquer une
    // ligne au prix de la reprise aurait fait échouer la transaction entière —
    // et avec elle toute la reprise.
    if (appointment !== null) {
      await tx.saleItem.create({
        data: {
          tenantId: payment.tenantId,
          saleId: sale.id,
          kind: 'SERVICE',
          serviceId: appointment.serviceId,
          productId: null,
          label: BACKFILL_LINE_LABEL,
          quantity: 1,
          unitAmountMinor: payment.amountMinor,
          lineAmountMinor: payment.amountMinor,
          currency: payment.currency,
          position: 0,
        },
      });
    }

    await tx.payment.update({ where: { id: payment.id }, data: { saleId: sale.id } });

    return sale.id;
  });
}

/** Une transaction du client non scopé, telle que Prisma la donne au rappel. */
type UnscopedTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Ce que la reprise retrouve du rendez-vous d'un encaissement.
 *
 * La cliente y sert d'opérateur au ticket, et la prestation de **référence** à
 * sa ligne : `sale_items_reference_check` interdit une ligne `SERVICE` sans
 * `service_id`, et c'est la seule référence qu'on puisse retrouver sans rien
 * inventer.
 */
async function resolveAppointment(
  tx: UnscopedTransaction,
  tenantId: string,
  appointmentId: string | null,
): Promise<{ readonly clientId: string; readonly serviceId: string } | null> {
  if (appointmentId === null) {
    return null;
  }

  return tx.appointment.findFirst({
    where: { tenantId, id: appointmentId },
    select: { clientId: true, serviceId: true },
  });
}

/**
 * Le compte auquel attribuer une vente reconstituée, à défaut de rendez-vous.
 *
 * Le compte d'administration le plus ancien de l'établissement. Aucune identité
 * n'est fabriquée : la colonne est `NOT NULL` et référence un compte réel, et un
 * identifiant inventé ferait échouer la clé étrangère — bruyamment, ce qui vaut
 * mieux, mais sans reprise possible.
 */
async function resolveAdmin(tx: UnscopedTransaction, tenantId: string): Promise<string> {
  const admin = await tx.user.findFirstOrThrow({
    where: { tenantId, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return admin.id;
}

/**
 * Liste les ventes qu'aucun encaissement ne solde — **pour décision**.
 *
 * Elles ne sont ni réglées, ni supprimées, ni marquées : le critère dit « liste
 * les ventes sans paiement, pour décision. Il n'invente aucun paiement », et
 * c'est la moitié du travail qu'un script ne doit justement pas faire à la
 * place d'une personne. Onze des douze tickets de Barber Tana tombent ici.
 */
async function reportUnpaidSales(prismaUnscoped: PrismaClient): Promise<number> {
  let total = 0;

  for (let offset = 0; ; offset += SCAN_BATCH_SIZE) {
    const sales = await prismaUnscoped.sale.findMany({
      where: { payments: { none: {} } },
      select: {
        id: true,
        tenantId: true,
        appointmentId: true,
        totalAmountMinor: true,
        currency: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: SCAN_BATCH_SIZE,
    });

    if (sales.length === 0) {
      break;
    }

    total += sales.length;

    for (const sale of sales) {
      report(
        `vente ${sale.id} (tenant ${sale.tenantId}) : ${sale.totalAmountMinor} ${sale.currency} ` +
          `du ${sale.createdAt.toISOString()} — aucun encaissement` +
          (sale.appointmentId === null ? ' (vente retail)' : ` (rendez-vous ${sale.appointmentId})`) +
          '. Pour décision — aucun paiement n’est inventé.',
      );
    }
  }

  return total;
}

// Le point d'entrée du script. Sous `require.main === module`, il ne s'exécute
// que sur invocation directe — la suite unitaire importe les fonctions pures
// au-dessus sans jamais ouvrir de connexion.
if (require.main === module) {
  const prismaUnscoped = new PrismaClient();
  const apply = process.argv.includes('--apply');

  runSaleBackfill(prismaUnscoped, apply)
    .then(() => prismaUnscoped.$disconnect())
    .catch(async (error: unknown) => {
      console.error(`${REPORT_PREFIX}: échec de la reprise`, error);
      await prismaUnscoped.$disconnect();
      process.exitCode = 1;
    });
}
