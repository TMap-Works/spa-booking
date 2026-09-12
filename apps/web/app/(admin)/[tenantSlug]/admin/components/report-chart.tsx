import type { ReactElement } from 'react';

/**
 * Le graphique du tableau de bord — troisième critère de #75, « graphiques
 * lisibles en thème clair et sombre ».
 *
 * ## Server Component, et sans bibliothèque
 *
 * Un graphique de barres est de la géométrie : des rectangles et des étiquettes.
 * Rien ici n'a d'état, n'écoute un événement ni ne touche une API du navigateur,
 * donc rien ne justifie `"use client"` (web-frontend §1) — ni les quelque cent
 * kilo-octets qu'aurait coûté une bibliothèque de graphiques sur un écran qu'on
 * ouvre en fin de mois. Le SVG est calculé au rendu serveur et arrive peint.
 *
 * ## Lisible dans les deux thèmes, par construction
 *
 * Aucune couleur n'est écrite ici : les remplissages passent par des jetons
 * sémantiques `--spa-color-chart-*`, dont `styles/tokens.css` donne une valeur
 * claire et une valeur sombre. Le graphique ne sait pas dans quel thème il est
 * peint — c'est la cascade qui le sait, et c'est `tests/contrast.test.mjs` qui
 * vérifie que les deux jeux tiennent le seuil de 3:1 des éléments non textuels
 * (WCAG 1.4.11).
 *
 * ## La couleur ne porte jamais l'information (WCAG 1.4.1)
 *
 * Trois redondances, et chacune sert un lecteur différent :
 *
 * 1. la série secondaire — les no-shows dans le volume — est **hachurée** en
 *    plus d'être d'une autre teinte : un daltonisme deutan ne distingue pas deux
 *    aplats voisins, une hachure se voit toujours ;
 * 2. la barre mise en avant par un filtre porte un **liseré**, en plus de sa
 *    teinte ;
 * 3. le tableau en lecture d'écran donne **tous** les chiffres, dans l'ordre des
 *    barres. C'est la seule forme du graphique qu'un lecteur non voyant reçoit,
 *    et c'est pour cela qu'il porte les valeurs et non un résumé.
 *
 * ## Ce qui déborde se défile, au clavier comme à la souris
 *
 * Sur une carte plus étroite que le plancher de lisibilité du tracé, le canevas
 * défile horizontalement (`styles/admin/reporting.css`). Un conteneur de
 * défilement dont aucun descendant n'est atteignable au clavier n'est
 * manœuvrable qu'à la souris — la fin de la période resterait hors d'atteinte
 * pour qui n'en a pas (#616, WCAG 2.1.1). Le SVG porte donc `tabindex="0"` :
 * c'est lui qu'on atteint par tabulation, et les flèches défilent alors son
 * conteneur. Le tabulateur y trouve un arrêt nommé — `role="img"` et son
 * `<title>` — et l'anneau de focus global de `base.css` le montre.
 *
 * Et ce qui est masqué ne déborde pas non plus : le tableau de lecture d'écran
 * est enveloppé dans une `<div class="spa-visually-hidden">` plutôt que de
 * porter la classe lui-même — une table ne descend pas sous la largeur de son
 * contenu, et celle-ci élargissait la page à 690 px sur un écran de 360 px.
 */

/** Une barre : sa valeur, son étiquette, et ce qu'elle contient d'anormal. */
export interface ReportChartBar {
  readonly key: string;
  /** L'étiquette d'axe — une date courte, un nom de praticien. */
  readonly label: string;
  /** La hauteur de la barre. Jamais négative : un rapport ne rend pas de reprise. */
  readonly value: number;
  /** La valeur, mise en forme — « 240,00 € », « 18 rendez-vous ». */
  readonly valueLabel: string;
  /** Part de `value` mise en évidence — les no-shows d'une journée. */
  readonly inner?: number;
  /** La part, mise en forme. */
  readonly innerLabel?: string;
  /** `true` sur la valeur que le filtre désigne. */
  readonly highlighted?: boolean;
}

