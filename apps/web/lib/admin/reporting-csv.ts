/**
 * L'export CSV de l'écran de reporting — quatrième critère de #75.
 *
 * ## Ce qui est exporté : **ce qui est affiché**, et rien d'autre
 *
 * Le critère dit « export CSV des données affichées ». Le fichier est donc
 * construit à partir du même modèle de vue que l'écran — même période, même
 * filtre, mêmes chiffres — et non d'une seconde requête qui pourrait, sous
 * concurrence, ne pas rendre la même chose que ce que la gérante a sous les
 * yeux au moment où elle clique.
 *
 * ## Une forme longue, et pourquoi pas un tableau large
 *
 * Une seule table `section;cle;libelle;mesure;valeur;devise` plutôt qu'une
 * colonne par mesure. L'écran montre trois choses de natures différentes — des
 * montants par jour et par moyen de paiement, des comptes par statut, un taux —
 * et un tableau large aurait été aux trois quarts vide, avec des colonnes de
 * revenu sur les lignes de volume. La forme longue se relit dans un tableur
 * comme dans un tableau croisé dynamique, et surtout elle ne change pas de
 * colonnes selon le filtre : un fichier de septembre et un fichier d'octobre
 * s'empilent.
 *
 * ## L'argent reste entier
 *
 * Tous les montants sont exportés en **plus petite unité monétaire**, entiers,
 * avec leur code devise dans la colonne prévue (CLAUDE.md, « Argent : jamais de
 * float »). Convertir en unité principale pour « faire joli » dans le tableur
 * aurait introduit exactement le flottant que la règle interdit, et un centime
 * perdu sur un cumul d'année est une erreur qu'on ne retrouve plus. Le nom des
 * mesures le dit : `brut_minor`, `rembourse_minor`, `net_minor`.
 *
 * ## Le point-virgule, et l'assumer
 *
 * RFC 4180 ne normalise que la virgule. Mais ce fichier s'ouvre dans le tableur
 * d'une gérante en locale française, où la virgule est le séparateur décimal et
 * où un CSV à virgules atterrit en une seule colonne. Le point-virgule est le
 * séparateur que cette locale attend, et l'échappement reste celui de la RFC :
 * guillemets doublés, champ encadré dès qu'il contient un séparateur, un
 * guillemet ou un saut de ligne. La marque d'ordre d'octets UTF-8 est ajoutée
 * pour la même raison — sans elle, « Prestations bien-être » s'ouvre en
 * « PrestationsÂ bien-Ãªtre ».
 */

import type { PaymentMethod } from '@spa/shared';

import { PAYMENT_METHOD_LABELS } from './reporting-contract';
import type { ReportRange } from './reporting-window';
import type {
  DailyRevenuePoint,
  NoShowIndicator,
  ReportScope,
  RevenueIndicator,
  RevenueSeries,
  VolumePoint,
} from './reporting-view';

/** Le séparateur de colonnes — voir l'en-tête du module. */
const SEPARATOR = ';';

/** Fin de ligne CSV, telle que RFC 4180 la définit. */
const LINE_BREAK = '\r\n';

/** Marque d'ordre d'octets UTF-8 — ce qui fait ouvrir les accents correctement. */
const BYTE_ORDER_MARK = '﻿';

/** L'en-tête, écrit une fois. Toute ligne du fichier a ces six colonnes. */
export const REPORT_CSV_HEADER = ['section', 'cle', 'libelle', 'mesure', 'valeur', 'devise'];

/** Ce qu'il faut pour écrire le fichier — exactement ce que l'écran affiche. */
export interface ReportCsvInput {
  readonly range: ReportRange;
  readonly timeZone: string;
  readonly scope: ReportScope;
  readonly revenueTotals: readonly RevenueIndicator[];
  readonly revenueSeries: readonly RevenueSeries[];
  readonly revenueByMethod: readonly {
    readonly method: PaymentMethod;
    readonly currency: string;
    readonly transactions: number;
    readonly grossAmountMinor: number;
    readonly refundedAmountMinor: number;
    readonly netAmountMinor: number;
  }[];
  readonly volumeAxis: 'jour' | 'praticien' | 'prestation';
  readonly volume: readonly VolumePoint[];
  readonly appointments: number;
  readonly noShows: NoShowIndicator;
}

