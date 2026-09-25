import type { Locale } from '@spa/shared';

import { doublureCrochets, doublureServeur } from './traducteur';

/**
 * Une langue **figée**, autre que celle de l'amorce — #1283.
 *
 * ## Pourquoi ce fichier existe
 *
 * L'amorce fixe la langue de toutes les suites à `fr`
 * (`tests/support/next-intl.ts`) : c'est celle dans laquelle elles ont été
 * écrites. Une suite qui éprouve un écran **en anglais** doit donc la remplacer,
 * et chacune s'écrivait pour cela son propre `vi.mock` — autant de copies du
 * même mécanisme, chacune remontant son formateur ICU, que rien n'empêchait de
 * diverger.
 *
 * Elles sont ici, écrites une fois. Leur corps — le remplacement du module, le
 * formateur ICU, sa mémoïsation — est celui que partagent les trois manières de
 * poser une langue (`tests/support/traducteur.ts`) ; ce fichier n'a plus à lui
 * que le fait que la langue soit **une constante**. L'amorce elle-même n'est
 * rien d'autre que ces doublures appliquées à `fr` : elle les emploie.
 *
 * Le compte est soldé depuis #1287 : plus aucune suite de `tests/unit/` ne monte
 * la sienne. Les suites à langue constante passent par ce fichier
 * (`admin-catalog-i18n`, `admin-clients-i18n`, `validation-i18n`,
 * `admin-staff-i18n`, `admin-planning-i18n`, `admin-reporting-i18n`,
 * `admin-my-planning-i18n`, `admin-checkout-i18n`, `platform-console-i18n`),
 * celles dont la langue bouge par `langue-mobile.ts`. Une nouvelle suite
 * anglaise se branche ici plutôt que de recopier une fabrique.
 *
 * ## Figée, et non mobile
 *
 * Une suite qui compare la **même** brique dans les deux langues a besoin d'une
 * langue qui bouge entre deux `render()` : c'est `langue-mobile.ts` et son
 * `fixerLangue()`. Ici la langue est celle du paramètre, du premier rendu au
 * dernier — une suite entière écrite en anglais n'a rien à déplacer, et une
 * variable mutable n'y serait qu'un risque de fuite d'un test sur l'autre.
 *
 * ## L'emploi
 *
 * ```ts
 * vi.mock('next-intl', () => nextIntlFixe('en'));
 * vi.mock('next-intl/server', () => nextIntlServerFixe('en'));
 * ```
 *
 * Une suite ne pose que la doublure dont elle a besoin : celle des crochets pour
 * un composant client, celle du serveur pour un Server Component asynchrone ou
 * une action serveur, les deux pour un Server Component qui monte un Client
 * Component.
 */

/** La doublure de `next-intl` — les **crochets** —, dans la langue donnée. */
export function nextIntlFixe(locale: Locale): Promise<Record<string, unknown>> {
  return doublureCrochets(() => locale);
}

/**
 * La doublure de `next-intl/server` — ce que lisent les Server Components
 * asynchrones et les actions serveur —, dans la langue donnée.
 */
export function nextIntlServerFixe(locale: Locale): Promise<Record<string, unknown>> {
  return doublureServeur(() => locale);
}
