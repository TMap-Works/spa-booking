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
 * Les États-Unis en comptent sept et le Canada six : un pays ne peut donc pas
 * porter un fuseau unique (#1103). Choisir un pays présélectionne le **premier**
 * de ses fuseaux et borne la liste proposée à ce pays — on ne propose pas
 * `Indian/Reunion` à un salon de Chicago, et l'erreur la plus probable devient
 * impossible à commettre par simple inattention.
 *
 * Les fuseaux sont proposés sous leur identifiant IANA, sans libellé traduit :
 * c'est la seule forme que l'API stocke (`timeZoneSchema`), et la seule qui ne
 * demande pas une entrée de catalogue par fuseau. L'habillage de ces listes
 * relève des tickets d'internationalisation de l'épique #843.
 */

export interface CountryPreset {
  readonly code: string;
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
 * Les fuseaux à proposer pour un pays — les siens, ou tous si on ne le connaît
 * pas.
 *
 * Le repli n'est pas décoratif : une liste vide rendrait un `<select>` sans
 * option, dont la valeur affichée ne serait plus celle du formulaire. Mieux
 * vaut trop de fuseaux qu'un salon ouvert dans un fuseau que personne n'a
 * choisi.
 */
export function timezoneChoices(countryCode: string): readonly string[] {
  return countryPreset(countryCode)?.timezones ?? TIMEZONE_CHOICES;
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