/**
 * Le nom du fichier téléchargé — **préfixé par le tenant** (#75, cinquième
 * critère, pour la part qui se tient côté web).
 *
 * Le préfixe n'est pas décoratif : deux gérantes de deux salons qui exportent la
 * même période depuis le même poste retrouvent deux fichiers distincts dans leur
 * dossier de téléchargements, et un fichier ouvert six mois plus tard dit de
 * quel établissement il parle. La période est dans le nom pour la même raison.
 *
 * Le slug est assaini avant d'être employé : il vient de l'URL, et un nom de
 * fichier n'est pas un chemin. Tout ce qui n'est pas alphanumérique ou tiret est
 * remplacé, de sorte qu'aucun `../` ni aucun séparateur ne puisse s'y glisser.
 */
export function reportCsvFilename(tenantSlug: string, range: ReportRange): string {
  const safeSlug = tenantSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const prefix = safeSlug === '' ? 'etablissement' : safeSlug;

  return `${prefix}-reporting-${range.from}_${range.to}.csv`;
}

/** Le fichier entier, marque d'ordre d'octets comprise. */
export function buildReportCsv(input: ReportCsvInput): string {
  const rows: string[][] = [REPORT_CSV_HEADER, ...reportCsvRows(input)];

  return BYTE_ORDER_MARK + rows.map(formatRow).join(LINE_BREAK) + LINE_BREAK;
}

/**
 * Les lignes de données, dans l'ordre où l'écran les montre.
 *
 * Exportée à part de `buildReportCsv` pour être vérifiable ligne à ligne par les
 * tests, sans avoir à découper une chaîne échappée.
 */
export function reportCsvRows(input: ReportCsvInput): string[][] {
  return [
    ['periode', '', '', 'du', input.range.from, ''],
    ['periode', '', '', 'au', input.range.to, ''],
    ['periode', '', '', 'fuseau', input.timeZone, ''],
    ['filtre', input.scope.key ?? '', input.scope.label, 'type', input.scope.kind, ''],
    ...revenueTotalRows(input.revenueTotals),
    ...revenueMethodRows(input.revenueByMethod),
    ...revenueDayRows(input.revenueSeries),
    ...volumeRows(input.volumeAxis, input.volume),
    ...activityRows(input.appointments, input.noShows),
  ];
}

function revenueTotalRows(totals: readonly RevenueIndicator[]): string[][] {
  return totals.flatMap((total) => [
    ['revenu-total', '', '', 'transactions', String(total.transactions), total.currency],
    ['revenu-total', '', '', 'brut_minor', String(total.grossAmountMinor), total.currency],
    ['revenu-total', '', '', 'rembourse_minor', String(total.refundedAmountMinor), total.currency],
    ['revenu-total', '', '', 'net_minor', String(total.netAmountMinor), total.currency],
  ]);
}

function revenueMethodRows(methods: ReportCsvInput['revenueByMethod']): string[][] {
  return methods.flatMap((row) => {
    const label = PAYMENT_METHOD_LABELS[row.method];

    return [
      ['revenu-moyen', row.method, label, 'transactions', String(row.transactions), row.currency],
      ['revenu-moyen', row.method, label, 'brut_minor', String(row.grossAmountMinor), row.currency],
      [
        'revenu-moyen',
        row.method,
        label,
        'rembourse_minor',
        String(row.refundedAmountMinor),
        row.currency,
      ],
      ['revenu-moyen', row.method, label, 'net_minor', String(row.netAmountMinor), row.currency],
    ];
  });
}

