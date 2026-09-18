/**
 * Ce que le pays d'un salon permet de préremplir — son fuseau et sa devise.
 *
 * Partagé par les deux façons d'ouvrir un salon : la console de l'éditeur et
 * l'inscription en libre-service (ADR 0016). Un salon ouvert dans le mauvais
 * fuseau affiche tous ses créneaux décalés (CLAUDE.md, « sévérité haute ») :
 * préremplir évite l'oubli le plus probable, et les deux restent modifiables.
 */

export interface CountryPreset {
  readonly code: string;
  readonly label: string;
  readonly timezone: string;
  readonly currency: string;
}

export const COUNTRY_PRESETS: readonly CountryPreset[] = [
  { code: 'FR', label: 'France', timezone: 'Europe/Paris', currency: 'EUR' },
  { code: 'MG', label: 'Madagascar', timezone: 'Indian/Antananarivo', currency: 'MGA' },
  { code: 'RE', label: 'La Réunion', timezone: 'Indian/Reunion', currency: 'EUR' },
  { code: 'MU', label: 'Maurice', timezone: 'Indian/Mauritius', currency: 'MUR' },
  { code: 'BE', label: 'Belgique', timezone: 'Europe/Brussels', currency: 'EUR' },
  { code: 'CH', label: 'Suisse', timezone: 'Europe/Zurich', currency: 'CHF' },
  { code: 'CA', label: 'Canada (Québec)', timezone: 'America/Toronto', currency: 'CAD' },
  { code: 'SN', label: 'Sénégal', timezone: 'Africa/Dakar', currency: 'XOF' },
  { code: 'CI', label: 'Côte d’Ivoire', timezone: 'Africa/Abidjan', currency: 'XOF' },
  { code: 'MA', label: 'Maroc', timezone: 'Africa/Casablanca', currency: 'MAD' },
];

export const TIMEZONE_CHOICES: readonly string[] = [
  ...new Set(COUNTRY_PRESETS.map((country) => country.timezone)),
];

export const CURRENCY_CHOICES: readonly string[] = [
  ...new Set(COUNTRY_PRESETS.map((country) => country.currency)),
];

export const DEFAULT_COUNTRY = COUNTRY_PRESETS[0] as CountryPreset;

export function countryPreset(code: string): CountryPreset | undefined {
  return COUNTRY_PRESETS.find((country) => country.code === code);
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
