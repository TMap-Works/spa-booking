import { PrismaClient } from '@prisma/client';

import { netOf, taxLineLabel } from './pos.totals';

/**
 * La reprise des tickets composés **avant** #816 — cinquième critère de l'issue.
 *
 * Jusqu'à #816, `composeSale` **ajoutait** la taxe au sous-total : les prix du
 * catalogue étaient traités comme des prix hors taxes, et un ticket de 89,00 €
 * de prestations et d'articles s'inscrivait à 106,80 € en base. Les tickets déjà
 * écrits portent cette règle-là ; les corriger demande de les reconnaître, et
 * c'est tout l'objet de ce fichier.
 *
 * ## Deux moitiés, et pourquoi elles cohabitent ici
 *
 * - une partie **pure** — `auditSaleTax` —, qui classe un ticket à partir de ses
 *   seuls montants et recompose ceux de l'ancienne règle. Elle n'a ni base ni
 *   effet de bord, et c'est elle que la suite unitaire exerce centime par
 *   centime, comme tout calcul d'argent du module ;
 * - un **script**, sous `require.main === module`, qui applique cette fonction
 *   à la base. Importer ce fichier n'exécute donc rien.
 *
 * ## Ce que le script lit, et pourquoi il n'est pas un repository
 *
 * Il balaie **tous les établissements** : c'est une reprise de données, jouée
 * hors de toute requête HTTP, et il n'existe aucun tenant courant à partir
 * duquel se scoper. C'est la même dérogation que `PRISMA_UNSCOPED` accorde aux
 * traitements légitimement inter-tenants (tenant-isolation §3), à ceci près
 * qu'elle ne peut pas passer par l'injection Nest : le script ne monte pas
 * l'application. Le client est donc construit ici et **nommé `prismaUnscoped`**,
 * pour que la convention de relecture du dépôt continue de valoir — un accès non
 * scopé se reconnaît à son nom, et `grep -rn prismaUnscoped apps/api/src` mène
 * jusqu'ici.
 *
 * Chaque ticket reste traité **dans son établissement** : le taux appliqué est
 * celui de son tenant, lu ligne à ligne, jamais un taux global.
 *
 * ## Comment on le joue
 *
 * ```bash
 * # 1. le constat, sans rien écrire — c'est le mode par défaut
 * node --require ts-node/register apps/api/src/modules/payments/pos.tax-backfill.ts
 *
 * # 2. la reprise, une fois le constat relu
 * node --require ts-node/register apps/api/src/modules/payments/pos.tax-backfill.ts --apply
 * ```
 *
 * Le mode par défaut **ne touche à rien** : il liste. `--apply` recalcule, ticket
 * par ticket, dans une transaction par ticket. Un ticket que la fonction ne sait
 * pas classer est **signalé** et jamais réécrit — l'issue autorise explicitement
 * de « recalculer ou signaler », et deviner les intentions d'un montant qu'on ne
 * reconnaît pas serait la pire des deux options sur une pièce comptable.
 */

/** Le dénominateur des points de base — celui de `pos.totals.ts`. */
const BPS_DENOMINATOR = 10_000;

/** Le nom du fichier dans les lignes de rapport. */
const REPORT_PREFIX = 'pos.tax-backfill';

/**
 * Le nombre de tickets lus par aller-retour.
 *
 * La base d'un déployé porte autant de tickets qu'il s'est fait de ventes ; les
 * charger d'un seul `findMany`, **lignes comprises**, ferait tenir toute la
 * comptabilité du parc dans la mémoire du script. Le balayage se fait donc par
 * tranches, dans un ordre stable — ni `created_at` ni `id` ne bougent sous la
 * reprise, qui ne réécrit que des montants.
 */
const SCAN_BATCH_SIZE = 500;

/**
 * L'ancienne règle, gardée pour **reconnaître** ce qu'elle a produit.
 *
 * C'est le `taxOn` que #816 retire de `pos.totals.ts` : `arrondi(base × taux /
 * 10 000)`, la taxe *ajoutée* à un sous-total tenu pour hors taxes. Elle n'a plus
 * aucun appelant dans le chemin de composition, et n'en aura plus jamais — elle
 * ne sert qu'ici, à distinguer un ticket ancien d'un ticket récent.
 */
