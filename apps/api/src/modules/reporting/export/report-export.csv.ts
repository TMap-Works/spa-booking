import { REPORT_EXPORT_FALLBACK_LOCALE, type Locale } from '@spa/shared';

import { netOf } from '../../payments/pos.totals';
import type {
  AppointmentVolumeReport,
  DailyRevenueReport,
  NoShowReport,
  ReportWindow,
} from '../reporting.types';
import { reportExportVocabulary, type ReportExportVocabulary } from './report-export.vocabulary';

/**
 * Sérialisation CSV des trois rapports — le fichier que l'export dépose dans le
 * bucket (#563, sixième critère de #75).
 *
 * Fonction **pure**, sans dépendance Nest, sans horloge et sans entrée-sortie :
 * elle prend trois rapports déjà agrégés et rend une chaîne. C'est ce qui permet
 * de l'exercer ligne à ligne en test unitaire, et ce qui fait que la seule chose
 * à instruire quand un chiffre du fichier est faux est le rapport qui l'a
 * produit, jamais l'écriture du fichier.
 *
 * ## Ce qui change par rapport à l'export du navigateur, et pourquoi
 *
 * #75 fabriquait le fichier dans le navigateur, à partir des chiffres que la
 * page venait de peindre — la seule façon, alors, d'être certain que le fichier
 * corresponde à l'écran. Cette garantie-là est **perdue** ici, et il faut le
 * dire : l'export relit les trois rapports côté serveur, et une caisse
 * encaissée entre l'affichage et le clic apparaîtra dans le fichier sans être à
 * l'écran.
 *
 * L'échange est assumé, et il est exigé par le cinquième critère de #75 : une
 * URL présignée suppose un objet déposé par un porteur d'identifiants AWS,
 * c'est-à-dire un fichier produit **par le serveur**. Ce que l'on gagne en
 * retour n'est pas mince — le fichier n'est plus limité à ce qu'un écran a bien
 * voulu peindre, il porte le détail complet des trois rapports, et il est
 * reproductible : deux exports de la même fenêtre disent la même chose, ce qui
 * n'était pas vrai d'un fichier dépendant de l'état de l'onglet.
 *
 * ## La forme longue, reprise telle quelle
 *
 * Une seule table `section;cle;libelle;mesure;valeur;devise`, comme la
 * construction côté navigateur l'avait retenue avant #563. Les trois rapports
 * n'ont pas les mêmes colonnes — des montants par jour et par moyen de paiement,
 * des comptes par statut, un taux —, et un tableau large aurait été aux trois
 * quarts vide. La forme longue se relit dans un tableur comme dans un tableau
 * croisé dynamique, et surtout elle ne change pas de colonnes selon la période :
 * un fichier de septembre et un fichier d'octobre s'empilent.
 *
 * ## L'argent reste entier
 *
 * Tous les montants sortent en **plus petite unité monétaire**, en entiers, avec
 * leur code devise dans la colonne prévue (CLAUDE.md, « Argent : jamais de
 * `float` »). Le nom des mesures le dit — `brut_minor`, `rembourse_minor`,
 * `net_minor`. Convertir en unité principale pour faire joli dans le tableur
 * aurait introduit exactement le flottant que la règle interdit, et un centime
 * perdu sur un cumul d'année ne se retrouve plus.
 *
 * Le **taux** de no-show est la seule valeur non entière du fichier, et c'en est
 * une par nature : c'est un ratio, pas un montant. Il sort sans devise, avec les
 * quatre décimales que le service lui a déjà données.
 *
 * ## Le hors-taxes se **retire** du brut, il ne se recalcule pas (#891)
 *
 * `brut_minor` est un montant **TTC** : c'est la somme de `payments.amount_minor`,
 * c'est-à-dire des prix affichés, et un prix affiché au consommateur s'entend
 * toutes taxes comprises (#816). La mesure `ht_minor` en est la part hors taxes,
 * obtenue par `netOf` — la fonction de `payments/pos.totals.ts`, **importée et
 * non recopiée**.
 *
 * C'est le deuxième critère de #891, et il ne relève pas du goût : #816 vient de
 * corriger une divergence née d'une seconde règle d'arrondi vivant dans un second
 * module, où un soin à 65,00 € valait 54,17 € d'un côté et 54,16 € de l'autre.
 * Réécrire ici `arrondi(ttc × 10 000 / (10 000 + taux))` aurait rouvert cette
 * divergence exactement là où elle se voit le moins — dans un fichier qu'une
 * gérante recoupe avec ses tickets de caisse.
 *
 * L'import traverse la frontière de module, et c'est assumé : `pos.totals.ts` ne
 * porte ni Nest, ni Prisma, ni HTTP — c'est un calcul pur, du même ordre
 * qu'`appointments/appointment-status.ts` que `crm` importe déjà. La règle
 * d'api-module §3 interdit d'importer le **repository** d'un autre module, ce
 * qui n'est pas le cas ici : aucune lecture, aucune décision de cycle de vie,
 * une fonction d'arithmétique entière.
 *
 * Le **taux** n'est pas une constante de ce fichier : il arrive dans
 * {@link ReportExportContent}, relu en base par `ReportingRepository` pour
 * l'établissement dont on exporte les lignes (troisième critère de #891). Un
 * salon à taux nul voit donc `ht_minor` valoir exactement `brut_minor`, ce que
 * `netOf` rend par son court-circuit — quatrième critère.
 *
 * Ce que `ht_minor` n'est **pas** : `net_minor`. Le second est le brut moins les
 * remboursements — une notion de caisse, pas de fiscalité —, et « net » se lit
 * volontiers « net de taxe » dans un tableur. D'où `ht_minor`, qui ne se lit que
 * d'une façon, plutôt qu'un second « net » qu'il aurait fallu qualifier. Les
 * deux mesures se rangent côte à côte sur la même clé, et ne se somment pas
 * entre elles.
 *
 * ### Ce que `ht_minor` approxime, et qu'il faut savoir avant de le déclarer
 *
 * C'est une **ventilation indicative du chiffre d'affaires encaissé**, pas une
 * base déclarative de TVA. Deux écarts sont connus, relevés en revue de #891 et
 * ouverts en suivi — #938 et #939 :
 *
 * 1. **le pourboire est compté comme taxable** (#938). `payments.amount_minor` vaut
 *    `sales.total_amount_minor`, c'est-à-dire `sous-total + taxe + pourboire`
 *    (`settlement.rules.ts`). Or un pourboire n'est pas taxé — `composeSale` le
 *    laisse hors de toute extraction. Sur un soin à 65,00 € avec 10,00 € de
 *    pourboire à 20 %, `ht_minor` rend 6 250 là où la base réelle vaut 6 417.
 *    L'écart croît avec le volume de pourboires, et il est nul sans eux ;
 * 2. **le taux est celui d'aujourd'hui, pas celui de la période** (#939). `sales`
 *    **fige** son taux (`sales.tax_rate_bps`) ; l'export, lui, relit celui de
 *    l'établissement au moment où on l'exporte, comme le troisième critère de
 *    #891 le demande. Un salon qui change de taux verra donc son historique
 *    reventilé au nouveau taux.
 *
 * Les deux se corrigent du même geste — ventiler par vente, depuis le
 * `sales.subtotal_amount_minor` déjà figé, réparti sur les règlements de la
 * vente —, et ce geste sort des critères de #891 autant que de son empreinte :
 * il change l'agrégat SQL, la forme de `DailyRevenueRow`, et demande une règle
 * de répartition pour une vente réglée en deux fois. C'est une décision de
 * conception, pas une correction de revue.
 *
 * ## La langue décide des mots et des signes — #851
 *
 * Jusqu'à ce ticket, le fichier était français en dur : en-tête `section;cle;…`,
 * libellés en français, point-virgule de colonnes. Il suit désormais la langue
 * de l'interface **au moment de l'export**, transmise dans la demande et validée
 * par `reportExportLocaleSchema` du contrat partagé.
 *
 * Ce que cela change, et ce que cela ne change pas, est décrit une fois pour
 * toutes dans `report-export.vocabulary.ts` : la ligne d'en-tête et la colonne
 * `libelle` se traduisent, les colonnes `section` et `mesure` restent des
 * **identifiants** stables — c'est ce qui permet à deux exports de langues
 * différentes de s'empiler dans le même tableau croisé.
 *
 * Le séparateur de colonnes en dépend aussi, et il ne va jamais seul : `;` avec
 * la virgule décimale en français, `,` avec le point décimal en anglais. RFC 4180
 * ne normalise que la virgule, mais un CSV à virgules atterrit en une seule
 * colonne dans un tableur français, où la virgule est le séparateur décimal.
 * L'échappement, lui, reste celui de la RFC dans les deux cas : guillemets
 * doublés, champ encadré dès qu'il contient **le séparateur en vigueur**, un
 * guillemet ou un saut de ligne.
 *
 * Les montants, eux, ne changent pas d'un iota : entiers, en plus petite unité
 * monétaire, quelle que soit la langue. Le seul nombre fractionnaire du fichier
 * est le taux de no-show, et c'est le seul que le séparateur décimal concerne.
 */

