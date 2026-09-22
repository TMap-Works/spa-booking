import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from '@spa/shared';

/**
 * La règle de résolution de la langue — #845, l'épique #843.
 *
 * ## Ce que ce module contient, et pourquoi il ne lit rien
 *
 * Des **fonctions pures**. Ni cookie, ni en-tête, ni appel réseau : elles
 * reçoivent des signaux déjà lus et rendent une langue. C'est ce qui rend chaque
 * étape de l'ordre vérifiable sans serveur — le cinquième critère d'acceptation
 * de #845 exige un test par étape, et un test qui doit monter une requête HTTP
 * pour éprouver une priorité n'éprouve pas la priorité.
 *
 * La lecture des signaux vit dans `server.ts`, qui n'existe que côté serveur.
 *
 * ## L'ordre, et pourquoi il est celui-là
 *
 * 1. **Le choix explicite** — le sélecteur de langue. Ce qu'une personne a
 *    demandé gagne sur tout ce qu'on pourrait deviner d'elle, et le garde d'une
 *    visite à l'autre (cookie d'un an).
 * 2. **Le compte** — la préférence enregistrée (`users.locale`, #844). Elle vaut
 *    pour tous les appareils, là où le cookie ne vaut que pour celui-ci.
 * 3. **`Accept-Language`** — ce que le navigateur annonce. C'est le signal de qui
 *    n'a rien demandé et n'a pas de compte : un navigateur réglé en français
 *    obtient le français d'emblée.
 * 4. **L'établissement** — `Tenant.defaultLocale` (#844). Un salon québécois
 *    ouvre en français pour un visiteur dont le navigateur ne dit rien
 *    d'exploitable.
 * 5. **`en`** — la langue par défaut du système (`DEFAULT_LOCALE`, décision du PO
 *    du 2026-09-19 : la clientèle est nord-américaine).
 *
 * Chaque étape est franchie dès qu'elle rend une valeur **reconnue** : une
 * préférence illisible — un cookie trafiqué, un `Accept-Language` exotique — ne
 * bloque pas la suivante, elle n'existe simplement pas.
 */

/**
 * Les signaux dont dépend la langue, dans l'ordre où ils sont consultés.
 *
 * Tous en `string | null | undefined` et non en `Locale` : ils viennent du
 * navigateur, d'un cookie ou d'une réponse d'API, et **rien ne garantit** qu'ils
 * portent une des deux langues du contrat. C'est précisément le travail de ce
 * module de trancher, et le typer sur `Locale` aurait déplacé la question chez
 * l'appelant — c'est-à-dire à cinq endroits au lieu d'un.
 */
export interface LocaleSignals {
  /** Le choix du sélecteur de langue, conservé d'une visite à l'autre. */
  readonly explicit?: string | null | undefined;
  /** La préférence du compte connecté (`users.locale`). */
  readonly account?: string | null | undefined;
  /** L'en-tête `Accept-Language` de la requête, brut. */
  readonly acceptLanguage?: string | null | undefined;
  /** `Tenant.defaultLocale` de l'établissement visité. */
  readonly tenant?: string | null | undefined;
}

/** La langue à servir, sur la foi de ces signaux. Ne rend jamais `null`. */
export function resolveLocale(signals: LocaleSignals): Locale {
  const explicit = asLocale(signals.explicit);

  if (explicit !== null) {
    return explicit;
  }

  const account = asLocale(signals.account);

  if (account !== null) {
    return account;
  }

  const negotiated = negotiateLocale(signals.acceptLanguage);

  if (negotiated !== null) {
    return negotiated;
  }

  return asLocale(signals.tenant) ?? DEFAULT_LOCALE;
}

/**
 * La langue portée par cette valeur, ou `null`.
 *
 * La casse et les espaces sont normalisés, comme le fait `submittedLocaleSchema`
 * du contrat : un cookie recopié à la main ou un en-tête écrit `FR` désigne bien
 * le français. Ce qui n'est pas une des deux langues, en revanche, ne se corrige
 * pas — il s'ignore.
 */
export function asLocale(value: string | null | undefined): Locale | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  return isLocale(normalized) ? normalized : null;
}

/**
 * La langue préférée annoncée par le navigateur, ou `null` si aucune n'est
 * servie.
 *
 * ## Ce que l'en-tête contient vraiment
 *
 * `fr-CA,fr;q=0.9,en-US;q=0.8,*;q=0.5` — une liste de préférences pondérées, par
 * ordre de qualité décroissante. Trois choses s'en lisent, et chacune a coûté un
 * défaut ailleurs :
 *
 * - **la variante régionale compte pour sa langue** : `fr-CA` demande du
 *   français. Ne comparer que les étiquettes exactes aurait servi l'anglais à
 *   tout le Québec ;
 * - **le poids `q=0` est un refus**, pas une préférence faible (RFC 9110 §12.5.4) ;
 * - **`*` n'est pas une langue** : il dit « n'importe laquelle », ce qui est la
 *   question, pas la réponse. On le laisse donc aux étapes suivantes de l'ordre.
 *
 * L'ordre d'écriture départage deux poids égaux — c'est ce que fait tout
 * négociateur de contenu, et c'est ce qu'attend un navigateur qui écrit ses
 * langues dans l'ordre où l'utilisateur les a rangées.
 */
export function negotiateLocale(header: string | null | undefined): Locale | null {
  if (header === null || header === undefined || header.trim() === '') {
    return null;
  }

  const ranked = header
    .split(',')
    .map((part, index) => parseRange(part, index))
    .filter((range): range is LanguageRange => range !== null)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const range of ranked) {
    // La langue d'une étiquette BCP 47 est son premier sous-marqueur : `fr` de
    // `fr-CA`, `en` de `en-US`.
    const [language = ''] = range.tag.split('-');

    if (isLocale(language)) {
      return language;
    }
  }

  return null;
}

interface LanguageRange {
  readonly tag: string;
  readonly quality: number;
  /** Le rang d'écriture — il départage deux poids égaux. */
  readonly index: number;
}

function parseRange(part: string, index: number): LanguageRange | null {
  const [rawTag = '', ...parameters] = part.split(';');
  const tag = rawTag.trim().toLowerCase();

  if (tag === '' || tag === '*') {
    return null;
  }

  const quality = parseQuality(parameters);

  // `q=0` dit « surtout pas celle-ci ». La servir quand même serait lire
  // l'en-tête à l'envers.
  return quality <= 0 ? null : { tag, quality, index };
}

function parseQuality(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name = '', value = ''] = parameter.split('=');

    if (name.trim().toLowerCase() !== 'q') {
      continue;
    }

    const quality = Number.parseFloat(value.trim());

    // Un poids illisible ne vaut pas un refus : l'en-tête reste exploitable, et
    // la valeur par défaut de la RFC est 1.
    return Number.isFinite(quality) ? quality : 1;
  }

  return 1;
}

/** Les langues servies, dans l'ordre où le sélecteur les présente. */
export const SUPPORTED_LOCALES: readonly Locale[] = LOCALES;