function revenueDayRows(series: readonly RevenueSeries[]): string[][] {
  return series.flatMap((currencySeries) =>
    currencySeries.days.flatMap((day: DailyRevenuePoint) => [
      ['revenu-jour', day.date, '', 'transactions', String(day.transactions), currencySeries.currency],
      ['revenu-jour', day.date, '', 'brut_minor', String(day.grossAmountMinor), currencySeries.currency],
      [
        'revenu-jour',
        day.date,
        '',
        'rembourse_minor',
        String(day.refundedAmountMinor),
        currencySeries.currency,
      ],
      ['revenu-jour', day.date, '', 'net_minor', String(day.netAmountMinor), currencySeries.currency],
    ]),
  );
}

function volumeRows(axis: ReportCsvInput['volumeAxis'], points: readonly VolumePoint[]): string[][] {
  return points.flatMap((point) => [
    [`volume-${axis}`, point.key, point.label, 'rendez_vous', String(point.total), ''],
    [`volume-${axis}`, point.key, point.label, 'no_shows', String(point.noShows), ''],
  ]);
}

/**
 * Les indicateurs du périmètre retenu.
 *
 * `taux_no_show` est vide — et non `0` — quand aucun rendez-vous n'était à
 * honorer : la distinction que porte l'écran doit survivre à l'export, sans quoi
 * une période sans activité ressemblerait, dans le tableur, à une période
 * parfaite.
 */
function activityRows(appointments: number, noShows: NoShowIndicator): string[][] {
  return [
    ['indicateurs', '', '', 'rendez_vous', String(appointments), ''],
    ['indicateurs', '', '', 'honores', String(noShows.honored), ''],
    ['indicateurs', '', '', 'no_shows', String(noShows.noShows), ''],
    ['indicateurs', '', '', 'annules', String(noShows.cancelled), ''],
    ['indicateurs', '', '', 'a_venir', String(noShows.pending), ''],
    ['indicateurs', '', '', 'taux_no_show', noShows.rate === null ? '' : String(noShows.rate), ''],
  ];
}

/** Une ligne, séparateurs et échappements posés. */
function formatRow(cells: readonly string[]): string {
  return cells.map(escapeCell).join(SEPARATOR);
}

/**
 * Un champ, échappé selon RFC 4180.
 *
 * Le guillemet ouvrant n'est posé que s'il le faut — un fichier entièrement
 * guillemeté se relit très bien mais devient illisible à l'œil dans un éditeur
 * de texte, ce qui est précisément l'usage qu'on fait d'un export quand il
 * surprend.
 */
function escapeCell(value: string): string {
  const neutralized = neutralizeFormula(value);

  return /["\r\n;]/.test(neutralized)
    ? `"${neutralized.replace(/"/g, '""')}"`
    : neutralized;
}

/**
 * Ce qui empêche un tableur de prendre un libellé pour une formule.
 *
 * Les libellés de ce fichier — nom d'un praticien, d'une prestation — viennent
 * du catalogue du salon, donc d'une saisie. Une prestation nommée
 * `=HYPERLINK("http://…";"Facture")` ou `@SUM(…)` est exécutée à l'ouverture par
 * Excel comme par LibreOffice : c'est l'injection de formule CSV, et elle
 * n'exige aucun accès au poste, seulement que la gérante ouvre son export.
 *
 * L'apostrophe de tête est la neutralisation que les deux tableurs
 * reconnaissent : la cellule affiche son texte et ne calcule rien.
 *
 * Les cellules **numériques** en sont exemptées : un montant net négatif s'écrit
 * `-1200`, et le préfixer en ferait du texte — l'export cesserait de se sommer
 * dans le tableur, ce qui est tout ce qu'on lui demande.
 */
function neutralizeFormula(value: string): string {
  if (/^-?\d+(?:[.,]\d+)?$/.test(value)) {
    return value;
  }

  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
