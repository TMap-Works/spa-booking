import { Inject, Injectable } from '@nestjs/common';

import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import {
  APPOINTMENT_STATUSES,
  REVENUE_PAYMENT_STATUSES,
  type AppointmentGrouping,
  type AppointmentStatus,
  type AppointmentVolumeRow,
  type DailyRevenueRow,
  type NoShowCounts,
  type PaymentMethod,
  type ReportWindow,
} from './reporting.types';

/**
 * Seul point du module qui connaît le schéma (api-module §2) — et le seul qui
 * écrive du SQL.
 *
 * ## Pourquoi du SQL brut, et non l'API de Prisma
 *
 * Parce que le contexte de #74 le demande en toutes lettres : « les agrégats
 * s'appuient sur SQL, pas sur du code applicatif ». Ce n'est pas une préférence
 * de style, c'est le seul dessin qui tienne le cinquième critère. Trois
 * agrégats, trois raisons distinctes :
 *
 * - **le revenu quotidien** groupe sur une expression — la date civile d'un
 *   `timestamptz` ramené dans le fuseau du salon. `groupBy` de Prisma ne groupe
 *   que sur des colonnes ; l'alternative aurait été de rapatrier une année
 *   d'encaissements pour les regrouper en mémoire, c'est-à-dire de faire de
 *   chaque ouverture d'écran un transfert de table ;
 * - **le volume de rendez-vous** croise l'axe et le statut — un `GROUP BY` à
 *   deux colonnes dont Prisma ne rend pas la forme tabulée, et une jointure
 *   vers `staff` ou `services` pour le libellé ;
 * - **les no-shows** se comptent par `FILTER (WHERE …)`, cinq compteurs en un
 *   seul balayage là où cinq `count` en auraient fait cinq — et sur un état
 *   cohérent, ce que cinq lectures successives ne garantissent pas.
 *
 * ## Ce que cela impose, et qui n'est pas négociable
 *
 * Le SQL brut **ne repasse pas par l'extension de scoping** : `$queryRaw` ne
 * traverse pas le pipeline `$allOperations`, et aucun `WHERE tenant_id = …` n'y
 * est injecté (`tenant-scope.extension.ts`, angle mort n°1 ; ADR 0006). Chacune
 * des requêtes de ce fichier porte donc son propre prédicat d'établissement,
 * écrit à la main, et sa valeur vient de `requireTenantId()` — du contexte de
 * requête, jamais d'un paramètre que l'appelant choisirait
 * (tenant-isolation §2). Sans portée ouverte, la lecture échoue ici plutôt que
 * de traverser les établissements.
 *
 * `tenant/raw-sql-tenant-filter` vérifie mécaniquement cette présence sur chaque
 * site d'appel, et ce module n'a **aucune** dérogation : aucun `eslint-disable`
 * ne nomme cette règle ici.
 *
 * ## Les bornes de fenêtre passent en ISO, pas en `Date`
 *
 * `${window.from.toISOString()}::timestamptz` et non `${window.from}`. Un
 * paramètre lié depuis un `Date` est typé par le pilote, et rien ne garantit
 * qu'il arrive en `timestamptz` plutôt qu'en `timestamp` nu — auquel cas le
 * transtypage l'interpréterait dans le fuseau **de la session PostgreSQL**,
 * c'est-à-dire dans le fuseau de personne. La frontière d'une journée de caisse
 * se déplacerait alors d'autant, en silence, et seulement sur les déploiements
 * dont la session n'est pas en UTC. Une chaîne ISO 8601 suffixée `Z` ne laisse
 * aucune latitude : elle désigne le même instant quelle que soit la session.
 *
 * ## Ce que ce dépôt n'a pas
 *
 * **Aucun `prismaUnscoped`.** Un agrégat inter-tenant serait une statistique de
 * plateforme, ce que le MVP ne demande pas ; le client non scopé n'est donc pas
 * injecté du tout, ce qui est plus sûr qu'un client disponible dont on se
 * promet de ne pas se servir (tenant-isolation §3).
 *
 * **Aucune écriture.** Pas un `INSERT`, pas un `UPDATE`, pas une transaction. Un
 * module de lecture qui saurait écrire finirait par le faire.
 *
 * **Aucun repository voisin importé.** Il lit `payments`, `appointments`,
 * `staff` et `services` directement — c'est une projection en lecture seule qui
 * ne décide d'aucune règle de cycle de vie, et faire porter une requête
 * d'agrégation par `AppointmentsService` aurait mis la question du reporting
 * dans le module des rendez-vous (même argument qu'en tête de `CrmRepository`).
 */