interface ReportChartProps {
  readonly title: string;
  /** Ce que le graphique montre, en une phrase — le `<desc>` du SVG. */
  readonly summary: string;
  /**
   * `colonnes` pour un axe temporel — les journées se lisent de gauche à
   * droite ; `barres` pour un axe nominal, où les noms ont besoin de place et où
   * l'ordre est celui du classement.
   */
  readonly layout: 'colonnes' | 'barres';
  /**
   * Met en forme une **graduation de l'échelle**, dans l'unité des `value` des
   * barres — donc l'unité mineure pour un montant.
   *
   * Par défaut un nombre compact, ce qu'attend un axe qui compte des
   * rendez-vous. Un graphique monétaire y passe le formatage de sa devise :
   * sans quoi l'axe graduerait des centimes — « 8,5 k » pour une journée à
   * 85,00 € — sous un titre qui annonce des euros, et contredirait le tableau
   * de sa propre figure (#614). L'argent reste un entier dans la plus petite
   * unité jusqu'ici : c'est le rendu, et lui seul, qui convertit.
   *
   * Sans effet sur `layout="barres"`, qui écrit le `valueLabel` de chaque
   * barre au lieu d'une échelle.
   */
  readonly formatScaleValue?: (value: number) => string;
  readonly bars: readonly ReportChartBar[];
  readonly seriesLabel: string;
  readonly innerSeriesLabel?: string;
  readonly emptyLabel: string;
  /** L'en-tête de la colonne de valeurs du tableau en lecture d'écran. */
  readonly valueHeader: string;
  readonly innerHeader?: string;
}

/** Hauteur de la zone de tracé d'un graphique en colonnes, en unités du viewBox. */
const COLUMN_PLOT_HEIGHT = 150;
/**
 * Largeur du viewBox, **constante quel que soit le nombre de colonnes**.
 *
 * Un viewBox dont la largeur suivrait le nombre de barres serait ensuite étiré à
 * la largeur du conteneur — et **le texte avec lui**. Une semaine de sept
 * colonnes aurait alors des étiquettes deux fois plus grosses qu'un mois de
 * trente, sur le même écran. C'est ce que la recette de #75 a montré sur la
 * maquette. En fixant la largeur et en calculant le pas, l'échelle de rendu ne
 * dépend plus que de la taille de la fenêtre, et les deux graphiques d'un même
 * écran s'écrivent dans le même corps.
 */
const CHART_WIDTH = 720;
/**
 * Marges du viewBox — la gauche loge l'échelle, le bas les étiquettes d'axe.
 *
 * La gauche vaut une graduation entière, devise comprise : depuis #614 l'axe
 * d'un graphe monétaire écrit « 4,5 M MGA » là où il écrivait « 4,5 M », et le
 * texte est ancré à sa fin — trop court, la marge le faisait sortir par la
 * gauche du `viewBox`, où un SVG le rogne sans rien dire.
 */
const COLUMN_MARGIN = { left: 66, right: 10, top: 12, bottom: 30 } as const;
/** Gouttière entre deux colonnes, ramenée au pas quand celui-ci devient étroit. */
const COLUMN_GAP = 6;
/**
 * Largeur maximale d'une colonne.
 *
 * Sans plafond, une période de trois jours peindrait trois pavés de deux cents
 * unités de large : l'écran est rempli, mais la comparaison de hauteurs — la
 * seule chose qu'un graphique de barres sert à faire — se perd dans la masse. La
 * colonne est alors centrée dans son pas, ce qui garde l'axe régulier.
 */
const COLUMN_MAX_WIDTH = 48;

/** Hauteur d'une ligne d'un graphique en barres. */
const BAR_ROW_HEIGHT = 26;
const BAR_MARGIN = { left: 150, right: 74, top: 10, bottom: 10 } as const;

