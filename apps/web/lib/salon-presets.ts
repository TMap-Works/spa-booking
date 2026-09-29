/**
 * Ce que le pays d'un salon permet de préremplir — ses fuseaux et sa devise.
 *
 * Partagé par les deux façons d'ouvrir un salon : la console de l'éditeur et
 * l'inscription en libre-service (ADR 0016). Un salon ouvert dans le mauvais
 * fuseau affiche tous ses créneaux décalés (CLAUDE.md, « sévérité haute ») :
 * préremplir évite l'oubli le plus probable, et les deux restent modifiables.
 *
 * ## Un pays, plusieurs fuseaux
 *
 * Les États-Unis en comptent sept et le Canada sept : un pays ne peut donc pas
 * porter un fuseau unique (#1103). Choisir un pays présélectionne le **premier**
 * de ses fuseaux et borne la liste proposée à ce pays — on ne propose pas
 * `Indian/Reunion` à un salon de Chicago, et l'erreur la plus probable devient
 * impossible à commettre par simple inattention.
 *
 * ## Les fuseaux se lisent, l'API stocke l'identifiant (#1330)
 *
 * Ils étaient proposés sous leur identifiant IANA nu — « America/New_York »,
 * « America/St_Johns » —, ce qui demandait de connaître la nomenclature pour
 * ouvrir un salon, et laissait une gérante de Saint-Jean de Terre-Neuve deviner
 * lequel des sept est le sien. Ils portent désormais un libellé lisible et
 * traduit, « Eastern Time (New York) » / « heure de l'Est nord-américain (New
 * York) », rendu par {@link timezoneLabel}.
 *
 * La **valeur** soumise ne change pas : c'est toujours l'identifiant IANA
 * canonique, la seule forme que `timeZoneSchema` accepte. Seule l'étiquette de
 * l'option change, et elle vient d'`Intl` plutôt que d'un catalogue — même
 * arbitrage que {@link countryLabel} (#1105) : vingt-trois fuseaux à traduire à la
 * main dans deux langues auraient été quarante-six entrées de catalogue pour
 * redire ce qu'ICU sait déjà, et qui suivra l'ajout d'un pays sans qu'on y pense.
 *
 * ## Le nom des pays vient d'`Intl`, pas de ce fichier (#1105)
 *
 * Les noms affichés sont ceux qu'`Intl.DisplayNames` rend dans la langue lue —
 * voir {@link countryLabel}. Le `label` figé ci-dessous n'est plus qu'un
 * **repli**, et le libellé de la console de l'éditeur, qui n'est pas traduite.
 * Traduire ces onze noms à la main aurait demandé onze entrées de catalogue par
 * langue, pour redire ce que la plateforme sait déjà.
 */

import type { Locale } from '@spa/shared';

export interface CountryPreset {
  readonly code: string;
  /**
   * Le nom du pays en français — **repli** de {@link countryLabel}, et libellé
   * de la console de l'éditeur (`app/plateforme/`), hors épique #843.
   */
  readonly label: string;
  /**
   * Les fuseaux du pays, **celui à présélectionner en tête**.
   *
   * Tuple non vide, et non `readonly string[]` : sous `noUncheckedIndexedAccess`
   * c'est ce qui fait de `timezones[0]` un `string` plutôt qu'un
   * `string | undefined`, et ce qui interdit à la compilation un pays déclaré
   * sans aucun fuseau — un salon sans fuseau n'existe pas.
   */
  readonly timezones: readonly [string, ...string[]];
  readonly currency: string;
}

/**
 * Les pays proposés, **celui à présélectionner en tête**.
 *
 * Tuple non vide pour la même raison que {@link CountryPreset.timezones} : sous
 * `noUncheckedIndexedAccess`, c'est ce qui fait de `COUNTRY_PRESETS[0]` un
 * `CountryPreset` plutôt qu'un `CountryPreset | undefined`, et ce qui évite à
 * {@link DEFAULT_COUNTRY} une assertion de type que rien ne vérifierait.
 */
