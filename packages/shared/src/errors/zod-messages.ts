/**
 * Les messages de validation des formulaires, dans les deux langues — #845.
 *
 * ## Le problème que cela résout
 *
 * Les schémas du contrat sont partagés entre l'API et les formulaires du front
 * (`@hookform/resolvers` + zod). Leurs refus s'affichaient donc en anglais brut
 * de zod — *« String must contain at least 1 character(s) »* — ou en français
 * écrit à la main dans un `errorMap` par schéma. Ni l'un ni l'autre ne se
 * traduit : le premier n'est pas une phrase, le second n'existe que dans une
 * langue.
 *
 * ## Une carte d'erreurs, et non une clé par champ
 *
 * Zod expose un point d'extension unique — `errorMap` — appelé pour **tout**
 * refus, avec le code d'`issue` et ses bornes. Une fonction de vingt lignes
 * couvre donc les refus de tous les formulaires du produit, présents et à venir,
 * là où une clé de catalogue par champ aurait demandé à chaque ticket d'écran de
 * traduire les mêmes six phrases.
 *
 * Elle se pose **par appel** et non globalement (`z.setErrorMap`) : le serveur
 * rend des pages dans deux langues en même temps, et un état de module partagé
 * ferait afficher la langue du dernier visiteur au suivant. Les deux formes
 * d'emploi :
 *
 * ```ts
 * schema.safeParse(value, { errorMap: zodErrorMap(locale) });
 * zodResolver(schema, { errorMap: zodErrorMap(locale) });   // react-hook-form
 * ```
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle ne traduit pas les messages que les schémas écrivent eux-mêmes : un
 * `errorMap` posé sur un schéma précis — `localeSchema`, `submittedLegalIdType` —
 * gagne sur celui-ci, par conception de zod. C'est voulu : ces messages-là
 * nomment une valeur attendue du contrat, et leur place est auprès du schéma qui
 * la déclare.
 */

import { z } from 'zod';

import type { Locale } from '../locale/index';

/** Les tournures dont dépendent les bornes — « au moins 3 caractères ». */
interface Phrases {
  readonly required: string;
  readonly invalid: string;
  readonly email: string;
  readonly url: string;
  readonly uuid: string;
  readonly date: string;
  readonly number: string;
  readonly integer: string;
  readonly choice: string;
  readonly tooShort: (min: number) => string;
  readonly tooLong: (max: number) => string;
  readonly tooSmall: (min: number) => string;
  readonly tooBig: (max: number) => string;
  readonly tooFew: (min: number) => string;
  readonly tooMany: (max: number) => string;
}

const PHRASES: Readonly<Record<Locale, Phrases>> = {
  fr: {
    required: 'Ce champ est obligatoire.',
    invalid: 'Cette valeur n’est pas valable.',
    email: 'Saisissez une adresse e-mail valable.',
    url: 'Saisissez une adresse web valable.',
    uuid: 'Cet identifiant n’est pas valable.',
    date: 'Saisissez une date valable.',
    number: 'Saisissez un nombre.',
    integer: 'Saisissez un nombre entier.',
    choice: 'Choisissez une des options proposées.',
    tooShort: (min) => `Saisissez au moins ${String(min)} caractère${min > 1 ? 's' : ''}.`,
    tooLong: (max) => `Ne dépassez pas ${String(max)} caractère${max > 1 ? 's' : ''}.`,
    tooSmall: (min) => `La valeur minimale est ${String(min)}.`,
    tooBig: (max) => `La valeur maximale est ${String(max)}.`,
    tooFew: (min) => `Sélectionnez au moins ${String(min)} élément${min > 1 ? 's' : ''}.`,
    tooMany: (max) => `Ne sélectionnez pas plus de ${String(max)} élément${max > 1 ? 's' : ''}.`,
  },
  en: {
    required: 'This field is required.',
    invalid: 'This value is not valid.',
    email: 'Enter a valid email address.',
    url: 'Enter a valid web address.',
    uuid: 'This identifier is not valid.',
    date: 'Enter a valid date.',
    number: 'Enter a number.',
    integer: 'Enter a whole number.',
    choice: 'Choose one of the available options.',
    tooShort: (min) => `Enter at least ${String(min)} character${min > 1 ? 's' : ''}.`,
    tooLong: (max) => `Use at most ${String(max)} character${max > 1 ? 's' : ''}.`,
    tooSmall: (min) => `The smallest allowed value is ${String(min)}.`,
    tooBig: (max) => `The largest allowed value is ${String(max)}.`,
    tooFew: (min) => `Select at least ${String(min)} item${min > 1 ? 's' : ''}.`,
    tooMany: (max) => `Select at most ${String(max)} item${max > 1 ? 's' : ''}.`,
  },
};

