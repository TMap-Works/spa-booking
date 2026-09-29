/**
 * Mise en forme des instants et des montants pour l'affichage.
 *
 * Deux règles de `CLAUDE.md` se tiennent ici, et nulle part ailleurs dans le
 * front :
 *
 * - **tout est stocké en UTC, converti à l'affichage selon le fuseau du
 *   tenant.** Aucun composant n'appelle `toLocaleString` sans fuseau : ce serait
 *   celui du navigateur, et une cliente qui réserve en voyage verrait un
 *   rendez-vous décalé ;
 * - **l'argent est un entier plus une devise.** Aucun composant ne divise un
 *   montant lui-même.
 */

import {
  AMOUNT_MINOR_MAX,
  DEFAULT_LOCALE,
  formattingLocale,
  separatorsOf,
  withPlainSeparators,
  type CalendarDate,
  type Locale,
  type Money,
  type TimeZone,
  type UtcInstant,
} from '@spa/shared';

import en from '@/messages/en/format.json';
import fr from '@/messages/fr/format.json';

/**
 * ## La langue du formatage (#845)
 *
 * Chaque fonction de ce module reçoit la langue, en dernier paramètre. Ce n'est
 * pas la même chose que la langue des **mots** : un libellé vient du catalogue,
 * une date vient d'`Intl`, et c'est `Intl` qui sait que le 1er septembre s'écrit
 * « lundi 1 septembre » en français et « Monday, 1 September » en anglais.
 *
 * ### La région, et d'où elle vient
 *
 * Une langue ne suffit pas à formater : `en-US` écrit « 9/1/2026 » là où
 * `en-GB` écrit « 01/09/2026 », et les deux sont de l'anglais. La région vient
 * donc du **pays de l'établissement** (`Tenant.countryCode`, lu sur l'adresse de
 * la fiche publique) : un salon montréalais écrit ses dates comme le Québec, un
 * salon londonien comme le Royaume-Uni.
 *
 * La règle qui en tire l'étiquette — et le repli documenté et figé quand le champ
 * est vide, qu'exige le dixième critère d'acceptation de #845 — n'est plus écrite
 * ici : c'est `formattingLocale` de `@spa/shared`, celle-là même que le PDF du
 * reçu applique (#1343). Ce module en est un **point d'emploi**.
 *
 * ### Le cycle horaire n'est jamais forcé — 12 h pour un salon américain (#1325)
 *
 * C'est la conséquence directe de la règle ci-dessus, et l'arbitrage que le
 * deuxième critère de #1325 demandait de rendre : l'heure s'écrit comme
 * l'étiquette `{langue}-{pays}` l'écrit, et **aucune surface ne la force**. Un
 * salon de Manhattan lu en anglais (`en-US`) affiche donc « 2:10 PM » partout —
 * grille de créneaux, cartes du planning, **gouttière du planning comprise**,
 * ticket à l'écran, PDF —, et un salon parisien lu en anglais (`en-FR`) affiche
 * « 14:10 » partout.
 *
 * L'alternative — 24 h partout, quel que soit le salon — a été écartée : elle
 * aurait fait mentir la région du reste de l'écran, qui écrit déjà la date, les
 * nombres et les montants à la façon du pays du salon, et aurait obligé chaque
 * surface à repasser un `hourCycle` par-dessus `Intl` — c'est-à-dire à rouvrir
 * la porte par laquelle les sept divergences du constat de #1325 sont entrées.
 *
 * ### Ce qui ne change pas
 *
 * Le **fuseau** reste celui de l'établissement, toujours passé explicitement :
 * la langue n'y touche pas, et un rendez-vous mal fuseau-horairé est un bug de
 * sévérité haute (`CLAUDE.md`). Les **montants** restent des entiers accompagnés
 * d'un code devise ; seule leur mise en forme suit la langue.
 *
 * ### Pourquoi un paramètre facultatif, et pourquoi son repli a changé
 *
 * Les quarante et quelques appelants de ce module étaient hors de l'empreinte de
 * #845 : chacun a passé la langue résolue dans son propre ticket de l'épique
 * #843. Le défaut servait à garder, d'ici là, le comportement d'avant le
 * ticket — le français — plutôt que de faire basculer en anglais des écrans dont
 * personne n'avait encore relu la traduction.
 *
 * Cette raison est éteinte, et #1297 en tire la conséquence : le repli vaut
 * `DEFAULT_LOCALE`, la langue par défaut du produit. Le paramètre reste
 * facultatif — le rendre obligatoire ici ferait porter à un ticket de correction
 * la réécriture de la quarantaine d'appelants du monolithe front —, mais il ne
 * promet plus du français à qui l'oublie. Là où l'oubli était **visible sur le
 * parcours de réservation**, le type l'interdit désormais pour de bon :
 * `DateBlock`, `addressLines`, `formatMonth` et les trois fonctions du fichier
 * d'agenda exigent leur langue.
 */