/** Fin de ligne, telle que RFC 4180 la définit. */
const LINE_BREAK = '\r\n';

/**
 * Marque d'ordre d'octets UTF-8 — ce qui fait ouvrir les accents correctement.
 *
 * Écrite par son échappement Unicode plutôt que collée telle quelle : un
 * caractère invisible en tête d'une chaîne est exactement le genre de chose
 * qu'un formateur déplace et qu'une relecture ne voit pas — et que la règle
 * `no-irregular-whitespace` refuse, à juste titre.
 */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * L'en-tête, écrit une fois. Toute ligne du fichier a ces six colonnes.
 *
 * Rendu par langue depuis #851 — voir `report-export.vocabulary.ts`. Les six
 * colonnes, elles, sont les mêmes dans les deux langues : c'est leur **nom** qui
 * se traduit, pas leur nombre ni leur ordre.
 */
export function reportExportCsvHeader(locale: Locale): readonly string[] {
  return reportExportVocabulary(locale).header;
}

/** Les rapports d'une même fenêtre, tels que l'export les sérialise. */
export interface ReportExportContent {
  readonly window: ReportWindow;
  readonly timeZone: string;
  /**
   * La langue de l'interface au moment de l'export — #851, troisième critère.
   *
   * Facultative, et le repli est celui du contrat partagé
   * (`REPORT_EXPORT_FALLBACK_LOCALE`, le français) : c'est ce que le fichier
   * contenait avant ce ticket, donc ce qu'un appelant qui ne demande rien doit
   * continuer de recevoir.
   *
   * Elle ne touche **ni** aux chiffres **ni** au fuseau : le fuseau de découpage
   * des journées reste celui de l'établissement, et un export anglais d'un salon
   * de Papeete compte les mêmes journées que son jumeau français.
   */
  readonly locale?: Locale;
  /**
   * Le taux de taxe de l'établissement exporté, en points de base — `2000` vaut
   * 20 % (#891, troisième critère).
   *
   * Il vient de `tenants.tax_rate_bps`, relu en base par `ReportExportService` ;
   * ce fichier ne le connaît que comme une donnée d'entrée, et n'en porte
   * aucune valeur par défaut. Un paramètre optionnel aurait été une constante
   * déguisée : le jour où le service oublierait de le passer, le fichier
   * annoncerait un hors-taxes faux sans que rien ne rougisse.
   */
  readonly taxRateBps: number;
  readonly revenue: DailyRevenueReport;
  /**
   * Le volume, sur **tous** les axes demandés — `day`, `staff`, `service`.
   *
   * Une liste et non un rapport unique : chaque axe devient sa propre section
   * (`volume_day`, `volume_staff`, `volume_service`), ce qui rend le fichier
   * indépendant du filtre affiché. L'ordre de la liste est celui des sections.
   */
  readonly volumes: readonly AppointmentVolumeReport[];
  readonly noShows: NoShowReport;
}

