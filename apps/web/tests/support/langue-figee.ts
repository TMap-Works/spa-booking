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
 * et trois d'entre elles s'écrivaient pour cela leur propre `vi.mock` —
 * `admin-catalog-i18n`, `admin-clients-i18n`, `validation-i18n`. Trois copies du
 * même mécanisme, chacune remontant son formateur ICU, que rien n'empêchait de
 * diverger.
 *
 * Elles sont ici, écrites une fois. Leur corps — le remplacement du module, le
 * formateur ICU, sa mémoïsation — est celui que partagent les trois manières de
 * poser une langue (`tests/support/traducteur.ts`) ; ce fichier n'a plus à lui
 * que le fait que la langue soit **une constante**. L'amorce elle-même n'est
 * rien d'autre que ces doublures appliquées à `fr` : elle les emploie.
 *
 * Il reste, hors de ce dispositif, une douzaine de suites qui montent encore
 * leur propre `vi.mock('next-intl', …)` à la main — `admin-staff-i18n`,
 * `admin-planning-i18n`, `transverse-i18n` et les autres. Elles se rebranchent
 * ici sans rien changer à ce qu'elles éprouvent ; ce ticket n'en a converti que
 * trois.
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