export const COUNTRY_PRESETS: readonly [CountryPreset, ...CountryPreset[]] = [
  {
    code: 'US',
    label: 'États-Unis',
    // D'est en ouest. L'Eastern en tête : c'est le fuseau le plus peuplé du
    // pays, donc le pari le moins souvent faux pour une présélection.
    timezones: [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      // L'Arizona ne change pas d'heure — un fuseau à part entière, et non un
      // synonyme de `America/Denver` sept mois par an.
      'America/Phoenix',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
    ],
    currency: 'USD',
  },
  {
    code: 'CA',
    label: 'Canada',
    // L'Eastern en tête pour deux raisons qui concordent : c'est le fuseau le
    // plus peuplé, et c'est celui que le préréglage « Canada (Québec) » posait
    // jusqu'ici — un salon canadien ouvert après ce changement retrouve le même
    // défaut qu'avant. Les autres suivent d'est en ouest.
    timezones: [
      'America/Toronto',
      'America/Halifax',
      'America/St_Johns',
      'America/Winnipeg',
      // La Saskatchewan ne change pas d'heure : elle reste au centre toute
      // l'année, là où Winnipeg avance en été. Un fuseau à part entière, et non
      // un synonyme de `America/Winnipeg` sept mois par an — exactement le cas de
      // `America/Phoenix` chez le voisin du sud. Elle manquait (#1330), et un
      // salon de Regina n'avait aucun fuseau juste à choisir.
      'America/Regina',
      'America/Edmonton',
      'America/Vancouver',
    ],
    currency: 'CAD',
  },
  { code: 'FR', label: 'France', timezones: ['Europe/Paris'], currency: 'EUR' },
  { code: 'MG', label: 'Madagascar', timezones: ['Indian/Antananarivo'], currency: 'MGA' },
  { code: 'RE', label: 'La Réunion', timezones: ['Indian/Reunion'], currency: 'EUR' },
  { code: 'MU', label: 'Maurice', timezones: ['Indian/Mauritius'], currency: 'MUR' },
  { code: 'BE', label: 'Belgique', timezones: ['Europe/Brussels'], currency: 'EUR' },
  { code: 'CH', label: 'Suisse', timezones: ['Europe/Zurich'], currency: 'CHF' },
  { code: 'SN', label: 'Sénégal', timezones: ['Africa/Dakar'], currency: 'XOF' },
  { code: 'CI', label: 'Côte d’Ivoire', timezones: ['Africa/Abidjan'], currency: 'XOF' },
  { code: 'MA', label: 'Maroc', timezones: ['Africa/Casablanca'], currency: 'MAD' },
];

/**
 * Tous les fuseaux proposés, pays confondus.
 *
 * Ce n'est plus ce qu'un formulaire affiche — il affiche ceux du pays choisi,
 * via {@link timezoneChoices} — mais le repli quand le pays est inconnu des
 * préréglages, et la liste que les tests parcourent pour vérifier qu'`Intl`
 * reconnaît chaque identifiant.
 */
export const TIMEZONE_CHOICES: readonly string[] = [
  ...new Set(COUNTRY_PRESETS.flatMap((country) => [...country.timezones])),
];

export const CURRENCY_CHOICES: readonly string[] = [
  ...new Set(COUNTRY_PRESETS.map((country) => country.currency)),
];

/**
 * Le pays présélectionné à l'ouverture d'un salon — les États-Unis (#1103).
 *
 * La clientèle du produit est nord-américaine (décision du PO du 2026-09-19) :
 * le défaut suit le cas le plus fréquent, il ne décrit pas l'éditeur.
 */
export const DEFAULT_COUNTRY: CountryPreset = COUNTRY_PRESETS[0];

export function countryPreset(code: string): CountryPreset | undefined {
  return COUNTRY_PRESETS.find((country) => country.code === code);
}

/**
 * Les noms de pays d'une langue, montés une fois — #1105.
 *
 * `Intl.DisplayNames` monte une table de noms à chaque construction. Sans ce
 * cache, le sélecteur en construirait une **par option et par rendu** — onze
 * par passe, et le formulaire se rend à chaque frappe.
 */
const COUNTRY_NAMES = new Map<Locale, Intl.DisplayNames | null>();

