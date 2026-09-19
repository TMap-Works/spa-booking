import { DEFAULT_LOCALE, type Locale, isLocale } from '@spa/shared';

/**
 * Le passage de la colonne au contrat, pour les deux langues du produit (#844).
 *
 * ## Pourquoi il faut une conversion du tout
 *
 * `tenants.default_locale` et `users.locale` sont des `VARCHAR(5)`, et Prisma
 * les type donc `string` / `string | null`. Le contrat, lui, ne connaît que
 * `Locale` — `'fr' | 'en'`. Le vocabulaire est tenu en base par
 * `tenants_default_locale_check` et `users_locale_check`, mais une contrainte
 * `CHECK` n'est pas une information du système de types : quelqu'un doit dire au
 * compilateur ce que la base garantit déjà.
 *
 * Le dire par un `as Locale` nu aurait été plus court et faux dans le seul cas
 * qui compte — une valeur qui aurait échappé à la contrainte sortirait telle
 * quelle dans une réponse d'API, où le front la rejetterait en validation. Même
 * frontière, et même geste, que la conversion de `billingStatus` dans
 * `findCurrentTenantBilling` ; ici le prédicat de `@spa/shared` remplace le `as`,
 * ce qui rend la garantie exécutable.
 */

/**
 * La langue d'un établissement, **toujours** rendue.
 *
 * La colonne est `NOT NULL` avec un défaut : en pratique cette fonction rend
 * toujours ce qu'elle lit. Le repli sur `DEFAULT_LOCALE` couvre le seul cas
 * qu'elle ne peut pas exclure — une valeur posée hors de l'application, par une
 * main sur la base — et il **sert la vitrine** plutôt que de la casser : un
 * salon dont la langue serait illisible doit continuer d'être servi, dans la
 * langue par défaut du système, pas rendre 500.
 */
export function toTenantLocale(value: string): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * La préférence d'un compte, ou `null` — « aucune préférence enregistrée ».
 *
 * Le repli est `null` et non `DEFAULT_LOCALE`, et la nuance est celle que la
 * colonne porte : inventer une préférence ferait paraître choisie une langue que
 * personne n'a demandée, et le lecteur — page, notification — n'aurait plus
 * aucun moyen de retomber sur celle de l'établissement.
 */
export function toAccountLocale(value: string | null): Locale | null {
  return value !== null && isLocale(value) ? value : null;
}
