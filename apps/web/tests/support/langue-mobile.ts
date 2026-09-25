import type { Locale } from '@spa/shared';

import { doublureCrochets, doublureServeur } from './traducteur';

/**
 * Une langue **mobile** pour les suites qui rendent la même brique dans les deux
 * langues — #1192.
 *
 * ## Pourquoi ce fichier existe
 *
 * L'amorce des suites fixe la langue à `fr` pour toutes
 * (`tests/support/next-intl.ts`), et `admin-catalog-i18n.test.tsx` la fixe à `en`
 * pour la sienne. Une suite qui veut comparer le **même** composant dans les deux
 * langues ne peut faire ni l'un ni l'autre : il lui faut une langue qui bouge entre
 * deux `render()`. Poser un `NextIntlClientProvider` autour du rendu n'y suffirait
 * pas — l'amorce remplace `useTranslations` lui-même, contexte compris.
 *
 * D'où cette doublure, écrite **une fois** : plusieurs suites la partagent, là où
 * deux copies du même `vi.mock` se seraient mises à diverger — et l'une aurait
 * alors mesuré autre chose que l'autre.
 *
 * ## Deux points d'entrée, une seule langue (#1277)
 *
 * `next-intl` sert les **crochets** — `useTranslations`, `useLocale` —, que seul
 * un Client Component peut appeler. Un Server Component asynchrone ou une action
 * serveur lit ses messages par `getTranslations` de `next-intl/server`, que
 * l'amorce fige elle aussi à `fr`. Les deux doublures mobiles sont donc ici,
 * `nextIntlMobile()` et `nextIntlServerMobile()`, sur la **même** variable
 * `langue` et le **même** formateur ICU mémoïsé.
 *
 * C'est ce que deux suites de #1233 s'écrivaient chacune à l'identique
 * (`home-open-salon-action`, `home-photos-i18n`) — la seconde devant en outre
 * tenir deux variables de langue en phase à la main, faute de quoi les crochets
 * seraient passés en anglais pendant que le Server Component serait resté en
 * français. Un seul `fixerLangue()` déplace désormais les deux.
 *
 * Ni ce formateur ni le corps de ces deux doublures ne sont plus écrits ici
 * (#1283) : ils sont ceux de `tests/support/traducteur.ts`, que l'amorce et la
 * langue figée emploient à l'identique. Ce fichier n'a plus qu'une chose à lui :
 * la variable `langue`, et le fait qu'elle bouge — les doublures partagées
 * relisent `lireLangue` à chaque appel, c'est ce qui la laisse bouger entre deux
 * `render()`.
 *
 * ## L'emploi
 *
 * ```ts
 * vi.mock('next-intl', () => nextIntlMobile());
 * vi.mock('next-intl/server', () => nextIntlServerMobile());
 *
 * it('…', () => {
 *   fixerLangue('en');
 *   render(<Badge … />);
 * });
 * afterEach(() => fixerLangue('fr'));
 * ```
 *
 * Une suite ne pose que la doublure dont elle a besoin : celle des crochets pour
 * un composant client, celle du serveur pour une action, les deux pour un Server
 * Component qui monte un Client Component.
 *
 * Le `vi.mock` est hissé au sommet du module, mais sa fabrique n'est évaluée qu'au
 * premier import du module doublé : la langue posée par un test est donc bien
 * celle que le rendu lit.
 */

/** La langue du rendu, partagée par les deux doublures et par la suite qui les pilote. */
let langue: Locale = 'fr';

/** Pose la langue des rendus suivants. À remettre à `fr` en `afterEach`. */
export function fixerLangue(prochaine: Locale): void {
  langue = prochaine;
}

/**
 * La langue posée à cet instant — pour les **autres** doublures d'une suite.
 *
 * Une suite ne double pas que `next-intl` : `transverse-i18n` double aussi
 * `next/headers`, parce que c'est là que `lib/api-client.ts` lit la langue de la
 * requête, et le cookie qu'elle rend doit porter la même langue que le rendu. Y
 * tenir une seconde variable la remettrait exactement dans la situation que
 * `nextIntlServerMobile()` a retirée en #1277 : deux langues à garder en phase à
 * la main, dont l'une finit par diverger sans que rien ne le dise.
 */
export function langueCourante(): Locale {
  return langue;
}

/** La doublure de `next-intl` — les **crochets** —, sur la langue mobile. */
export function nextIntlMobile(): Promise<Record<string, unknown>> {
  return doublureCrochets(() => langue);
}

/**
 * La doublure de `next-intl/server` — ce que lisent les Server Components
 * asynchrones et les actions serveur (#1277) —, sur la **même** langue mobile
 * que les crochets : un seul `fixerLangue()` déplace les deux.
 */
export function nextIntlServerMobile(): Promise<Record<string, unknown>> {
  return doublureServeur(() => langue);
}
