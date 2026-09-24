import type { Locale } from '@spa/shared';

/**
 * Les mots et les signes du fichier d'export, dans les deux langues — #851,
 * troisième et quatrième critères.
 *
 * ## Ce qui suit la langue, et ce qui ne la suit surtout pas
 *
 * | Colonne | Suit la langue | Pourquoi |
 * |---|---|---|
 * | ligne d'en-tête | **oui** | c'est ce qu'une gérante lit en ouvrant le tableur |
 * | `libelle` | **oui** | c'est de la phrase — « Rendez-vous non honorés » |
 * | `section`, `mesure` | **non** | ce sont des **identifiants** |
 * | `cle`, `valeur`, `devise` | **non** | de la donnée : une date ISO, un entier, un code ISO 4217 |
 *
 * Traduire `section` et `mesure` aurait coûté plus qu'il n'aurait rapporté : ce
 * sont les deux colonnes sur lesquelles on filtre et on croise dans un tableur,
 * et les traduire ferait qu'un export de septembre en français et un export
 * d'octobre en anglais cessent de s'empiler — alors que la forme longue a été
 * choisie précisément pour qu'ils s'empilent (`report-export.csv.ts`). Le
 * libellé, lui, est déjà propre à chaque ligne et ne sert à aucun regroupement.
 *
 * ## Les deux séparateurs vont ensemble, et c'est tout l'enjeu
 *
 * Un tableur en locale française lit la virgule comme **séparateur décimal** :
 * un CSV à virgules y atterrit en une seule colonne. En locale anglaise, c'est
 * l'inverse — le point-virgule n'y est pas le séparateur attendu, et RFC 4180 ne
 * normalise que la virgule.
 *
 * Les deux choix ne sont donc pas indépendants : c'est la même convention lue
 * deux fois. D'où une table qui les porte **ensemble**, plutôt que deux
 * constantes qu'un ticket futur pourrait désaccorder — un fichier à virgules
 * *et* à virgule décimale serait illisible dans les deux langues.
 *
 * | Langue | Colonnes | Décimale |
 * |---|---|---|
 * | `fr` | `;` | `,` |
 * | `en` | `,` | `.` |
 *
 * ## Une seule valeur décimale dans tout le fichier
 *
 * L'argent reste **entier**, en plus petite unité monétaire, quelle que soit la
 * langue : c'est la règle de `CLAUDE.md`, et elle ne se négocie pas contre du
 * confort de tableur. La seule valeur non entière du fichier est le **taux** de
 * no-show, qui est un ratio par nature — et c'est la seule que le séparateur
 * décimal concerne.
 */

/** Ce qu'une langue décide du fichier : ses signes et ses mots. */
export interface ReportExportVocabulary {
  /** Le séparateur de colonnes — voir la table ci-dessus. */
  readonly columnSeparator: string;
  /** Le séparateur décimal du taux de no-show, la seule valeur fractionnaire. */
  readonly decimalSeparator: string;
  /** La ligne d'en-tête, dans l'ordre des six colonnes. */
  readonly header: readonly string[];
  /** Les libellés de la colonne `libelle`, section par section. */
  readonly labels: {
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly timeZone: string;
    readonly allGroups: string;
    readonly honored: string;
    readonly noShows: string;
    readonly cancelled: string;
    readonly pending: string;
    readonly allStatuses: string;
    readonly rate: string;
  };
}

const FRENCH: ReportExportVocabulary = {
  columnSeparator: ';',
  decimalSeparator: ',',
  header: ['section', 'cle', 'libelle', 'mesure', 'valeur', 'devise'],
  labels: {
    windowStart: 'Début de la fenêtre (inclus)',
    windowEnd: 'Fin de la fenêtre (exclue)',
    timeZone: 'Fuseau de découpage des journées',
    allGroups: 'Tous groupes confondus',
    honored: 'Rendez-vous honorés',
    noShows: 'Rendez-vous non honorés',
    cancelled: 'Rendez-vous annulés',
    pending: 'Rendez-vous pas encore jugés',
    allStatuses: 'Tous statuts confondus',
    rate: 'Taux de no-show sur les rendez-vous arrivés à échéance',
  },
};

const ENGLISH: ReportExportVocabulary = {
  columnSeparator: ',',
  decimalSeparator: '.',
  header: ['section', 'key', 'label', 'measure', 'value', 'currency'],
  labels: {
    windowStart: 'Window start (inclusive)',
    windowEnd: 'Window end (exclusive)',
    timeZone: 'Time zone used to cut the days',
    allGroups: 'All groups combined',
    honored: 'Honoured appointments',
    noShows: 'No-show appointments',
    cancelled: 'Cancelled appointments',
    pending: 'Appointments not yet settled',
    allStatuses: 'All statuses combined',
    rate: 'No-show rate over appointments that came due',
  },
};

/**
 * Les deux vocabulaires, par langue.
 *
 * Ils vivent côté API et non dans `apps/web/messages/` : le fichier est
 * sérialisé par le serveur, qui ne lit pas les catalogues du front. C'est aussi
 * pourquoi ces mots ne sont **pas** ceux de l'écran — l'écran écrit « Revenu
 * net », le fichier écrit `net_minor` : l'un s'adresse à un œil, l'autre à un
 * tableur.
 */
const VOCABULARIES: Readonly<Record<Locale, ReportExportVocabulary>> = {
  fr: FRENCH,
  en: ENGLISH,
};

/**
 * Le vocabulaire d'une langue.
 *
 * La langue est déjà validée par `reportExportLocaleSchema` du contrat partagé
 * avant d'arriver ici — la garde ci-dessous n'est donc pas une seconde
 * validation, mais ce qui rend la fonction totale : un `Locale` ajouté au
 * contrat sans sa traduction sortirait en français plutôt que de faire tomber
 * l'export, et la parité est de toute façon tenue par le typage de
 * {@link VOCABULARIES}, qui exige une entrée par langue de `LOCALES`.
 */
export function reportExportVocabulary(locale: Locale): ReportExportVocabulary {
  // `?? FRENCH` et non `LOCALES.includes(locale)` : l'appartenance à `LOCALES`
  // est exactement ce que `VOCABULARIES` couvre, si bien qu'un test d'apparte-
  // nance n'aurait rien attrapé de ce qu'il prétend attraper — une langue
  // ajoutée au contrat sans sa traduction le franchit, et la lecture qui suit
  // tombe sur `undefined`. La lecture indexée, elle, est totale.
  return VOCABULARIES[locale] ?? FRENCH;
}