function countryNames(locale: Locale): Intl.DisplayNames | null {
  const cached = COUNTRY_NAMES.get(locale);

  if (cached !== undefined) {
    return cached;
  }

  let names: Intl.DisplayNames | null;

  try {
    names = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    // Un moteur sans données de région pour cette langue : le repli figé
    // ci-dessous vaut mieux qu'un sélecteur qui fait tomber l'écran.
    names = null;
  }

  COUNTRY_NAMES.set(locale, names);

  return names;
}

/**
 * Le nom d'un pays dans la langue lue — « United States », « États-Unis ».
 *
 * Lu d'`Intl` plutôt qu'écrit dans un catalogue : la plateforme connaît déjà ces
 * noms dans les deux langues, et une table maison aurait fini par diverger de la
 * norme ISO 3166 — c'est l'arbitrage déjà rendu pour les décimales d'une devise
 * (`lib/format.ts`).
 *
 * Le repli est le `label` du préréglage, puis le code lui-même : un pays reste
 * ainsi désignable même sur un moteur sans données de région, et un code hors
 * préréglages n'affiche jamais une case vide.
 *
 * `of()` **lève** — `RangeError` — sur un code qui n'a pas la forme d'une région
 * ISO, et non sur un code simplement inconnu. Le promettre tolérant sans
 * rattraper cette levée aurait fait tomber l'écran entier sur une adresse dont
 * le pays est mal formé, là où le repli avait justement tout ce qu'il faut.
 */
export function countryLabel(code: string, locale: Locale): string {
  let displayed: string | undefined;

  try {
    displayed = countryNames(locale)?.of(code);
  } catch {
    displayed = undefined;
  }

  // `of()` rend le code tel quel quand il ne le connaît pas : c'est alors le
  // `label` du préréglage qui informe le mieux.
  if (displayed !== undefined && displayed !== code) {
    return displayed;
  }

  return countryPreset(code)?.label ?? code;
}

/** Un pays tel qu'un sélecteur l'affiche : sa valeur, et son nom traduit. */
export interface CountryChoice {
  readonly code: string;
  readonly label: string;
}

/**
 * Les pays proposés, nommés dans la langue lue — **celui à présélectionner en
 * tête**.
 *
 * L'ordre reste celui de {@link COUNTRY_PRESETS} et non l'ordre alphabétique du
 * nom traduit : il porte une décision produit — les États-Unis d'abord (#1103) —
 * qu'un tri ferait dépendre de la langue.
 */
export function countryChoices(locale: Locale): readonly CountryChoice[] {
  return COUNTRY_PRESETS.map((country) => ({
    code: country.code,
    label: countryLabel(country.code, locale),
  }));
}

/**
 * Les identifiants des fuseaux d'un pays — les siens, ou tous si on ne le
 * connaît pas.
 *
 * Le repli n'est pas décoratif : une liste vide rendrait un `<select>` sans
 * option, dont la valeur affichée ne serait plus celle du formulaire. Mieux
 * vaut trop de fuseaux qu'un salon ouvert dans un fuseau que personne n'a
 * choisi.
 */
export function timezonesOf(countryCode: string): readonly string[] {
  return countryPreset(countryCode)?.timezones ?? TIMEZONE_CHOICES;
}

/**
 * Les formateurs d'un couple langue/fuseau, montés une fois — #1330.
 *
 * Même raison que {@link COUNTRY_NAMES}, et elle pèse davantage ici : un
 * `Intl.DateTimeFormat` est plus coûteux à construire qu'un `DisplayNames`, et
 * sans ce cache le sélecteur en construirait un **par option et par rendu** —
 * sept pour un salon américain, à chaque frappe dans le formulaire d'inscription.
 */
const ZONE_NAMES = new Map<string, Intl.DateTimeFormat | null>();

/**
 * L'instant de référence des libellés de fuseau.
 *
 * `longGeneric` ne dépend pas de la saison — c'est tout son intérêt : il rend
 * « Eastern Time » et non « Eastern Standard Time » ou « Eastern Daylight Time »
 * selon la date. L'instant reste néanmoins **figé** plutôt que `Date.now()` :
 * un libellé qui dépendrait de l'heure de la machine ferait d'un test un test
 * fragile, et d'un rendu serveur puis client deux chaînes qui peuvent différer —
 * ce que React signale en écart d'hydratation.
 */