/** La langue employée quand l'appelant n'en passe pas — voir ci-dessus. */
const FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;

/**
 * Ce qui décide de la mise en forme : une langue, et le pays de
 * l'établissement.
 *
 * Un objet et non deux paramètres positionnels : il se passe de main en main à
 * travers les composants sans qu'aucun n'ait à se souvenir de l'ordre, et le
 * jour où une troisième dimension s'y ajoute — un calendrier, un système
 * d'unités — les quarante appelants n'ont pas à changer de signature.
 */
export interface DisplayLocale {
  readonly locale: Locale;
  /** `Tenant.countryCode` — ISO 3166-1 alpha-2, ou rien. */
  readonly countryCode?: string | null | undefined;
}

/** Le même repli, sous la forme que les fonctions du module attendent. */
const FALLBACK_DISPLAY: DisplayLocale = { locale: FALLBACK_LOCALE };

/** Les mots que `Intl` ne sait pas dire, dans les deux langues. */
const WORDS = { fr, en } as const;

/** L'étiquette `Intl` de ce contexte d'affichage. */
function tag(display: DisplayLocale): string {
  return formattingLocale(display.locale, display.countryCode);
}

/**
 * Le remplacement des paramètres d'un message lu **hors de React**.
 *
 * Ce module est fait de fonctions pures, appelées depuis des Server Components,
 * des Client Components et des tests sans DOM : aucun crochet de `next-intl` n'y
 * est disponible. Les quatre messages concernés n'ont qu'un paramètre chacun et
 * aucune forme plurielle — un remplacement littéral suffit, et évite d'embarquer
 * un formateur ICU dans le chemin de chaque date affichée.
 */
function fill(message: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    message,
  );
}

/**
 * L'étiquette BCP 47 complète à passer à `Intl` — « fr-CA », « en-US ».
 *
 * Réexportée telle quelle de `@spa/shared`, où la règle vit depuis #1343 : la
 * table de repli par langue et le refus d'un code pays mal formé y sont décrits,
 * et le PDF du reçu lit la même fonction — c'est ce que le premier critère de
 * #1325 demandait, et qu'un doublon tenu par des tests miroir ne donnait qu'à
 * moitié.
 *
 * Le réexport n'est pas une commodité d'import : il tient ce module pour le
 * **point d'emploi unique** du front — « aucun composant n'appelle
 * `toLocaleString` sans fuseau », dit l'en-tête, et une quarantaine d'appelants
 * lisent déjà l'étiquette d'ici.
 */
export { formattingLocale };

