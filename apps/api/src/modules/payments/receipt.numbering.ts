import { randomUUID } from 'node:crypto';

import { requireTenantId } from '../../common/tenant/tenant-context';
import type { ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';

/**
 * L'attribution d'un numéro de pièce — #818, premier critère.
 *
 * Un seul geste, et il n'existe qu'à l'intérieur d'une transaction : celle qui
 * **clôt** la vente. C'est ce qui fait tenir « la suite n'a aucun trou, même
 * sous concurrence », et c'est pour cela que ce fichier n'expose pas un service
 * mais une fonction qu'on appelle avec le client transactionnel de l'appelant.
 *
 * ## Les deux mécanismes, et pourquoi il en faut deux
 *
 * - `SELECT "next_value" … FOR UPDATE` **sérialise** les clôtures concurrentes
 *   d'un même établissement. Le second entrant attend que le premier ait
 *   commité, relit la valeur qu'il vient d'écrire — `READ COMMITTED` relit la
 *   ligne après avoir pris le verrou — et prend le rang suivant. Sans lui, huit
 *   clôtures simultanées liraient toutes le même `next_value` et écriraient
 *   toutes le même rang ;
 * - `sales_tenant_id_receipt_number_key` rend ce doublon **non représentable**.
 *   Même si ce fichier se trompait, la base refuserait.
 *
 * Le verrou **explicite** plutôt qu'un `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` en une instruction, qui tiendrait le même invariant pour un
 * aller-retour de moins : le premier critère de #818 nomme le mécanisme —
 * « verrouillé en transaction (table `receipt_counters`, `SELECT … FOR
 * UPDATE`) » —, et le texte de la migration le décrit. Un invariant de
 * concurrence se relit ; l'écrire sous la forme que le ticket, le schéma et la
 * migration annoncent vaut l'aller-retour que cela coûte, d'autant qu'il se joue
 * sur une ligne déjà chaude, dans une transaction qui en fait trois autres.
 *
 * C'est la conduite que CLAUDE.md impose au double encaissement comme à la
 * double réservation : contrainte en base **et** verrou transactionnel, jamais
 * l'un sans l'autre (contrainte n°4, ADR 0002).
 *
 * ## Pourquoi ce n'est pas une `SEQUENCE`
 *
 * Parce qu'une séquence PostgreSQL ne revient pas en arrière quand la
 * transaction qui l'a consommée échoue — c'est sa propriété de conception, et
 * c'est précisément le trou que le critère interdit. L'incrément d'une **ligne**
 * verrouillée, lui, est annulé avec la transaction : un règlement refusé par
 * `sales_settled_amount_minor_check` rend son rang, et la clôture suivante le
 * reprend.
 *
 * Et pourquoi ce n'est pas `MAX(receipt_number) + 1` : parce que c'est une
 * vérification applicative. Deux clôtures simultanées lisent le même maximum,
 * l'unique en refuse une, et le comptoir reçoit une panne là où il doit recevoir
 * un ticket.
 *
 * ## Pourquoi du SQL brut
 *
 * `FOR UPDATE` ne s'exprime pas dans l'API de Prisma. Les trois requêtes portent
 * donc leur propre prédicat d'établissement — `$queryRaw` ne traverse pas
 * l'extension de scoping (ADR 0006) —, et sa valeur vient de
 * `requireTenantId()`, c'est-à-dire du contexte de requête et jamais d'un
 * paramètre que l'appelant choisirait (tenant-isolation §2). Un compteur du
 * salon voisin est donc inatteignable par cette porte.
 */

/**
 * Ce que l'allocation exige de son client : les deux portes de SQL brut.
 *
 * Un `Pick` et non une interface recopiée : le client transactionnel de Prisma
 * les porte toutes deux, qu'il vienne du dépôt du règlement ou de celui du
 * webhook, et une signature écrite à la main aurait fini par diverger de la leur
 * à la première montée de version.
 */
export type ReceiptCounterTransaction = Pick<ScopedPrismaClient, '$queryRaw' | '$executeRaw'>;

/** Ce que le verrou rapporte du compteur. */
interface CounterRow {
  readonly nextValue: number;
}

/**
 * Prend le prochain rang de l'établissement courant, et avance le compteur.
 *
 * À appeler **dans la transaction qui pose `settled_at`**, et nulle part
 * ailleurs : un rang pris hors d'elle serait un rang consommé par une clôture
 * qui peut encore échouer.
 *
 * @param tx la transaction de clôture — celle-là, pas une autre.
 * @returns le rang attribué, à partir de 1.
 * @throws {Error} si le compteur reste introuvable après avoir été créé — ce
 * qui ne peut pas arriver et se signale bruyamment plutôt que de rendre un rang
 * inventé.
 */
export async function allocateReceiptNumber(tx: ReceiptCounterTransaction): Promise<number> {
  return allocateReceiptNumberFor(tx, requireTenantId('ReceiptCounter', 'allocate'));
}

/**
 * La même allocation, l'établissement **donné en paramètre**.
 *
 * Réservée aux reprises qui tournent sans portée de tenant — `pos.sale-backfill.ts`
 * et son client non scopé, seul chemin du module qui clôture des ventes en
 * dehors d'une requête HTTP. Même régime que `prismaUnscoped` : nommée,
 * justifiée, et dont le `grep` doit rester une liste courte (tenant-isolation §3).
 *
 * **Jamais depuis une route.** Là, l'établissement vient du jeton vérifié et de
 * lui seul (tenant-isolation §2) : c'est ce que {@link allocateReceiptNumber}
 * fait, et c'est la seule forme qu'un dépôt a le droit d'appeler.
 */
export async function allocateReceiptNumberFor(
  tx: ReceiptCounterTransaction,
  tenantId: string,
): Promise<number> {
  // Le compteur d'un établissement né après la migration — ou d'un
  // établissement semé par une suite de test. `DO NOTHING` plutôt qu'une
  // lecture préalable : deux clôtures simultanées du premier ticket d'un salon
  // ne doivent pas conclure toutes deux « il n'y a pas de compteur » et en
  // écrire deux. PostgreSQL fait attendre la seconde insertion, qui ne fait
  // alors rien, et le `SELECT … FOR UPDATE` qui suit voit la ligne validée.
  await tx.$executeRaw`
    INSERT INTO "receipt_counters" ("id", "tenant_id", "next_value", "created_at", "updated_at")
    VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, 1, now(), now())
    ON CONFLICT ("tenant_id") DO NOTHING
  `;

  // **Le verrou du premier critère.** Il sérialise les clôtures concurrentes du
  // même établissement : le second entrant attend le commit du premier, puis
  // relit la valeur validée avant de prendre la sienne.
  const rows = await tx.$queryRaw<readonly CounterRow[]>`
    SELECT "next_value" AS "nextValue"
    FROM "receipt_counters"
    WHERE "tenant_id" = ${tenantId}::uuid
    FOR UPDATE
  `;

  const counter = rows[0];

  if (counter === undefined) {
    // Inatteignable : la ligne vient d'être créée ou existait déjà. Se signaler
    // vaut mieux que rendre un rang qui percerait la suite.
    throw new Error('Le compteur de pièces vient d’être créé et reste introuvable.');
  }

  // L'incrément vit **dans** la transaction de clôture : un règlement refusé par
  // `sales_settled_amount_minor_check` rend son rang, et la clôture suivante le
  // reprend. `next_value` reste le prochain rang à attribuer, jamais le dernier
  // attribué.
  await tx.$executeRaw`
    UPDATE "receipt_counters"
    SET "next_value" = "next_value" + 1, "updated_at" = now()
    WHERE "tenant_id" = ${tenantId}::uuid
  `;

  return counter.nextValue;
}