export function legacyTaxOn(baseAmountMinor: number, taxRateBps: number): number {
  if (taxRateBps === 0) {
    return 0;
  }

  return Math.floor((baseAmountMinor * taxRateBps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
}

/** Ce qu'il faut savoir d'un ticket pour le classer — rien de plus. */
export interface SaleTaxFacts {
  /** Le taux de l'**établissement du ticket**, en points de base. */
  readonly taxRateBps: number;
  /** La somme des lignes `SERVICE` et `PRODUCT`, telle qu'elle est en base. */
  readonly catalogAmountMinor: number;
  readonly subtotalAmountMinor: number;
  readonly taxAmountMinor: number;
  readonly tipAmountMinor: number;
  readonly totalAmountMinor: number;
}

/**
 * Le verdict porté sur un ticket.
 *
 * - `conforme` — composé avec la règle de #816, ou insensible à la règle (taux
 *   nul, ticket vide) : rien à faire ;
 * - `ancienne-regle` — la taxe a été **ajoutée** aux prix affichés ; les
 *   montants corrigés accompagnent le verdict ;
 * - `indeterminee` — les montants ne correspondent ni à l'une ni à l'autre. Le
 *   ticket est signalé et laissé intact.
 */
export type SaleTaxVerdict = 'conforme' | 'ancienne-regle' | 'indeterminee';

/** Les trois montants qu'une reprise réécrit. */
export interface RecomposedAmounts {
  readonly subtotalAmountMinor: number;
  readonly taxAmountMinor: number;
  readonly totalAmountMinor: number;
}

export interface SaleTaxAudit {
  readonly verdict: SaleTaxVerdict;
  /** Les montants corrigés — présents **si et seulement si** le verdict est `ancienne-regle`. */
  readonly corrected: RecomposedAmounts | null;
}

/**
 * Classe un ticket, et recompose ses montants s'il relève de l'ancienne règle.
 *
 * Le discriminant tient en une ligne : **où se trouve la somme des prix
 * affichés**.
 *
 * | Règle | `catalogue` vaut | et la taxe est |
 * |---|---|---|
 * | #816 | `sous-total + taxe` | `catalogue − sous-total`, extraite |
 * | ancienne | `sous-total` | `arrondi(sous-total × taux / 10 000)`, ajoutée |
 *
 * Les deux lectures coïncident exactement quand la taxe est nulle — taux à zéro,
 * ou ticket sans ligne de catalogue —, et c'est alors `conforme` qui l'emporte :
 * il n'y a rien à reprendre, ce qui est le septième critère de #816.
 *
 * Le total est vérifié dans les deux cas. Un ticket dont le total ne somme pas
 * ses parts n'a pas été écrit par ce module — `sales_total_amount_minor_check`
 * l'interdit en base — et sort en `indeterminee` plutôt que d'être « corrigé »
 * sur une hypothèse.
 */
export function auditSaleTax(facts: SaleTaxFacts): SaleTaxAudit {
  const sums =
    facts.totalAmountMinor ===
    facts.subtotalAmountMinor + facts.taxAmountMinor + facts.tipAmountMinor;

  if (!sums) {
    return { verdict: 'indeterminee', corrected: null };
  }

  const current =
    facts.subtotalAmountMinor + facts.taxAmountMinor === facts.catalogAmountMinor &&
    facts.subtotalAmountMinor === netOf(facts.catalogAmountMinor, facts.taxRateBps);

  if (current) {
    return { verdict: 'conforme', corrected: null };
  }

  const legacy =
    facts.subtotalAmountMinor === facts.catalogAmountMinor &&
    facts.taxAmountMinor === legacyTaxOn(facts.catalogAmountMinor, facts.taxRateBps);

  if (!legacy) {
    return { verdict: 'indeterminee', corrected: null };
  }

  return { verdict: 'ancienne-regle', corrected: recompose(facts) };
}

/**
 * Les montants qu'un ticket de l'ancienne règle aurait aujourd'hui.
 *
 * La somme des prix affichés est son **sous-total d'alors** : c'est ce que
 * l'ancienne règle y mettait. Elle devient le total hors pourboire, et la taxe
 * s'en extrait — exactement ce que `composeSale` ferait si le ticket était
 * recomposé ligne à ligne, sans avoir à relire le catalogue, dont les prix ont
 * pu changer depuis.
 */
function recompose(facts: SaleTaxFacts): RecomposedAmounts {
  const grossAmountMinor = facts.catalogAmountMinor;
  const subtotalAmountMinor = netOf(grossAmountMinor, facts.taxRateBps);

  return {
    subtotalAmountMinor,
    taxAmountMinor: grossAmountMinor - subtotalAmountMinor,
    totalAmountMinor: grossAmountMinor + facts.tipAmountMinor,
  };
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

/**
 * Balaie la base, classe chaque ticket, et écrit le rapport.
 *
 * @param apply `true` pour réécrire les tickets de l'ancienne règle.
 * @returns le nombre de tickets relevant de l'ancienne règle.
 */
export async function runBackfill(prismaUnscoped: PrismaClient, apply: boolean): Promise<number> {
  const tenants = await prismaUnscoped.tenant.findMany({
    select: { id: true, taxRateBps: true },
  });
  const taxRateOf = new Map(tenants.map((tenant) => [tenant.id, tenant.taxRateBps]));

  let legacy = 0;
  let unknown = 0;
  let examined = 0;

  for (let offset = 0; ; offset += SCAN_BATCH_SIZE) {
    // Tranche par tranche, et non d'un seul `findMany` : voir `SCAN_BATCH_SIZE`.
    // L'ordre est total — `id` départage deux tickets de la même milliseconde —,
    // sans quoi deux tranches pourraient se recouvrir ou s'ignorer.
    const sales = await prismaUnscoped.sale.findMany({
      select: {
        id: true,
        tenantId: true,
        currency: true,
        subtotalAmountMinor: true,
        taxAmountMinor: true,
        tipAmountMinor: true,
        totalAmountMinor: true,
        items: { select: { id: true, kind: true, lineAmountMinor: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: SCAN_BATCH_SIZE,
    });

    if (sales.length === 0) {
      break;
    }

    examined += sales.length;

    for (const sale of sales) {
      const taxRateBps = taxRateOf.get(sale.tenantId);

      if (taxRateBps === undefined) {
        // Impossible tant que la clé étrangère tient ; signalé plutôt que supposé.
        report(`${sale.id} : établissement ${sale.tenantId} introuvable — ticket ignoré`);
        unknown += 1;
        continue;
      }

      const catalogAmountMinor = sale.items
        .filter((item) => item.kind === 'SERVICE' || item.kind === 'PRODUCT')
        .reduce((sum, item) => sum + item.lineAmountMinor, 0);

      const audit = auditSaleTax({
        taxRateBps,
        catalogAmountMinor,
        subtotalAmountMinor: sale.subtotalAmountMinor,
        taxAmountMinor: sale.taxAmountMinor,
        tipAmountMinor: sale.tipAmountMinor,
        totalAmountMinor: sale.totalAmountMinor,
      });

      if (audit.verdict === 'conforme') {
        continue;
      }

      if (audit.verdict === 'indeterminee' || audit.corrected === null) {
        report(
          `${sale.id} (tenant ${sale.tenantId}) : montants non reconnus ` +
            `— sous-total ${sale.subtotalAmountMinor}, taxe ${sale.taxAmountMinor}, ` +
            `pourboire ${sale.tipAmountMinor}, total ${sale.totalAmountMinor} ${sale.currency}. ` +
            `Signalé, non réécrit.`,
        );
        unknown += 1;
        continue;
      }

      legacy += 1;
      const corrected = audit.corrected;

      if (apply) {
        const taxLine = sale.items.find((item) => item.kind === 'TAX');

        // **Avant** la ligne de rapport, et non après : le rapport d'une reprise
        // est la trace de ce qui a été écrit. L'annoncer d'abord ferait mentir le
        // journal sur le ticket dont la transaction échoue — celui-là justement
        // qu'il faudrait pouvoir retrouver.
        await prismaUnscoped.$transaction(async (tx) => {
          await tx.sale.update({
            where: { id: sale.id },
            data: {
              subtotalAmountMinor: corrected.subtotalAmountMinor,
              taxAmountMinor: corrected.taxAmountMinor,
              totalAmountMinor: corrected.totalAmountMinor,
            },
          });

          if (taxLine === undefined) {
            return;
          }

          if (corrected.taxAmountMinor === 0) {
            // Une ligne de ventilation à zéro se lirait comme une erreur sur le
            // reçu — `composeSale` n'en compose pas.
            await tx.saleItem.delete({ where: { id: taxLine.id } });
            return;
          }

          await tx.saleItem.update({
            where: { id: taxLine.id },
            data: {
              label: taxLineLabel(taxRateBps),
              unitAmountMinor: corrected.taxAmountMinor,
              lineAmountMinor: corrected.taxAmountMinor,
            },
          });
        });
      }

      report(
        `${sale.id} (tenant ${sale.tenantId}) : ancienne règle — ` +
          `total ${sale.totalAmountMinor} → ${corrected.totalAmountMinor} ${sale.currency}, ` +
          `sous-total ${sale.subtotalAmountMinor} → ${corrected.subtotalAmountMinor}, ` +
          `taxe ${sale.taxAmountMinor} → ${corrected.taxAmountMinor}` +
          (apply ? '' : ' (aucune écriture : relancer avec --apply)'),
      );
    }
  }

  report(
    `${examined} ticket(s) examiné(s), ${legacy} de l'ancienne règle, ` +
      `${unknown} signalé(s), ${apply ? 'écritures appliquées' : 'aucune écriture'}.`,
  );

  return legacy;
}

// Le point d'entrée du script. Sous `require.main === module`, il ne s'exécute
// que sur invocation directe — la suite unitaire importe les fonctions pures
// au-dessus sans jamais ouvrir de connexion.
if (require.main === module) {
  /**
   * Le client **non scopé** de la reprise — voir l'en-tête du fichier.
   *
   * Il n'est construit que sur exécution directe : importer ce module pour ses
   * fonctions pures n'ouvre aucune connexion.
   */
  const prismaUnscoped = new PrismaClient();
  const apply = process.argv.includes('--apply');

  runBackfill(prismaUnscoped, apply)
    .then(() => prismaUnscoped.$disconnect())
    .catch(async (error: unknown) => {
      console.error(`${REPORT_PREFIX}: échec de la reprise`, error);
      await prismaUnscoped.$disconnect();
      process.exitCode = 1;
    });
}