/** Une ligne du fichier, avant échappement. */
interface CsvRow {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly measure: string;
  readonly value: string;
  readonly currency: string;
}

/**
 * Le fichier complet, prêt à être déposé.
 *
 * L'ordre des sections est celui de la lecture : le contexte d'abord — la
 * période et le fuseau, sans quoi aucun chiffre du fichier ne se rattache à
 * quoi que ce soit —, puis le revenu, puis le volume sur chacun de ses axes,
 * puis les no-shows.
 */
export function buildReportExportCsv(content: ReportExportContent): string {
  const words = reportExportVocabulary(content.locale ?? REPORT_EXPORT_FALLBACK_LOCALE);
  const rows: CsvRow[] = [
    ...periodRows(content, words),
    ...revenueRows(content.revenue, content.taxRateBps),
    ...content.volumes.flatMap((volume) => volumeRows(volume, words)),
    ...noShowRows(content.noShows, words),
  ];

  return (
    BYTE_ORDER_MARK +
    [
      words.header.map((column) => escapeField(column, words)).join(words.columnSeparator),
      ...rows.map((line) => toCsvLine(line, words)),
    ].join(LINE_BREAK) +
    LINE_BREAK
  );
}

/**
 * La période et le fuseau dans lequel elle a été découpée.
 *
 * Le fuseau n'est pas décoratif : « le 3 mars » à Papeete et à Paris ne
 * couvrent pas les mêmes instants, et un fichier qui tairait le sien ne serait
 * pas rejouable. Les deux bornes sortent en ISO 8601 UTC, telles que l'API les
 * a reçues — la borne haute reste **exclue**, comme partout dans ce module.
 */