/**
 * Les statuts d'encaissement qui font recette, développés en trois liaisons.
 *
 * Prisma interpole un tableau lié comme un **unique** paramètre, ce que `IN` ne
 * sait pas lire. `Prisma.join` répond à ce besoin, mais il produit un SQL que
 * `tenant/raw-sql-tenant-filter` ne lit plus comme un littéral — et la garde
 * refuse par principe une requête qu'elle ne peut pas lire (`opaqueSql`). Les
 * trois valeurs sont donc développées à la main au site d'appel : trois `${…}`,
 * trois paramètres liés, aucune concaténation de chaîne.
 *
 * Le déstructurage plutôt qu'un indiçage : si un quatrième statut rejoignait
 * {@link REVENUE_PAYMENT_STATUSES}, il resterait ignoré des requêtes. C'est
 * `reporting.vocabulary.spec.ts` qui l'interdit, en vérifiant que la liste en
 * compte exactement trois.
 *
 * ## Le transtypage porte sur le **paramètre**, jamais sur la colonne
 *
 * `${…}::"PaymentStatus"` et non `"status"::text IN (…)`. Les deux rendent le
 * même résultat, mais transtyper la colonne rend l'index inutilisable sur elle :
 * `status` cesse d'être une borne de parcours, et `captured_at` — qui la suit
 * dans `payments (tenant_id, status, captured_at)` — cesse de l'être aussi. Le
 * moteur balaie alors *tout* l'historique d'encaissement du salon pour n'en
 * garder qu'une fenêtre, au lieu de descendre directement dessus. Relevé sur
 * PostgreSQL 16, 60 000 lignes, fenêtre d'une journée : 580 pages lues contre 9.
 * Le coût croît avec l'histoire de l'établissement, pas avec la fenêtre
 * demandée — exactement ce que le cinquième critère de #74 et l'index de la
 * migration existent pour empêcher.
 *
 * Un paramètre lié transtypé vers un `enum` PostgreSQL est la forme que Prisma
 * attend pour ces colonnes-là, au même titre que le `::uuid` du prédicat
 * d'établissement juste au-dessus.
 */
const [REVENUE_STATUS_1, REVENUE_STATUS_2, REVENUE_STATUS_3] = REVENUE_PAYMENT_STATUSES;

/** Une ligne de revenu telle que PostgreSQL la rend — comptes en `bigint`. */
interface RevenueSqlRow {
  readonly bucket: string;
  readonly method: string;
  readonly currency: string;
  readonly transactions: bigint;
  readonly gross: bigint;
  readonly refunded: bigint;
}

/** Une ligne de volume telle que PostgreSQL la rend : un groupe, un statut. */
export interface VolumeSqlRow {
  readonly bucket: string;
  readonly label: string | null;
  readonly status: string;
  readonly appointments: bigint;
}

/** Les cinq compteurs de no-show, en une ligne. */
interface NoShowSqlRow {
  readonly noShows: bigint;
  readonly honored: bigint;
  readonly cancelled: bigint;
  readonly pending: bigint;
  readonly total: bigint;
}

/**
 * Un `bigint` de PostgreSQL ramené au `number` de JavaScript.
 *
 * `COUNT` et `SUM` rendent un `bigint`, que le pilote remonte en `BigInt` — un
 * type que `JSON.stringify` **refuse** de sérialiser, et qui casserait donc la
 * réponse HTTP à l'endroit le plus tardif possible. La conversion se fait ici, à
 * la sortie du dépôt, une fois.
 *
 * Elle est exacte tant que la valeur tient sous 2^53. Pour un compte de
 * rendez-vous, la marge est absurde ; pour une somme de montants en plus petite
 * unité monétaire, elle vaut 90 000 milliards de centimes sur une fenêtre d'au
 * plus un an. Ce n'est pas une approximation tolérée, c'est une borne que le
 * plafond de fenêtre garantit.
 */
function toCount(value: bigint): number {
  return Number(value);
}