/** « lundi 1 septembre 2026 à 11:00 », dans le fuseau de l'établissement. */
export function formatDateTimeInTimeZone(
  instant: UtcInstant,
  timeZone: TimeZone,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  return new Intl.DateTimeFormat(tag(display), {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(instant));
}

/**
 * « 18/09/2026 14:32 » — l'horodatage d'un ticket de caisse, dans le fuseau du
 * salon. Court et chiffré, comme sur un rouleau de 80 mm, où le jour de la
 * semaine en toutes lettres ne tiendrait pas sur une ligne.
 */
export function formatTicketDateTime(
  instant: UtcInstant,
  timeZone: TimeZone,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  return new Intl.DateTimeFormat(tag(display), {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(instant))
    .replace(',', '');
}

/** « 11:00 » — pour une liste de créneaux, où la date est déjà en titre. */
export function formatTimeInTimeZone(
  instant: UtcInstant,
  timeZone: TimeZone,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  return new Intl.DateTimeFormat(tag(display), { timeZone, timeStyle: 'short' }).format(
    new Date(instant),
  );
}

/** « lundi 1 septembre 2026 » — l'en-tête d'une journée de créneaux. */
export function formatCalendarDate(
  date: CalendarDate,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  // Une date civile **est déjà** celle de l'établissement : le serveur l'a
  // découpée dans son fuseau (`dayAvailabilitySchema`). La reprojeter dans ce
  // fuseau la décalerait — `2026-09-01T12:00Z` lu à Auckland (UTC+12/+13) est
  // déjà le 2 septembre, et l'en-tête annoncerait un jour de plus que les
  // créneaux qu'il coiffe. On la met donc en forme telle quelle, en lisant
  // minuit UTC dans le référentiel UTC : la sortie ne dépend d'aucun fuseau.
  return new Intl.DateTimeFormat(tag(display), { timeZone: 'UTC', dateStyle: 'full' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/**
 * Le fuseau de l'établissement, tel qu'on le mentionne à un visiteur qui n'y est
 * pas — « heure de Indian/Antananarivo ».
 *
 * Rendu `null` quand le visiteur est déjà dans ce fuseau : la mention n'apprend
 * alors rien et alourdit chaque ligne du parcours.
 */
export function timeZoneMention(
  timeZone: TimeZone,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string | null {
  const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return viewerTimeZone === timeZone
    ? null
    : fill(WORDS[display.locale].timeZoneMention, { timeZone: timeZone.replace(/_/g, ' ') });
}

/**
 * Nombre de décimales d'une devise — deux pour l'euro, zéro pour l'ariary ou le
 * yen. Lu d'`Intl` plutôt que codé en dur : une table locale finirait par
 * diverger de la norme ISO 4217.
 */
function fractionDigitsOf(currency: string, intlTag: string): number {
  // `maximumFractionDigits` est déclaré optionnel : le repli à deux décimales
  // est celui de la très grande majorité des devises, et il vaut mieux qu'une
  // exception au milieu d'un montant affiché.
  return (
    new Intl.NumberFormat(intlTag, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * « 35,00 € » à partir de `{ amountMinor: 3500, currency: 'EUR' }`.
 *
 * La division par la puissance de dix est le seul flottant du parcours, et il
 * est cantonné à l'affichage : aucun calcul n'en dépend, `Intl` arrondit à la
 * précision de la devise, et les montants du MVP tiennent dans un entier 32 bits
 * — donc très en deçà du seuil où un `number` cesse d'être exact.
 *
 * Les séparateurs sont ceux des autres nombres de l'écran, et non ceux que CLDR
 * réserve à la monnaie : voir {@link withPlainSeparators}.
 */
export function formatMoney(amount: Money, display: DisplayLocale = FALLBACK_DISPLAY): string {
  const intlTag = tag(display);
  const digits = fractionDigitsOf(amount.currency, intlTag);

  return withPlainSeparators(amount.amountMinor / 10 ** digits, intlTag, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * « 85 € », « 8,5 k € » — le même montant que {@link formatMoney}, ramené à la
 * place dont dispose une **graduation d'axe**.
 *
 * Même conversion, même lecture des décimales chez `Intl` : c'est ce qui
 * garantit que l'échelle d'un graphique et le tableau de la même figure
 * annoncent le même montant. L'axe du revenu graduait ses centimes — « 8,5 k »
 * sous un titre « EUR », pour une journée à 85,00 € — parce qu'il mettait en
 * forme la valeur brute de la barre avec un formateur d'entiers (#614).
 *
 * Seule la notation change : compacte, une décimale au plus. Une graduation
 * dispose d'une quarantaine d'unités de `viewBox`, et « 8 500,00 € » y
 * déborderait sur le tracé.
 *
 * `minimumFractionDigits: 0` est explicite : sans lui, `Intl` ramènerait le
 * minimum de l'euro — deux décimales — au maximum demandé, et une échelle ronde
 * s'écrirait « 85,0 € ».
 *
 * ## Une décimale au-dessus de l'unité, la précision de la devise en dessous
 *
 * Le maximum d'une décimale est taillé pour des montants qui se comptent en
 * unités principales — le régime de toutes les graduations d'un salon qui
 * encaisse. Sous l'unité, il efface tout : une période dont le plafond vaut deux
 * centimes se gradue 0 / 1 / 2 centimes, et les trois repères s'écrivaient
 * « 0 € », « 0 € », « 0 € » — un axe qui ne distingue plus rien de ce qu'il
 * gradue (#640).
 *
 * En dessous de l'unité principale, la précision devient donc celle de la devise
 * — deux décimales pour l'euro, aucune pour l'ariary, qui n'a de toute façon
 * rien sous son unité. La notation compacte, elle, n'agit qu'à partir du
 * millier : sous l'unité, elle n'abrège rien et la place gagnée ne manque à
 * personne.
 */
export function formatMoneyCompact(
  amount: Money,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  const intlTag = tag(display);
  const digits = fractionDigitsOf(amount.currency, intlTag);
  // Le seul flottant du chemin, et il ne sert qu'à choisir une précision
  // d'affichage — voir {@link formatMoney} sur pourquoi il est sans risque ici.
  const major = amount.amountMinor / 10 ** digits;

  // Mêmes séparateurs que {@link formatMoney} et que le tableau de la même
  // figure : une graduation d'axe qui écrirait « 8.5 k € » sous un tableau à
  // « 8 500,00 € » serait la divergence de #1325 réintroduite à l'échelle d'un
  // graphique.
  return withPlainSeparators(major, intlTag, {
    style: 'currency',
    currency: amount.currency,
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.abs(major) < 1 ? digits : 1,
  });
}

/**
 * Le montant en unité principale, **sans flottant**, avec le séparateur décimal
 * demandé — « 35,00 » ou « 35.00 » selon qui va le lire.
 *
 * Aucune division : l'entier est découpé **en chaîne**, partie entière d'un
 * côté, décimales de l'autre. Le formatage d'affichage (`formatMoney`) peut se
 * permettre le flottant parce que rien n'en dépend ; les deux formes construites
 * ici sont relues — par l'API après un aller-retour de formulaire, par un
 * analyseur schema.org —, et un centième perdu au passage reviendrait annoncer
 * un autre prix que celui que la gérante a saisi.
 *
 * Le nombre de décimales vient de `fractionDigitsOf`, donc d'`Intl` : c'est ce
 * qui garantit qu'une devise à zéro décimale (ariary, yen) ne gagne pas deux
 * décimales inventées sur l'une des formes et pas sur l'autre.
 */
function formatMajorUnits(amount: Money, decimalSeparator: string): string {
  // L'étiquette est sans effet ici : seule la précision de la devise est lue, et
  // elle ne dépend pas de la langue. Elle est passée pour que `fractionDigitsOf`
  // n'ait qu'une seule façon d'être appelée.
  const digits = fractionDigitsOf(amount.currency, tag(FALLBACK_DISPLAY));
  const sign = amount.amountMinor < 0 ? '-' : '';
  const raw = String(Math.abs(amount.amountMinor)).padStart(digits + 1, '0');
  const units = raw.slice(0, raw.length - digits);

  return digits === 0
    ? `${sign}${units}`
    : `${sign}${units}${decimalSeparator}${raw.slice(raw.length - digits)}`;
}

/**
 * Le montant tel qu'un champ de saisie le pré-remplit — « 35,00 » en français,
 * « 35.00 » en anglais, sans devise ni séparateur de milliers.
 *
 * Le séparateur décimal est **celui de la langue de l'écran** (#1123). Il était
 * figé sur la virgule : le premier écran de saisie traduit affichait alors un
 * total « €1,200.00 » au-dessus d'un champ pré-rempli « 1200,00 », et recoller
 * dans ce champ le montant qu'on venait de lire se faisait refuser.
 *
 * Aucun séparateur de milliers, dans aucune des deux langues : un champ de
 * formulaire se retape, et grouper « 1 200,00 » obligerait la gérante à
 * reproduire une espace insécable pour corriger un prix. {@link parseAmountInput}
 * sait de toute façon relire la forme groupée, qui est celle qu'on recopie depuis
 * l'affichage.
 */
export function formatAmountInput(
  amount: Money,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  return formatMajorUnits(amount, separatorsOf(tag(display)).decimal);
}

/**
 * Le montant en forme **machine** — « 35.00 », unité principale, point décimal,
 * sans symbole ni séparateur de milliers.
 *
 * C'est ce qu'attendent les consommateurs non humains d'un prix : le `price`
 * d'une `Offer` schema.org (`components/salon/structured-data.tsx`), et tout ce
 * qui viendra ensuite du même genre. `formatMoney` ne peut pas les servir — sa
 * sortie localisée porte une virgule décimale, un symbole et une espace
 * insécable, qu'aucun analyseur n'accepte.
 *
 * Elle vit ici, et non chez son appelant, parce que c'est la règle en tête de ce
 * module : **aucun composant ne divise un montant lui-même**. Une seconde
 * lecture des décimales ailleurs dans le front pourrait diverger de celle-ci sur
 * une devise à zéro décimale, et l'affichage humain et le graphe schema.org
 * annonceraient alors deux prix différents (#344).
 */
export function formatAmountMachine(amount: Money): string {
  return formatMajorUnits(amount, '.');
}

/**
 * Un montant **groupé** dans la forme de la langue, indexé par son séparateur de
 * milliers — « 1,200.50 » en anglais, « 1.200,50 » là où les deux rôles
 * s'inversent.
 *
 * Le groupement est reconnu à sa **forme exacte** : un à trois chiffres, puis au
 * moins un groupe de trois. C'est ce qui sépare « 1,200 » — mille deux cents sur
 * un écran anglais — de « 19,90 », où la même virgule est celle qu'une
 * francophone vient de taper dans un champ anglais. Sans cette exigence de trois
 * chiffres, le second serait lu mille neuf cent quatre-vingt-dix.
 *
 * Littérales et non construites à la volée : deux expressions valent mieux qu'une
 * `new RegExp` dont le contenu vient d'`Intl`.
 */
const GROUPED_AMOUNT: Readonly<Record<string, RegExp>> = {
  ',': /^(\d{1,3}(?:,\d{3})+)(?:\.(\d*))?$/,
  '.': /^(\d{1,3}(?:\.\d{3})+)(?:,(\d*))?$/,
};

/** N'importe quel nombre de chiffres, puis un séparateur décimal au plus. */
const PLAIN_AMOUNT = /^(\d+)(?:[.,](\d*))?$/;

/**
 * Les deux parts d'un montant saisi — entière et décimale —, ou `null` si la
 * chaîne n'est pas un nombre lisible.
 *
 * Deux lectures, essayées dans cet ordre, et **aucune devinette** au-delà :
 *
 * 1. la forme **groupée** de la langue, celle qu'on obtient en recopiant un
 *    montant affiché : « 1,200.50 » lu sur un écran anglais, « 1 200,50 » sur un
 *    écran français — dont les espaces sont déjà tombées ;
 * 2. la forme **simple**, un séparateur décimal au plus, `,` ou `.` indifféremment.
 *    C'est la tolérance que le troisième critère de #1123 demande : une virgule
 *    tapée sur un écran anglais et un point tapé sur un écran français valent l'un
 *    pour l'autre, parce que c'est ce qu'une personne fait réellement.
 *
 * Ce qui reste ambigu est **refusé** plutôt que deviné : « 1.200,50 » sur un
 * écran anglais ne correspond à aucune des deux lectures, et rien ne dit si son
 * auteur voulait mille deux cents ou un et deux dixièmes. Un prix faux vaut
 * moins qu'un refus lisible.
 */
function splitAmountInput(
  text: string,
  group: string,
): { readonly units: string; readonly fraction: string } | null {
  // Espaces de groupement comprises : la classe `\s` de JavaScript couvre
  // l'insécable (U+00A0) et l'espace fine insécable (U+202F), celles qu'`Intl`
  // insère dans « 1 200,00 € » et qui reviennent telles quelles quand on recopie
  // un montant affiché.
  const blanksGone = text.replace(/\s/g, '');
  // Et le séparateur de milliers qui n'est **ni** « , » ni « . » tombe avec
  // elles : un salon suisse anglophone (`en-CH`) voit « 1’200.00 » dans la pile
  // des totaux, et l'apostrophe typographique ne peut se lire comme une
  // décimale — la retirer n'ouvre donc aucune ambiguïté. Les deux séparateurs qui
  // en portent une, eux, restent à la charge de {@link GROUPED_AMOUNT}, qui
  // exige la forme groupée complète avant de les effacer.
  const cleaned =
    group === '' || group === ',' || group === '.'
      ? blanksGone
      : blanksGone.split(group).join('');
  const grouped = GROUPED_AMOUNT[group]?.exec(cleaned) ?? null;
  const match = grouped ?? PLAIN_AMOUNT.exec(cleaned);

  if (match === null) {
    return null;
  }

  return {
    // Les séparateurs de milliers de la lecture groupée n'ont plus rien à dire :
    // seuls les chiffres comptent, et la conversion reste une concaténation.
    units: (match[1] ?? '').replace(/[.,]/g, ''),
    fraction: match[2] ?? '',
  };
}

/**
 * « 35,00 » → `{ amountMinor: 3500, currency: 'EUR' }`, ou `null` si la saisie
 * n'est pas un montant de cette devise.
 *
 * **Aucun flottant nulle part** : `Number('35.00') * 100` rend `3499.9999…` sur
 * certaines valeurs, et un prix faux d'un centime est un prix faux. Les chiffres
 * sont donc concaténés en chaîne puis convertis une seule fois, en entier.
 *
 * Le nombre de décimales est celui de la devise — deux pour l'euro, zéro pour
 * l'ariary. Une saisie plus précise que la devise (« 35,005 » en euros) est
 * **refusée** plutôt qu'arrondie en silence : arrondir déciderait à la place de
 * la gérante du prix qu'elle vend.
 *
 * La langue de l'écran décide de la forme **groupée** qui sera reconnue (#1123),
 * pas de ce qui est toléré : un point et une virgule restent interchangeables
 * comme séparateur décimal dans les deux langues. Ce qu'elle garantit, c'est
 * l'aller-retour — ce que {@link formatAmountInput} vient d'écrire se relit ici,
 * en français comme en anglais. Voir {@link splitAmountInput}.
 */
export function parseAmountInput(
  text: string,
  currency: string,
  display: DisplayLocale = FALLBACK_DISPLAY,
): Money | null {
  const intlTag = tag(display);
  // La précision, elle, ne dépend d'aucune langue — c'est celle de la devise. Le
  // même contexte est passé aux deux lectures pour n'avoir qu'une étiquette en
  // circulation.
  const digits = fractionDigitsOf(currency, intlTag);
  const split = splitAmountInput(text, separatorsOf(intlTag).group);

  if (split === null) {
    return null;
  }

  if (split.fraction.length > digits) {
    return null;
  }

  const amountMinor = Number(`${split.units}${split.fraction.padEnd(digits, '0')}`);

  return amountMinor > AMOUNT_MINOR_MAX ? null : { amountMinor, currency };
}

/** « 1 h 15 » à partir d'une durée en minutes. */
export function formatDuration(minutes: number, display: DisplayLocale = FALLBACK_DISPLAY): string {
  const words = WORDS[display.locale];
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) {
    return fill(words.durationMinutes, { minutes: String(rest) });
  }

  return rest === 0
    ? fill(words.durationHours, { hours: String(hours) })
    : fill(words.durationHoursMinutes, {
        hours: String(hours),
        minutes: String(rest).padStart(2, '0'),
      });
}

/**
 * Le même montant, réécrit dans une autre langue — « 10,00 » → « 10.00 » (#1327).
 *
 * C'est ce dont un champ de saisie a besoin quand la langue de l'écran change
 * **sous** lui : le sélecteur du rail pose un cookie et laisse Next rejouer la
 * route sans démonter le formulaire (`i18n/actions.ts`), si bien qu'un prix
 * pré-rempli « 10,00 » restait écrit à la française sous un gabarit qui, lui,
 * annonçait « 35.00 ». Rien ne s'y perdait — {@link parseAmountInput} reste
 * tolérant aux deux séparateurs —, mais l'écran se contredisait.
 *
 * La lecture se fait avec `from`, la langue dans laquelle la saisie a été
 * écrite, et **non** avec `to` : « 1,234 » vaut mille deux cent trente-quatre
 * sous un écran anglais et un virgule deux cent trente-quatre sous un écran
 * français, et c'est celui qui a tapé qui décide lequel. Lire avec la langue
 * d'arrivée reviendrait à réinterpréter sa saisie au moment précis où on la
 * réécrit.
 *
 * `null` quand la saisie n'est pas un montant lisible : le champ vide, une frappe
 * en cours, une devise à deux décimales à qui l'on en a donné trois. L'appelant
 * **laisse alors le texte tel quel** — réécrire une saisie qu'on n'a pas comprise
 * l'effacerait, et c'est le schéma du formulaire qui a le dernier mot sur ce qui
 * est refusé, à la soumission.
 */
export function reformatAmountInput(
  text: string,
  currency: string,
  from: DisplayLocale,
  to: DisplayLocale,
): string | null {
  const amount = parseAmountInput(text, currency, from);

  return amount === null ? null : formatAmountInput(amount, to);
}