function periodRows(content: ReportExportContent, words: ReportExportVocabulary): CsvRow[] {
  return [
    row('periode', '', words.labels.windowStart, 'debut_utc', content.window.from.toISOString()),
    row('periode', '', words.labels.windowEnd, 'fin_utc', content.window.to.toISOString()),
    row('periode', '', words.labels.timeZone, 'fuseau', content.timeZone),
  ];
}

/**
 * Le revenu : une ligne par mesure, par jour de caisse puis en cumul.
 *
 * Les jours sans recette sont absents, comme du rapport lui-même : un fichier ne
 * fabrique pas les jours où le salon était fermé.
 *
 * `ht_minor` suit immédiatement `brut_minor` — « à côté du brut », premier
 * critère de #891 —, aussi bien par jour et par moyen de paiement que sur le
 * cumul. L'extraction porte sur le **brut** et non sur le net : c'est le prix
 * affiché qui porte la taxe, un remboursement n'est pas une base taxable de
 * moins mais une vente défaite.
 *
 * Le cumul est extrait de **son propre brut**, et non reconstitué en sommant les
 * `ht_minor` des jours. Les deux peuvent différer d'un centime — chaque
 * extraction s'arrondit —, et c'est la première forme qui est juste : le total
 * hors taxes d'une période est la part hors taxes de son total, comme un ticket
 * extrait sa taxe de son sous-total et non ligne à ligne (`pos.totals.ts`).
 * Sommer la colonne des jours dans un tableur peut donc rendre un centime d'écart
 * avec la ligne de cumul ; c'est la même propriété que celle de n'importe quel
 * relevé de TVA, et l'inverse — un total faux pour que la colonne s'additionne —
 * serait le vrai défaut.
 */
function revenueRows(revenue: DailyRevenueReport, taxRateBps: number): CsvRow[] {
  const rows: CsvRow[] = [];

  for (const day of revenue.days) {
    const label = `${day.date} · ${day.method}`;

    rows.push(
      row('revenu_jour', day.date, label, 'encaissements', String(day.transactions)),
      money('revenu_jour', day.date, label, 'brut_minor', day.grossAmountMinor, day.currency),
      money(
        'revenu_jour',
        day.date,
        label,
        'ht_minor',
        netOf(day.grossAmountMinor, taxRateBps),
        day.currency,
      ),
      money('revenu_jour', day.date, label, 'rembourse_minor', day.refundedAmountMinor, day.currency),
      money('revenu_jour', day.date, label, 'net_minor', day.netAmountMinor, day.currency),
    );
  }

  for (const total of revenue.totals) {
    const key = `${total.method}-${total.currency}`;

    rows.push(
      row('revenu_total', key, total.method, 'encaissements', String(total.transactions)),
      money('revenu_total', key, total.method, 'brut_minor', total.grossAmountMinor, total.currency),
      money(
        'revenu_total',
        key,
        total.method,
        'ht_minor',
        netOf(total.grossAmountMinor, taxRateBps),
        total.currency,
      ),
      money(
        'revenu_total',
        key,
        total.method,
        'rembourse_minor',
        total.refundedAmountMinor,
        total.currency,
      ),
      money('revenu_total', key, total.method, 'net_minor', total.netAmountMinor, total.currency),
    );
  }

  return rows;
}

/**
 * Le volume de rendez-vous d'**un** axe, ventilé par statut, puis son total.
 *
 * `label` vaut `null` sur l'axe `day`, où la clé se lit d'elle-même : la colonne
 * reprend alors la clé plutôt que de laisser un trou, pour qu'un tri par libellé
 * dans le tableur ne rassemble pas toutes les journées sous une case vide.
 *
 * Le total est rangé **dans la section de son axe**, à clé vide, et non dans une
 * section commune : les trois axes comptent les mêmes rendez-vous, et une
 * section `volume_total` répétée trois fois avec le même nombre se lirait comme
 * trois totaux différents qui se contredisent. Ici, chaque section porte le sien,
 * et il vaut bien la somme de ses lignes.
 */
function volumeRows(
  volume: AppointmentVolumeReport,
  words: ReportExportVocabulary,
): CsvRow[] {
  const rows: CsvRow[] = [];
  const section = `volume_${volume.groupBy}`;

  for (const group of volume.rows) {
    const label = group.label ?? group.key;

    rows.push(row(section, group.key, label, 'rendez_vous', String(group.total)));

    for (const [status, count] of Object.entries(group.byStatus)) {
      rows.push(row(section, group.key, label, `statut_${status.toLowerCase()}`, String(count)));
    }
  }

  rows.push(row(section, '', words.labels.allGroups, 'rendez_vous', String(volume.total)));

  return rows;
}