/** Les tournures d'une langue — exportées pour les tests, et pour un message ad hoc. */
export function validationPhrases(locale: Locale): Phrases {
  return PHRASES[locale];
}

/**
 * La carte d'erreurs de zod dans la langue demandée.
 *
 * Le repli est `ctx.defaultError` et non une phrase inventée : un refus que
 * cette carte ne connaît pas — `invalid_intersection_types`, un `refine` sans
 * message — n'est pas un refus de saisie mais un défaut de schéma, et le message
 * de zod est ce qui permet de le diagnostiquer. Le remplacer par « cette valeur
 * n'est pas valable » effacerait la seule trace utile.
 */
export function zodErrorMap(locale: Locale): z.ZodErrorMap {
  const phrases = PHRASES[locale];

  return (issue, ctx) => {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        // `undefined` et `null` reçus là où une valeur est attendue : c'est un
        // champ vide, pas un type faux. Les distinguer est ce qui évite
        // d'annoncer « saisissez un nombre » sur un champ qu'on n'a pas rempli.
        if (issue.received === 'undefined' || issue.received === 'null') {
          return { message: phrases.required };
        }

        if (issue.expected === 'number') {
          return { message: phrases.number };
        }

        if (issue.expected === 'integer') {
          return { message: phrases.integer };
        }

        if (issue.expected === 'date') {
          return { message: phrases.date };
        }

        return { message: phrases.invalid };

      case z.ZodIssueCode.invalid_string:
        if (issue.validation === 'email') {
          return { message: phrases.email };
        }

        if (issue.validation === 'url') {
          return { message: phrases.url };
        }

        if (issue.validation === 'uuid') {
          return { message: phrases.uuid };
        }

        if (issue.validation === 'datetime' || issue.validation === 'date') {
          return { message: phrases.date };
        }

        return { message: phrases.invalid };

      case z.ZodIssueCode.too_small: {
        const min = Number(issue.minimum);

        if (issue.type === 'string') {
          // Un minimum de 1 caractère est la façon dont zod exprime « non
          // vide » : la phrase attendue est celle du champ obligatoire, pas une
          // leçon de comptage.
          return { message: min <= 1 ? phrases.required : phrases.tooShort(min) };
        }

        if (issue.type === 'array' || issue.type === 'set') {
          return { message: min <= 1 ? phrases.required : phrases.tooFew(min) };
        }

        return { message: phrases.tooSmall(min) };
      }

      case z.ZodIssueCode.too_big: {
        const max = Number(issue.maximum);

        if (issue.type === 'string') {
          return { message: phrases.tooLong(max) };
        }

        if (issue.type === 'array' || issue.type === 'set') {
          return { message: phrases.tooMany(max) };
        }

        return { message: phrases.tooBig(max) };
      }

      case z.ZodIssueCode.invalid_enum_value:
      case z.ZodIssueCode.invalid_literal:
      case z.ZodIssueCode.invalid_union_discriminator:
        return { message: phrases.choice };

      case z.ZodIssueCode.invalid_date:
        return { message: phrases.date };

      case z.ZodIssueCode.not_multiple_of:
      case z.ZodIssueCode.not_finite:
        return { message: phrases.number };

      case z.ZodIssueCode.invalid_union:
        return { message: phrases.invalid };

      default:
        return { message: ctx.defaultError };
    }
  };
}