@Injectable()
export class ReportingRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Le fuseau de l'établissement courant, ou `null` s'il n'existe plus.
   *
   * Une lecture par l'API de Prisma et non en SQL brut : `Tenant` est scopé par
   * l'extension sur son `id` (`tenant-scope.extension.ts`), si bien que ce
   * `findFirst` ne peut rendre que l'établissement du contexte. Même geste que
   * `AppointmentsRepository.currentTimeZone` et que `AvailabilityRepository`, et
   * pour la même raison : c'est le fuseau qui décide du découpage des journées,
   * et le deviner serait un bug de sévérité haute.
   */
  public async currentTimeZone(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { timezone: true } });

    return tenant?.timezone ?? null;
  }

  /**
   * Le revenu de la fenêtre, ventilé par **jour civil du salon** et par moyen de
   * paiement — premier critère de #74.
   *
   * ## Ce que la requête compte, et ce qu'elle écarte
   *
   * `captured_at` et non `created_at` : c'est l'instant où l'argent a été pris,
   * celui qui décide du jour de caisse (`payments.types.ts`). Un règlement
   * ouvert à 23 h 58 et capturé à 00 h 03 appartient au lendemain. Une intention
   * jamais capturée porte `captured_at IS NULL` et se trouve écartée par la
   * comparaison de bornes elle-même — elle n'appartient à aucun jour.
   *
   * Seuls les statuts de {@link REVENUE_PAYMENT_STATUSES} entrent : une
   * intention `PENDING` n'est pas une recette, une carte `FAILED` non plus. Un
   * encaissement remboursé, lui, reste au relevé — c'est
   * `refunded_amount_minor` qui le retranche du net, jamais son exclusion.
   *
   * ## Le découpage des journées
   *
   * `captured_at AT TIME ZONE ${timeZone}` ramène l'instant absolu dans le
   * fuseau du salon avant d'en prendre la date civile. C'est la journée telle
   * que le gérant la vit : à Papeete, la recette du 3 mars n'est pas celle
   * qu'UTC appelle le 3 mars. Le fuseau est un **paramètre lié**, jamais une
   * chaîne concaténée.
   *
   * ## L'index emprunté
   *
   * `payments (tenant_id, status, captured_at)`, posé par ce ticket, sert la
   * clause `WHERE` telle qu'elle est écrite : établissement, puis statut, puis
   * fenêtre. Le `GROUP BY` porte sur une expression et ne peut donc pas être
   * servi par un index — mais il ne trie plus qu'un sous-ensemble déjà réduit à
   * la fenêtre.
   */
  public async dailyRevenue(
    window: ReportWindow,
    timeZone: string,
  ): Promise<readonly DailyRevenueRow[]> {
    const tenantId = requireTenantId('Payment', 'dailyRevenue');

    const rows = await this.prisma.$queryRaw<RevenueSqlRow[]>`
      SELECT
        to_char(("captured_at" AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS bucket,
        "method"::text AS method,
        "currency" AS currency,
        COUNT(*)::bigint AS transactions,
        COALESCE(SUM("amount_minor"), 0)::bigint AS gross,
        COALESCE(SUM("refunded_amount_minor"), 0)::bigint AS refunded
      FROM "payments"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "status" IN (
          ${REVENUE_STATUS_1}::"PaymentStatus",
          ${REVENUE_STATUS_2}::"PaymentStatus",
          ${REVENUE_STATUS_3}::"PaymentStatus"
        )
        AND "captured_at" >= ${window.from.toISOString()}::timestamptz
        AND "captured_at" < ${window.to.toISOString()}::timestamptz
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `;

    return rows.map(toRevenueRow);
  }

  /**
   * Le volume de rendez-vous de la fenêtre, sur l'axe demandé et ventilé par
   * statut — deuxième critère de #74.
   *
   * ## Trois requêtes plutôt qu'une paramétrée
   *
   * L'axe change la colonne de groupement, la jointure et le libellé : ce ne
   * sont pas trois valeurs, ce sont trois requêtes. Les composer par
   * concaténation aurait produit un SQL que `tenant/raw-sql-tenant-filter` ne
   * peut plus lire — et elle a raison de refuser ce qu'elle ne peut pas lire.
   * Trois littéraux, trois prédicats d'établissement visibles à l'œil nu.
   *
   * ## Les index que chaque axe emprunte
   *
   * | Axe | Index |
   * |---|---|
   * | `day` | `appointments (tenant_id, starts_at)` |
   * | `staff` | `appointments (tenant_id, staff_id, starts_at)` |
   * | `service` | `appointments (tenant_id, service_id, starts_at)` — posé par ce ticket |
   *
   * ## La fenêtre porte sur `starts_at`
   *
   * C'est la date du rendez-vous, pas celle de sa prise. « Combien de
   * rendez-vous en mars » se lit sur les rendez-vous de mars, pas sur les
   * réservations faites en mars pour avril.
   *
   * ## Les jointures ne peuvent pas sortir de l'établissement
   *
   * `staff` et `services` sont jointes sur `(tenant_id, id)` — le couple, pas
   * l'identifiant seul. C'est la garantie des clés étrangères composites du
   * schéma, réécrite ici parce que le SQL brut ne bénéficie d'aucun scoping
   * automatique : même si une ligne d'un salon référençait celle d'un autre, la
   * jointure ne la trouverait pas.
   */
  public async appointmentVolume(
    window: ReportWindow,
    timeZone: string,
    groupBy: AppointmentGrouping,
  ): Promise<readonly AppointmentVolumeRow[]> {
    const tenantId = requireTenantId('Appointment', 'appointmentVolume');

    return foldVolumeRows(await this.readVolumeRows(tenantId, window, timeZone, groupBy));
  }

  /** La requête d'un axe, et rien d'autre — voir {@link appointmentVolume}. */
  private async readVolumeRows(
    tenantId: string,
    window: ReportWindow,
    timeZone: string,
    groupBy: AppointmentGrouping,
  ): Promise<readonly VolumeSqlRow[]> {
    if (groupBy === 'staff') {
      return this.prisma.$queryRaw<VolumeSqlRow[]>`
        SELECT
          a."staff_id"::text AS bucket,
          s."display_name" AS label,
          a."status"::text AS status,
          COUNT(*)::bigint AS appointments
        FROM "appointments" a
        JOIN "staff" s ON s."tenant_id" = a."tenant_id" AND s."id" = a."staff_id"
        WHERE a."tenant_id" = ${tenantId}::uuid
          AND a."starts_at" >= ${window.from.toISOString()}::timestamptz
          AND a."starts_at" < ${window.to.toISOString()}::timestamptz
        GROUP BY 1, 2, 3
        ORDER BY 2, 1, 3
      `;
    }

    if (groupBy === 'service') {
      return this.prisma.$queryRaw<VolumeSqlRow[]>`
        SELECT
          a."service_id"::text AS bucket,
          sv."name" AS label,
          a."status"::text AS status,
          COUNT(*)::bigint AS appointments
        FROM "appointments" a
        JOIN "services" sv ON sv."tenant_id" = a."tenant_id" AND sv."id" = a."service_id"
        WHERE a."tenant_id" = ${tenantId}::uuid
          AND a."starts_at" >= ${window.from.toISOString()}::timestamptz
          AND a."starts_at" < ${window.to.toISOString()}::timestamptz
        GROUP BY 1, 2, 3
        ORDER BY 2, 1, 3
      `;
    }

    return this.prisma.$queryRaw<VolumeSqlRow[]>`
      SELECT
        to_char(("starts_at" AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD') AS bucket,
        NULL::text AS label,
        "status"::text AS status,
        COUNT(*)::bigint AS appointments
      FROM "appointments"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "starts_at" >= ${window.from.toISOString()}::timestamptz
        AND "starts_at" < ${window.to.toISOString()}::timestamptz
      GROUP BY 1, 2, 3
      ORDER BY 1, 3
    `;
  }

  /**
   * Les cinq compteurs de no-show de la fenêtre — troisième critère de #74.
   *
   * Un seul balayage, cinq agrégats filtrés. `COUNT(*) FILTER (WHERE …)` est du
   * SQL standard depuis PostgreSQL 9.4 et fait ce que cinq requêtes `count`
   * auraient fait, en une passe et sur un **état cohérent** — cinq lectures
   * successives peuvent se contredire sous concurrence, et un taux calculé sur
   * deux instants différents n'est le taux de rien.
   *
   * La fenêtre porte sur `starts_at` : un no-show se rattache au jour où la
   * personne n'est pas venue.
   *
   * L'index `(tenant_id, status, starts_at)` ne sert pas ici — la requête ne
   * filtre pas sur le statut, elle le ventile ; c'est `(tenant_id, starts_at)`
   * qui borne la lecture à la fenêtre.
   *
   * Le taux **n'est pas calculé ici** : le dépôt rend des comptes, le service
   * décide de ce qu'on divise par quoi. Une division en SQL aurait enfoui la
   * question la plus discutable du ticket — quel dénominateur ? — dans un
   * fichier que personne ne relit pour cela.
   */
  public async noShowCounts(window: ReportWindow): Promise<NoShowCounts> {
    const tenantId = requireTenantId('Appointment', 'noShowCounts');

    const rows = await this.prisma.$queryRaw<NoShowSqlRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'NO_SHOW')::bigint AS "noShows",
        COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::bigint AS "honored",
        COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::bigint AS "cancelled",
        COUNT(*) FILTER (WHERE "status" IN ('PENDING', 'CONFIRMED'))::bigint AS "pending",
        COUNT(*)::bigint AS "total"
      FROM "appointments"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "starts_at" >= ${window.from.toISOString()}::timestamptz
        AND "starts_at" < ${window.to.toISOString()}::timestamptz
    `;

    // Une agrégation sans `GROUP BY` rend toujours exactement une ligne, y
    // compris sur un ensemble vide — les compteurs y valent zéro. Le repli
    // couvre le cas qu'aucune base ne produit mais que le type autorise.
    const row = rows[0];
    if (row === undefined) {
      return { noShows: 0, honored: 0, cancelled: 0, pending: 0, total: 0 };
    }

    return {
      noShows: toCount(row.noShows),
      honored: toCount(row.honored),
      cancelled: toCount(row.cancelled),
      pending: toCount(row.pending),
      total: toCount(row.total),
    };
  }
}

/** Une ligne SQL de revenu, dans le vocabulaire du domaine — net compris. */
function toRevenueRow(row: RevenueSqlRow): DailyRevenueRow {
  const grossAmountMinor = toCount(row.gross);
  const refundedAmountMinor = toCount(row.refunded);

  return {
    date: row.bucket,
    // `method` vient d'un `enum` PostgreSQL dont `PAYMENT_METHODS` est le
    // miroir : le transtypage est sûr, et `reporting.vocabulary.spec.ts` le
    // prouve en comparant les deux listes à l'énumération générée.
    method: row.method as PaymentMethod,
    currency: row.currency,
    transactions: toCount(row.transactions),
    grossAmountMinor,
    refundedAmountMinor,
    // Le net est **dérivé**, jamais stocké : le brut moins ce que le prestataire
    // a confirmé avoir rendu. Le calculer ici plutôt que sur l'écran évite deux
    // définitions du chiffre d'affaires.
    netAmountMinor: grossAmountMinor - refundedAmountMinor,
  };
}

/**
 * Replie les lignes `(groupe, statut)` en une ligne par groupe.
 *
 * PostgreSQL rend une ligne par couple ; un écran veut une ligne par groupe avec
 * ses cinq compteurs. La transposition se fait hors du SQL parce qu'un
 * `crosstab` aurait exigé l'extension `tablefunc`, et qu'une somme de
 * `CASE WHEN` aurait figé les cinq statuts dans le texte de trois requêtes.
 *
 * Ce n'est pas « l'agrégat en code applicatif » que le ticket écarte :
 * l'agrégation a bien eu lieu en base, et ce qui remonte est déjà réduit à cinq
 * lignes par groupe au plus.
 *
 * Les statuts absents valent **zéro** et non `undefined` : un écran qui affiche
 * une colonne « no-shows » doit y lire `0`, pas un trou. L'ordre des groupes est
 * celui du `ORDER BY`, préservé par `Map`.
 */
export function foldVolumeRows(rows: readonly VolumeSqlRow[]): readonly AppointmentVolumeRow[] {
  const groups = new Map<string, { label: string | null; byStatus: Record<string, number> }>();

  for (const row of rows) {
    let group = groups.get(row.bucket);
    if (group === undefined) {
      group = { label: row.label, byStatus: emptyStatusCounts() };
      groups.set(row.bucket, group);
    }

    // Un statut inconnu de la liste locale serait ignoré plutôt qu'ajouté :
    // `byStatus` doit garder exactement les cinq clés que le contrat annonce.
    // `reporting.vocabulary.spec.ts` interdit que ce cas existe.
    if (row.status in group.byStatus) {
      group.byStatus[row.status] = toCount(row.appointments);
    }
  }

  return [...groups].map(([key, group]) => ({
    key,
    label: group.label,
    total: Object.values(group.byStatus).reduce((sum, count) => sum + count, 0),
    byStatus: group.byStatus as Record<AppointmentStatus, number>,
  }));
}

/** Les cinq compteurs à zéro — le socle de tout groupe. */
function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(APPOINTMENT_STATUSES.map((status) => [status, 0]));
}