/**
 * Les no-shows : les cinq comptes, puis le taux.
 *
 * Le taux vaut `null` quand aucun rendez-vous n'était à honorer, et le fichier
 * écrit alors une **cellule vide** plutôt qu'un `0`. « Rien à honorer » n'est pas
 * « aucun no-show », et un `0` dans un tableur se moyenne, se somme et finit par
 * ressembler à une performance.
 *
 * C'est la **seule valeur fractionnaire du fichier**, donc la seule que le
 * séparateur décimal de la langue concerne — « 0,3333 » en français, « 0.3333 »
 * en anglais (#851). Les montants, eux, restent des entiers en plus petite unité
 * monétaire et n'ont pas de décimale à séparer.
 */
function noShowRows(noShows: NoShowReport, words: ReportExportVocabulary): CsvRow[] {
  return [
    row('no_shows', '', words.labels.honored, 'honores', String(noShows.honored)),
    row('no_shows', '', words.labels.noShows, 'no_shows', String(noShows.noShows)),
    row('no_shows', '', words.labels.cancelled, 'annules', String(noShows.cancelled)),
    row('no_shows', '', words.labels.pending, 'a_venir', String(noShows.pending)),
    row('no_shows', '', words.labels.allStatuses, 'total', String(noShows.total)),
    row(
      'no_shows',
      '',
      words.labels.rate,
      'taux',
      noShows.rate === null ? '' : decimal(noShows.rate, words),
    ),
  ];
}

/**
 * Un nombre fractionnaire écrit avec le séparateur décimal de la langue.
 *
 * `String(value).replace('.', …)` plutôt qu'`Intl.NumberFormat` : le formateur
 * poserait aussi des séparateurs de **milliers** — une espace insécable en
 * français — et arrondirait à trois décimales par défaut, là où le taux en porte
 * quatre que le service a déjà calculées. Un tableur relit « 0,3333 » ; il ne
 * relit pas « 0,333 » sans perdre ce que la colonne annonce.
 */
function decimal(value: number, words: ReportExportVocabulary): string {
  return String(value).replace('.', words.decimalSeparator);
}

/** Une ligne sans devise — un compte, une date, un libellé. */
function row(section: string, key: string, label: string, measure: string, value: string): CsvRow {
  return { section, key, label, measure, value, currency: '' };
}

/**
 * Une ligne de montant : la valeur **entière** en plus petite unité monétaire,
 * et son code devise dans la colonne prévue.
 *
 * Les deux sont indissociables — un montant sans sa devise ne veut rien dire, et
 * sommer des minor units de devises différentes produit un nombre qui ne veut
 * rien dire non plus.
 */
function money(
  section: string,
  key: string,
  label: string,
  measure: string,
  amountMinor: number,
  currency: string,
): CsvRow {
  return { section, key, label, measure, value: String(amountMinor), currency };
}

/** Les six champs d'une ligne, échappés et joints. */
function toCsvLine(line: CsvRow, words: ReportExportVocabulary): string {
  return [line.section, line.key, line.label, line.measure, line.value, line.currency]
    .map((field) => escapeField(field, words))
    .join(words.columnSeparator);
}

/**
 * L'échappement de RFC 4180 : guillemets doublés, champ encadré dès qu'il
 * contient un séparateur, un guillemet ou un saut de ligne.
 *
 * Le nom d'une prestation ou d'un praticien passe par ici — « Massage 60 min ;
 * dos » ou un patronyme à apostrophe typographique sont des valeurs légitimes, et
 * c'est le seul endroit du fichier où une donnée saisie par un humain entre.
 *
 * Le séparateur qui déclenche l'encadrement est **celui de la langue** (#851) :
 * une prestation nommée « Forfait duo, 90 min » couperait une ligne anglaise en
 * deux sans cela, alors qu'elle ne gênait pas le fichier français. Une comparaison
 * de caractère plutôt qu'une expression régulière construite à la volée — le
 * séparateur viendrait d'une table, mais une `RegExp` recomposée à chaque champ
 * est un coût inutile sur un fichier qui compte des milliers de lignes, et il
 * aurait fallu en échapper les métacaractères.
 */
function escapeField(value: string, words: ReportExportVocabulary): string {
  if (!/["\r\n]/.test(value) && !value.includes(words.columnSeparator)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}