const ZONE_REFERENCE = Date.UTC(2026, 0, 15, 12, 0, 0);

function zoneFormatter(timezone: string, locale: Locale): Intl.DateTimeFormat | null {
  const key = `${locale}|${timezone}`;
  const cached = ZONE_NAMES.get(key);

  if (cached !== undefined) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat | null;

  try {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      timeZoneName: 'longGeneric',
    });
  } catch {
    // Un fuseau qu'ICU ne connaît pas, ou un moteur sans `longGeneric` : le
    // repli sur la ville seule vaut mieux qu'un sélecteur qui fait tomber
    // l'écran.
    formatter = null;
  }

  ZONE_NAMES.set(key, formatter);

  return formatter;
}

/**
 * La ville d'un identifiant IANA — « America/New_York » → « New York ».
 *
 * Le dernier segment, tirets bas remplacés. Ce n'est pas traduit, et ce n'est pas
 * un oubli : c'est un nom de lieu, du même régime que la voie et la ville d'une
 * adresse de salon (`components/salon/salon-address.ts`) — on n'écrit pas
 * « Nouvelle-York ». Ce que la langue change, c'est le nom du fuseau qui
 * l'accompagne.
 */
function timezoneCity(timezone: string): string {
  const segments = timezone.split('/');

  return (segments[segments.length - 1] ?? timezone).replace(/_/g, ' ');
}

/**
 * Le fuseau tel qu'une gérante le lit — « Eastern Time (New York) », « heure de
 * l'Est nord-américain (New York) » (#1330, deuxième critère d'acceptation).
 *
 * Deux informations, et les deux sont nécessaires : le **nom du fuseau** dit à
 * quelle heure on est, la **ville** dit lequel des sept est le sien. « Eastern
 * Time » seul laisse une gérante de Detroit hésiter ; « New York » seul ne dit pas
 * l'heure d'un salon de Toronto, qui partage ce fuseau sans partager ce nom de
 * ville.
 *
 * Le nom vient de la forme `longGeneric` d'ICU, qui est celle du fuseau **hors
 * saison** : « Eastern Time », jamais « Eastern Standard Time ». Un libellé qui
 * nommerait l'heure d'hiver serait faux la moitié de l'année, et un libellé qui
 * suivrait la saison changerait deux fois par an sous les yeux de l'utilisatrice.
 *
 * Repli sur la ville seule quand ICU n'a pas de nom générique à rendre : un
 * sélecteur reste utilisable avec « Antananarivo », il ne l'est plus avec une
 * option vide.
 */
export function timezoneLabel(timezone: string, locale: Locale): string {
  const city = timezoneCity(timezone);
  const parts = zoneFormatter(timezone, locale)?.formatToParts(ZONE_REFERENCE);
  const name = parts?.find((part) => part.type === 'timeZoneName')?.value;

  if (name === undefined || name === '' || name === city) {
    return city;
  }

  return `${name} (${city})`;
}

/** Un fuseau tel qu'un sélecteur l'affiche : sa valeur IANA, et son nom lisible. */
export interface TimezoneChoice {
  readonly timezone: string;
  readonly label: string;
}

/**
 * Les fuseaux à proposer pour un pays, nommés dans la langue lue — **celui à
 * présélectionner en tête**.
 *
 * Le pendant de {@link countryChoices}, et la même règle sur l'ordre : celui de
 * {@link CountryPreset.timezones}, d'est en ouest, et non l'ordre alphabétique du
 * libellé traduit. Le premier rang porte la présélection du pays (#1103) — la
 * faire dépendre de la langue l'aurait rendue imprévisible.
 */
export function timezoneChoices(countryCode: string, locale: Locale): readonly TimezoneChoice[] {
  return timezonesOf(countryCode).map((timezone) => ({
    timezone,
    label: timezoneLabel(timezone, locale),
  }));
}

/** « Maison Lotus & Spa » → « maison-lotus-spa » : l'adresse web proposée. */
export function slugifySalonName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}
