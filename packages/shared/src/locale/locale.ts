/**
 * La langue du produit — #844, première fondation de l'épique #843.
 *
 * ## Une seule définition, et c'est celle-ci
 *
 * `Locale` est déclaré ici et **nulle part ailleurs** : ni dans un `enum` Prisma,
 * ni dans un `type Langue` d'`apps/web`, ni dans une constante de module API.
 * C'est le premier critère d'acceptation de #844, et ce n'est pas une préférence
 * d'organisation : quatorze tickets de l'épique vont consommer ce vocabulaire —
 * le parcours public, l'espace client, le back-office, la console, les
 * notifications —, et deux écritures auraient divergé au premier ajout. Le jour
 * où une troisième langue s'ajoutera, une ligne de ce fichier suffira à la
 * déclarer, et le `tsc` nommera tout ce qui doit suivre.
 *
 * ## Pourquoi une famille à part, et non `common/`
 *
 * `common/` porte les primitives que **tout** le contrat manipule — un montant,
 * un instant, un identifiant. La langue est d'une autre nature : elle ne décrit
 * aucune donnée métier, elle décrit la **présentation** de toutes. L'épique #843
 * lui adjoindra de quoi négocier une langue depuis un en-tête et de quoi nommer
 * ses libellés ; ces ajouts-là ont leur place à côté de celui-ci, pas dilués
 * entre les heures murales et les codes devise.
 *
 * ## Le vocabulaire, en minuscules
 *
 * `fr` et `en` — les étiquettes BCP 47, telles qu'un en-tête `Accept-Language`
 * et un attribut `<html lang>` les écrivent. Pas de `FR`/`EN` : la casse
 * divergente entre une énumération PostgreSQL et le contrat est exactement ce qui
 * a coûté au vocabulaire des rôles sa conversion de frontière
 * (`receivedUserRoleSchema`, #510), et il n'y a aucune raison de reproduire ici
 * une dette dont l'autre bout est encore ouvert. La colonne stocke donc la
 * minuscule telle quelle, bornée par une contrainte `CHECK` plutôt que par un
 * type énuméré — voir la migration `20260919140000_add_locale_preferences`.
 *
 * Pas de variantes régionales non plus — ni `fr-CA`, ni `en-US`. Le CDC ne
 * demande que deux langues (#842), et une étiquette régionale poserait aussitôt
 * la question du repli (`fr-CA` absent, sert-on `fr` ?) dont le MVP n'a pas
 * besoin. Le format des dates et des montants, lui, ne se déduit pas de la
 * langue : il suit le fuseau et la devise de l'établissement, qui ont déjà leurs
 * colonnes.
 */

import { z } from 'zod';

/**
 * Les langues que le produit sert, dans l'ordre où elles se présentent à
 * l'écran.
 *
 * `as const` plutôt qu'un `string[]` : c'est ce qui donne à `z.enum` un
 * littéral de type, donc à `Locale` ses deux valeurs plutôt que `string`.
 */
export const LOCALES = ['fr', 'en'] as const;

/**
 * La langue d'un établissement ou d'un compte.
 *
 * Refuse tout ce qui n'est pas exactement `fr` ou `en` — `de`, `FR`, `fr-CA`,
 * `""`. Le refus sort en **400** par le `ZodValidationPipe` de l'API, avec le
 * code `VALIDATION_ERROR` du contrat (`TRANSPORT_ERROR_CODES`) et le champ nommé
 * dans `details.violations` : c'est le neuvième critère d'acceptation de #844.
 *
 * Le message est écrit pour être lu par la personne qui a saisi, pas par la
 * console : « Invalid enum value. Expected 'fr' | 'en' » est le défaut de Zod, et
 * il remonterait tel quel jusqu'au formulaire de réglages.
 */
export const localeSchema = z.enum(LOCALES, {
  errorMap: () => ({ message: `langue attendue parmi ${LOCALES.join(', ')}` }),
});

export type Locale = z.infer<typeof localeSchema>;

/**
 * La langue par défaut du **système** — décision du PO du 2026-09-19.
 *
 * `en`, parce que la clientèle du produit est nord-américaine : un salon qui
 * n'exprime rien doit s'ouvrir en anglais, et les établissements déjà en base
 * sont migrés à cette valeur-là. Le français reste une option que
 * l'établissement choisit, jamais un défaut qu'il subit.
 *
 * Déclarée ici plutôt que recopiée dans chaque point de création : l'inscription
 * libre-service (ADR 0016), l'ouverture depuis la console (ADR 0012), le seed et
 * la colonne `tenants.default_locale` doivent tomber d'accord, et trois
 * littéraux `'en'` dispersés n'auraient pas bougé ensemble le jour où la
 * décision change.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * `true` si `value` est l'une des deux langues du contrat.
 *
 * Le prédicat plutôt que le schéma là où il n'y a pas de message à rendre : une
 * garde de type dans un service, un filtre sur une valeur déjà lue en base. Les
 * deux frontières doivent refuser les mêmes valeurs, et c'est `LOCALES` qui les
 * met d'accord.
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * La langue **telle qu'on la soumet** — casse et espaces normalisés avant d'être
 * jugés.
 *
 * `« FR »`, `« fr »` et `« fr »` avec une espace surnuméraire désignent la même
 * langue, et une étiquette BCP 47 se recopie d'un en-tête `Accept-Language` ou
 * d'un sélecteur de navigateur, où la casse n'est pas normalisée. Même arbitrage
 * que `submittedLegalIdTypeSchema` et que le code pays d'une adresse : on refuse
 * une saisie qui n'a aucun sens, on corrige une saisie qui n'en a qu'un.
 *
 * Distinct de `localeSchema`, qui décrit la **sortie** : ce que l'API émet est
 * déjà canonique, et lui faire traverser un `toLowerCase` laisserait croire que
 * la valeur enregistrée pourrait ne pas l'être. La contrainte `CHECK` de la base
 * garantit qu'elle l'est.
 */
export const submittedLocaleSchema = z.string().trim().toLowerCase().pipe(localeSchema);