export function ReportChart({
  title,
  summary,
  layout,
  formatScaleValue = compactNumber,
  bars,
  seriesLabel,
  innerSeriesLabel,
  emptyLabel,
  valueHeader,
  innerHeader,
}: ReportChartProps): ReactElement {
  const hasValues = bars.some((bar) => bar.value > 0);

  return (
    <figure className="spa-admin-chart">
      <figcaption className="spa-admin-chart__title">{title}</figcaption>

      {bars.length === 0 || !hasValues ? (
        <p className="spa-admin-chart__empty">{emptyLabel}</p>
      ) : (
        <>
          <p className="spa-admin-chart__legend">
            <span className="spa-admin-chart__key spa-admin-chart__key--primary" />
            {seriesLabel}
            {innerSeriesLabel === undefined ? null : (
              <>
                <span className="spa-admin-chart__key spa-admin-chart__key--inner" />
                {innerSeriesLabel}
              </>
            )}
          </p>

          <div className="spa-admin-chart__canvas">
            {layout === 'colonnes' ? (
              <ColumnChart
                bars={bars}
                formatScaleValue={formatScaleValue}
                summary={summary}
                title={title}
              />
            ) : (
              <BarChart bars={bars} summary={summary} title={title} />
            )}
          </div>
        </>
      )}

      {/*
        Le graphique, en chiffres — la seule forme qu'un lecteur d'écran reçoit.

        Le masque est porté par une `<div>` et non par la `<table>` elle-même.
        `.spa-visually-hidden` réduit sa boîte à 1 px et coupe ce qui dépasse ;
        une table en `table-layout: auto` ignore cette largeur — l'algorithme de
        table ne descend jamais sous la largeur minimale de son contenu, ici
        652 px pour onze lignes de dates et de montants. Posée en absolu, elle
        étendait alors la zone de défilement du document : l'écran des
        indicateurs mesurait 690 px de large sur un téléphone de 360 px, et la
        page entière se défilait latéralement. Une `<div>` obéit, elle, à ses
        1 px, et sa coupure confine la table au lieu de la laisser pousser la
        page (#616).
      */}
      <div className="spa-visually-hidden">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Période</th>
              <th scope="col">{valueHeader}</th>
              {innerHeader === undefined ? null : <th scope="col">{innerHeader}</th>}
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.key}>
                <th scope="row">{bar.label}</th>
                <td>{bar.valueLabel}</td>
                {innerHeader === undefined ? null : <td>{bar.innerLabel ?? '0'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

interface ChartBodyProps {
  readonly bars: readonly ReportChartBar[];
  readonly title: string;
  readonly summary: string;
}

/** Le graphique en colonnes est le seul à peindre une échelle — voir {@link ReportChartProps}. */
interface ColumnChartProps extends ChartBodyProps {
  readonly formatScaleValue: (value: number) => string;
}

/**
 * L'échelle du graphique — une borne haute « ronde », jamais la valeur maximale
 * brute.
 *
 * Une échelle calée sur le maximum ferait toucher le plafond à la plus haute
 * barre, si bien qu'on ne saurait pas si elle est haute ou si elle sature. La
 * borne est donc arrondie au demi-ordre de grandeur supérieur : 18 devient 20,
 * 240 devient 250, 1 384 devient 1 500.
 *
 * Le demi-ordre et non le cinquième : il donne toujours une graduation médiane
 * lisible — 0, la moitié, le plafond — là où un pas plus fin produirait des
 * repères comme « 1 400 / 700 » qu'on ne lit pas d'un coup d'œil.
 *
 * Le pas ne descend jamais sous 2, et c'est ce qui tient la promesse ci-dessus
 * sur les petits nombres. Sous dix, le demi-ordre vaut 0,5 : tout entier est
 * alors son propre plafond — la plus haute barre touchait le haut du cadre — et
 * la graduation médiane s'écrivait « 0,5 » ou « 3,5 » sur un axe qui compte des
 * rendez-vous. C'est le régime courant d'un petit salon, pas un cas limite.
 */
export function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = Math.max(magnitude / 2, 2);

  return Math.ceil(value / step) * step;
}

/**
 * Les étiquettes d'axe à écrire — au plus une sur `n`, pour qu'elles ne se
 * chevauchent pas.
 *
 * Sur une période d'un an, écrire les 366 dates rendrait l'axe illisible et le
 * SVG énorme. On garde donc un jalon régulier, en s'assurant que la **dernière**
 * barre est toujours étiquetée : c'est la borne de la période, et une période
 * dont on ne lit pas la fin ne se situe pas.
 */
export function labelStride(count: number, maxLabels = 12): number {
  return Math.max(1, Math.ceil(count / maxLabels));
}

/**
 * L'identifiant de la hachure de **ce** graphique.
 *
 * Un SVG inséré dans une page HTML ne fait pas document à part : ses `id`
 * tombent dans l'espace de noms du document entier, et `url(#…)` y résout la
 * **première** occurrence. Un identifiant littéral partagé donnait donc autant
 * d'`id` identiques que de graphiques peints — un salon bidevise en montre trois
 * sur cet écran — et toute divergence future entre deux motifs se serait réglée
 * en silence au profit du premier. L'identifiant est donc dérivé du titre, qui
 * est ce qui distingue les graphiques d'un même écran.
 */
function hatchIdOf(title: string): string {
  let hash = 0;

  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
  }

  return `spa-chart-hatch-${hash.toString(36)}`;
}

function ColumnChart({
  bars,
  title,
  summary,
  formatScaleValue,
}: ColumnChartProps): ReactElement {
  const hatchId = hatchIdOf(title);
  const ceiling = niceCeiling(Math.max(...bars.map((bar) => bar.value)));
  const width = CHART_WIDTH;
  const height = COLUMN_MARGIN.top + COLUMN_PLOT_HEIGHT + COLUMN_MARGIN.bottom;
  const baseline = COLUMN_MARGIN.top + COLUMN_PLOT_HEIGHT;
  const step = (width - COLUMN_MARGIN.left - COLUMN_MARGIN.right) / bars.length;
  const barWidth = Math.min(COLUMN_MAX_WIDTH, Math.max(1, step - Math.min(COLUMN_GAP, step / 3)));
  // Le décalage qui recentre la colonne dans son pas — nul dès que le pas est
  // plus étroit que le plafond, c'est-à-dire au-delà d'une quinzaine de barres.
  const barOffset = (step - barWidth) / 2;
  const stride = labelStride(bars.length);
  const gridValues = [0, ceiling / 2, ceiling];

  return (
    <svg
      className="spa-admin-chart__svg"
      role="img"
      tabIndex={0}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      <title>{title}</title>
      <desc>{summary}</desc>
      <HatchPattern id={hatchId} />

      {gridValues.map((value) => {
        const y = baseline - (value / ceiling) * COLUMN_PLOT_HEIGHT;

        return (
          <g key={value}>
            <line
              className="spa-admin-chart__grid"
              x1={COLUMN_MARGIN.left}
              x2={width - COLUMN_MARGIN.right}
              y1={y}
              y2={y}
            />
            <text className="spa-admin-chart__scale" x={COLUMN_MARGIN.left - 6} y={y + 3}>
              {formatScaleValue(value)}
            </text>
          </g>
        );
      })}

      {bars.map((bar, index) => {
        const x = COLUMN_MARGIN.left + index * step + barOffset;
        const barHeight = (bar.value / ceiling) * COLUMN_PLOT_HEIGHT;
        const innerHeight = ((bar.inner ?? 0) / ceiling) * COLUMN_PLOT_HEIGHT;
        const isLast = index === bars.length - 1;

        return (
          <g key={bar.key}>
            <rect
              className={
                bar.highlighted === true
                  ? 'spa-admin-chart__bar spa-admin-chart__bar--selected'
                  : 'spa-admin-chart__bar'
              }
              height={Math.max(barHeight, bar.value > 0 ? 1 : 0)}
              rx="2"
              width={barWidth}
              x={x}
              y={baseline - barHeight}
            />
            {innerHeight > 0 ? (
              <InnerBar
                hatchId={hatchId}
                height={Math.max(innerHeight, 1)}
                width={barWidth}
                x={x}
                y={baseline - innerHeight}
              />
            ) : null}
            {index % stride === 0 || isLast ? (
              <text className="spa-admin-chart__tick" x={x + barWidth / 2} y={baseline + 16}>
                {bar.label}
              </text>
            ) : null}
          </g>
        );
      })}

      <line
        className="spa-admin-chart__axis"
        x1={COLUMN_MARGIN.left}
        x2={width - COLUMN_MARGIN.right}
        y1={baseline}
        y2={baseline}
      />
    </svg>
  );
}

function BarChart({ bars, title, summary }: ChartBodyProps): ReactElement {
  const hatchId = hatchIdOf(title);
  const ceiling = niceCeiling(Math.max(...bars.map((bar) => bar.value)));
  const width = CHART_WIDTH;
  const plotWidth = width - BAR_MARGIN.left - BAR_MARGIN.right;
  const height = BAR_MARGIN.top + bars.length * BAR_ROW_HEIGHT + BAR_MARGIN.bottom;

  return (
    <svg
      className="spa-admin-chart__svg"
      role="img"
      tabIndex={0}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      <title>{title}</title>
      <desc>{summary}</desc>
      <HatchPattern id={hatchId} />

      {bars.map((bar, index) => {
        const y = BAR_MARGIN.top + index * BAR_ROW_HEIGHT;
        const barWidth = (bar.value / ceiling) * plotWidth;
        const innerWidth = ((bar.inner ?? 0) / ceiling) * plotWidth;

        return (
          <g key={bar.key}>
            <text className="spa-admin-chart__row-label" x={BAR_MARGIN.left - 8} y={y + 15}>
              {bar.label}
            </text>
            <rect
              className={
                bar.highlighted === true
                  ? 'spa-admin-chart__bar spa-admin-chart__bar--selected'
                  : 'spa-admin-chart__bar'
              }
              height={BAR_ROW_HEIGHT - 10}
              rx="2"
              width={Math.max(barWidth, bar.value > 0 ? 1 : 0)}
              x={BAR_MARGIN.left}
              y={y + 3}
            />
            {innerWidth > 0 ? (
              <InnerBar
                hatchId={hatchId}
                height={BAR_ROW_HEIGHT - 10}
                width={Math.max(innerWidth, 1)}
                x={BAR_MARGIN.left}
                y={y + 3}
              />
            ) : null}
            <text
              className="spa-admin-chart__row-value"
              x={BAR_MARGIN.left + Math.max(barWidth, 1) + 6}
              y={y + 15}
            >
              {bar.valueLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface InnerBarProps {
  /** Le motif de hachure de ce graphique — voir {@link hatchIdOf}. */
  readonly hatchId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * La part mise en évidence — deux rectangles superposés, et il en faut deux.
 *
 * Le premier porte la teinte, le second la hachure. Les fondre en un seul
 * obligerait à peindre la hachure **sur** la couleur de fond du graphique, si
 * bien que la barre principale transparaîtrait entre les traits ; et une hachure
 * seule, sans aplat, se perdrait sur un fond sombre. La superposition donne les
 * deux redondances — teinte et texture — qu'exige WCAG 1.4.1.
 */
function InnerBar({ x, y, width, height, hatchId }: InnerBarProps): ReactElement {
  return (
    <>
      <rect
        className="spa-admin-chart__bar-inner"
        height={height}
        rx="2"
        width={width}
        x={x}
        y={y}
      />
      <rect
        fill={`url(#${hatchId})`}
        height={height}
        rx="2"
        width={width}
        x={x}
        y={y}
      />
    </>
  );
}

/**
 * La hachure de la série secondaire.
 *
 * Déclarée dans chaque SVG plutôt qu'une fois pour toute la page : un `<defs>`
 * partagé supposerait un identifiant global, et deux graphiques sur le même
 * écran finiraient par se disputer le même. L'identifiant est donc local au
 * document SVG, où il ne peut collisionner qu'avec lui-même.
 */
function HatchPattern({ id }: { readonly id: string }): ReactElement {
  return (
    <defs>
      <pattern
        height="4"
        id={id}
        patternTransform="rotate(45)"
        patternUnits="userSpaceOnUse"
        width="4"
      >
        <line className="spa-admin-chart__hatch" x1="0" x2="0" y1="0" y2="4" />
      </pattern>
    </defs>
  );
}

/** « 1,4 k » plutôt que « 1400 » sur une échelle étroite. */
function compactNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}
