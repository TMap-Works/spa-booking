/**
 * Les codes pays **réellement attribués** par l'ISO 3166-1 alpha-2 — #1330.
 *
 * ## Pourquoi une liste, alors qu'un motif suffisait
 *
 * `COUNTRY_CODE_PATTERN` (`/^[A-Z]{2}$/`) décrit la *forme* d'un code pays, pas
 * son existence : « ZZ » a la forme et n'est aucun pays. C'est exactement ce que
 * la recette de #1330 a enregistré dans les réglages d'un salon — une colonne
 * `tenants.country_code` à « ZZ », dont `Intl.DisplayNames` ne sait rien dire, et
 * qui décide pourtant du pays par défaut d'un numéro national
 * (`e164PhoneSchemaFor`), de l'ordre d'affichage de l'adresse et du nom de pays
 * imprimé sur un ticket. Une valeur qui n'existe pas ne se rattrape nulle part en
 * aval : elle se refuse à la saisie.
 *
 * ## Pourquoi une table figée, et non `Intl`
 *
 * La plateforme sait nommer les pays (`Intl.DisplayNames`), mais elle ne sait pas
 * les **énumérer** : `Intl.supportedValuesOf` accepte `calendar`, `collation`,
 * `currency`, `numberingSystem`, `timeZone` et `unit` — jamais `region`. Et le
 * détour « le nom rendu diffère du code, donc le code existe » n'est pas une
 * validation : `of()` rend le code tel quel pour un code inconnu *comme* pour un
 * pays dont la langue lue n'a pas de nom, si bien que la règle dépendrait des
 * données ICU embarquées dans le Node du jour. Un serveur qui accepte ou refuse
 * une adresse selon sa version d'ICU est pire qu'un serveur permissif.
 *
 * C'est l'arbitrage inverse de celui de `countryLabel` (#1105) — et il n'est pas
 * contradictoire : **nommer** est de la présentation, qui a le droit de suivre le
 * moteur ; **valider** est une règle de données, qui doit être la même partout et
 * pour toujours.
 *
 * ## Ce que la liste contient, et ce qu'elle ne contient pas
 *
 * Les 249 codes **officiellement attribués** (*officially assigned*) de la norme,
 * à l'exclusion des codes réservés, transitoirement réservés et d'usage
 * indéterminé — dont la plage `AA`, `QM`–`QZ`, `XA`–`XZ` et `ZZ` réservée à
 * l'usage privé, qui est précisément celle du code enregistré par accident.
 *
 * Elle est stable par construction : l'ISO n'attribue un code que par
 * modification de la norme, à un rythme de l'ordre d'une entrée par décennie. La
 * maintenir n'est pas une dette, c'est une relecture.
 */

/**
 * Les codes attribués, triés — l'ordre rend un diff lisible le jour où l'ISO
 * ajoute ou retire une entrée.
 */
export const ISO_3166_1_ALPHA_2_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR',
  'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE',
  'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ',
  'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD',
  'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
  'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
  'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS',
  'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
  'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK',
  'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
  'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
  'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU',
  'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
  'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS',
  'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
  'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK',
  'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA',
  'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

export type IsoCountryCode = (typeof ISO_3166_1_ALPHA_2_CODES)[number];

/**
 * L'ensemble, monté une fois — un `Set` et non un `includes` sur un tableau de
 * deux cent quarante-neuf entrées : la validation d'une adresse est sur le chemin
 * d'une inscription de salon comme sur celui de chaque enregistrement de
 * réglages.
 */
const ASSIGNED: ReadonlySet<string> = new Set(ISO_3166_1_ALPHA_2_CODES);

/**
 * `true` si ce code est un pays attribué par l'ISO 3166-1 alpha-2.
 *
 * **Sensible à la casse, et volontairement** : la norme écrit ces codes en
 * majuscules, la colonne porte une borne `CHECK` sur les majuscules, et la
 * normalisation appartient au schéma ou au DTO qui lit la saisie — pas à ce
 * prédicat. Un prédicat qui normaliserait de son côté aurait laissé passer une
 * valeur en minuscules jusqu'à la base, où la contrainte l'aurait refusée en 500
 * plutôt qu'en 400.
 */
export function isCountryCodeAlpha2(value: string): value is IsoCountryCode {
  return ASSIGNED.has(value);
}
