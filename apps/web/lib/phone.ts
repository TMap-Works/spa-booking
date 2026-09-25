import { DEFAULT_LOCALE, E164_PATTERN, isLocale, normalizeToE164, type Locale } from '@spa/shared';
import {
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js/min';
import examples from 'libphonenumber-js/mobile/examples';

/**
 * Le téléphone côté affichage et côté saisie (#825) — ce que le contrat ne
 * tranche pas, parce que ce n'est pas une règle mais une présentation.
 *
 * La règle, elle, reste unique et vit dans `@spa/shared` : `e164PhoneSchemaFor`
 * accepte ou refuse, et l'API rend les numéros en E.164 (#824). Ce module ne
 * fait que trois choses de ce stock : l'**écrire** pour un humain
 * (`+33 6 12 34 56 78`), choisir le **pays** où la saisie commence, et
 * **dire** pourquoi un numéro est refusé en nommant ce pays.
 *
 * Aucun import de React : les pages serveur (vitrine, fiche client, tableau du
 * personnel) formatent avec les mêmes fonctions que le champ de saisie.
 */

/**
 * Les langues dans lesquelles le champ sait parler — celles du contrat (#843).
 *
 * Un alias de `Locale` et non une union recopiée : les deux tables de ce module
 * (`MESSAGES`) et celle du champ (`TEXTS`) sont indexées par cette clé, et une
 * troisième langue ajoutée à `LOCALES` doit faire échouer la compilation ici
 * plutôt que se traduire, à l'écran, par un repli silencieux.
 */
export type PhoneLocale = Locale;

/**
 * La langue du champ à partir de celle de la session (#1267).
 *
 * `useLocale()` de `next-intl` rend une `string` : la configuration garantit
 * qu'elle est l'une des deux, le type ne le dit pas. Cette fonction le
 * **vérifie** plutôt que de le supposer — un `as PhoneLocale` sur une valeur
 * inconnue indexerait `MESSAGES` sur `undefined` et ferait lever le champ à
 * l'affichage d'un refus.
 *
 * Le repli est `DEFAULT_LOCALE`, la dernière étape de `resolveLocale`
 * (`i18n/resolve.ts`) : quand rien n'est exploitable, le produit sert l'anglais.
 * Le repli `'fr'` que #845 avait posé sur la propriété de `PhoneField`, à titre
 * transitoire, disparaît du même coup — c'est lui qui faisait parler français
 * six écrans anglais sur sept.
 */
export function resolvePhoneLocale(locale: string | null | undefined): PhoneLocale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * Le pays de repli quand l'établissement n'en a pas publié.
 *
 * Les États-Unis et non la France : la clientèle du produit est
 * nord-américaine depuis le 2026-09-19 (#843, #1103), et c'est aussi le pays
 * que `libphonenumber-js` tient pour principal sur l'indicatif `+1`. Le pays
 * reste modifiable dans le champ — un repli n'est qu'un point de départ.
 */
export const FALLBACK_PHONE_COUNTRY: CountryCode = 'US';

/**
 * Le pays où la saisie commence : celui de l'établissement s'il est connu de
 * `libphonenumber-js`, le repli sinon.
 *
 * Même tolérance de casse que `normalizeToE164` : la valeur vient d'une
 * colonne (`tenants.country_code`) autant que d'un formulaire.
 */
export function resolvePhoneCountry(code: string | null | undefined): CountryCode {
  const upper = code?.trim().toUpperCase() ?? '';

  return isSupportedCountry(upper) ? upper : FALLBACK_PHONE_COUNTRY;
}

/** `+33` pour `FR` — l'indicatif tel qu'on l'écrit. */
export function dialCode(country: CountryCode): string {
  return `+${getCountryCallingCode(country)}`;
}

/**
 * Le nom d'un pays dans la langue de l'écran — `Intl.DisplayNames`, déjà
 * employé par l'adresse de la vitrine (`components/salon/salon-address.ts`),
 * plutôt qu'une table de deux cent quarante noms à embarquer et à traduire.
 *
 * Le code est rendu tel quel si le moteur ne sait pas le nommer : un code est
 * lisible, une chaîne vide ne l'est pas.
 */
export function countryName(country: string, locale: PhoneLocale): string {
  try {
    return regionNames(locale).of(country) ?? country;
  } catch {
    return country;
  }
}

/**
 * Un `Intl.DisplayNames` par langue, et non par appel : la liste des pays en
 * nomme deux cent quarante d'affilée.
 */
const REGION_NAMES = new Map<PhoneLocale, Intl.DisplayNames>();

function regionNames(locale: PhoneLocale): Intl.DisplayNames {
  let names = REGION_NAMES.get(locale);

  if (names === undefined) {
    names = new Intl.DisplayNames([locale], { type: 'region' });
    REGION_NAMES.set(locale, names);
  }

  return names;
}

/**
 * Un numéro **affiché** : `+33 6 12 34 56 78` plutôt que `+33612345678`
 * (critère 7 de #825).
 *
 * L'international et non le national, parce que l'écran ne sait pas d'où il
 * est lu : « 06 12 34 56 78 » ne se compose pas depuis Montréal. Ce qui ne
 * s'analyse pas — une valeur écrite avant #824 que la reprise n'aurait pas pu
 * normaliser — est rendu tel quel : mieux vaut un numéro mal espacé qu'un
 * numéro disparu.
 */
export function formatPhoneForDisplay(value: string): string {
  const parsed = parsePhoneNumberFromString(value);

  return parsed === undefined ? value : parsed.formatInternational();
}

/**
 * La valeur que le champ peut recevoir : E.164, ou rien.
 *
 * `react-phone-number-input` n'accepte qu'un E.164 et lève sur tout le reste.
 * Or un brouillon de réservation (`sessionStorage`) écrit avant #825 peut
 * porter un « 06 12 34 56 78 » tel qu'il avait été tapé : il est complété avec
 * le pays de l'établissement, comme l'API l'aurait fait, et abandonné s'il ne
 * se complète pas — la cliente le retape, plutôt que de voir l'étape planter.
 */
export function toPhoneInputValue(value: string, country: CountryCode): string | undefined {
  const trimmed = value.trim();

  if (trimmed === '') {
    return undefined;
  }

  if (E164_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return normalizeToE164(trimmed, country) ?? undefined;
}

/**
 * Un numéro d'exemple **du pays choisi**, au format national — le repère que
 * #626 avait dû retirer parce qu'il était écrit en dur pour Madagascar.
 *
 * Calculé à partir du pays et non choisi à la main : l'exemple change avec le
 * drapeau, et n'est donc jamais celui d'un autre plan de numérotation.
 */
export function phoneExample(country: CountryCode): string | undefined {
  return getExampleNumber(country, examples)?.formatNational();
}

const MESSAGES = {
  en: {
    tooShort: (name: string, dial: string) => `This number is too short for ${name} (${dial}).`,
    tooLong: (name: string, dial: string) =>
      `This number has too many digits for ${name} (${dial}).`,
    invalid: (name: string, dial: string) =>
      `This number doesn’t look valid for ${name} (${dial}). Check the digits or change the country.`,
  },
  fr: {
    // « ce pays (France, +33) » plutôt que « pour la France » : l'article
    // dépend du nom — la France, les États-Unis, Madagascar —, et aucune table
    // ne le donne pour deux cent quarante pays.
    tooShort: (name: string, dial: string) => `Ce numéro est incomplet pour ce pays (${name}, ${dial}).`,
    tooLong: (name: string, dial: string) =>
      `Ce numéro a trop de chiffres pour ce pays (${name}, ${dial}).`,
    invalid: (name: string, dial: string) =>
      `Ce numéro ne semble pas valide pour ce pays (${name}, ${dial}). Vérifiez les chiffres ou changez de pays.`,
  },
} as const;

/**
 * Ce que dit le champ quand le schéma refuse le numéro — critère 6 de #825 :
 * le message dit **quoi faire**, et pour quel pays.
 *
 * Le pays est celui du **drapeau**, que seul le champ connaît : `+1` sert les
 * États-Unis comme le Canada, et un numéro canadien mal tapé ne doit pas se
 * voir reprocher d'être invalide « pour les États-Unis ».
 *
 * La longueur est distinguée du reste parce qu'elle appelle un autre geste :
 * compléter un numéro n'est pas la même correction que changer de pays.
 */
export function phoneInvalidMessage(
  value: string,
  country: CountryCode,
  locale: PhoneLocale,
): string {
  const messages = MESSAGES[locale];
  const name = countryName(country, locale);
  const dial = dialCode(country);
  const length = value === '' ? undefined : validatePhoneNumberLength(value, country);

  if (length === 'TOO_SHORT' || length === 'NOT_A_NUMBER') {
    return messages.tooShort(name, dial);
  }

  if (length === 'TOO_LONG') {
    return messages.tooLong(name, dial);
  }

  return messages.invalid(name, dial);
}
