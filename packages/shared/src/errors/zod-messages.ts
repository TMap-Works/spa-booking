/**
 * Les messages de validation des formulaires, dans les deux langues — #845,
 * complété par #1232 puis par #1309.
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
 * Elle se pose **par appel** partout où une langue est connue : le serveur rend
 * des pages dans deux langues en même temps, et s'en remettre à un état de
 * module partagé ferait afficher la langue du dernier visiteur au suivant. La
 * carte globale posée en fin de ce module (voir « Le repli » ci-dessous) ne sert
 * donc que là où personne n'a de langue à demander — une carte contextuelle
 * l'emporte toujours sur elle. Les deux formes d'emploi :
 *
 * ```ts
 * schema.safeParse(value, { errorMap: zodErrorMap(locale) });
 * zodResolver(schema, { errorMap: zodErrorMap(locale) });   // react-hook-form
 * ```
 *
 * ## Ce que #1232 ajoute : les refus que seul le schéma sait nommer
 *
 * Les bornes génériques ci-dessus ne disent rien de « deux plages d'ouverture du
 * même jour se recouvrent » ni de « numéro de téléphone incomplet ». Ces
 * refus-là étaient écrits **en français, en dur, dans le schéma** — une
 * cinquantaine de phrases —, et un message posé sur un check l'emporte sur toute
 * carte d'erreurs, par conception de zod (`makeIssue` court-circuite les
 * `errorMaps` dès que l'`issue` porte un `message`). Ils s'affichaient donc en
 * français sur les écrans anglais, et aucune carte ne pouvait les rattraper.
 *
 * Le schéma ne porte donc plus de phrase mais une **clé** — `messageKey(…)`,
 * posée dans les `params` d'une `issue` `custom` —, et c'est cette carte-ci qui
 * la traduit, dans la langue qu'on lui donne. Le vocabulaire est fermé
 * (`VALIDATION_MESSAGE_KEYS`) et les deux tables sont annotées
 * `Record<ValidationMessageKey, …>` : une clé ajoutée sans sa traduction fait
 * échouer `tsc`, exactement comme dans `error-messages.ts` — la garantie est
 * structurelle, pas déclarative.
 *
 * ## Le repli, et pourquoi il est en français
 *
 * Une `issue` sans message et sans carte contextuelle retombe sur la carte
 * **globale** de zod. Sans elle, une clé se lirait « Invalid input » dans les
 * journaux de l'API et dans `details.violations` — c'est-à-dire que le
 * diagnostic disparaîtrait au moment même où il sert. Ce module en pose donc une
 * à son chargement, dans `DIAGNOSTIC_LOCALE`.
 *
 * Elle est **en français**, et ce n'est pas un défaut de i18n : c'est la langue
 * des diagnostics de ce dépôt — tous les messages de `DomainError` le sont, et
 * `error-messages.ts` rappelle que les messages émis par l'API sont « écrits
 * pour un journal et pour le diagnostic », la phrase affichée étant choisie par
 * le front sur la foi du `code`. Le repli garde donc à `details.violations` le
 * texte exact qu'il avait avant ce ticket : aucune route ne change de
 * comportement observable, ce qu'exige le troisième critère de #1232.
 *
 * Elle ne prend jamais le pas sur la langue de l'écran : une carte passée à
 * `safeParse` ou à `zodResolver` est **contextuelle**, et la contextuelle gagne
 * sur la globale (`addIssueToContext`, zod). Le repli ne se voit donc que là où
 * personne n'a de langue à demander — un service, un journal, un test.
 *
 * ## Ce que #1309 ajoute : le refus d'une clé que le schéma ne déclare pas
 *
 * Les schémas d'entrée du contrat sont `.strict()` — l'API le vérifie même à
 * l'amorçage (`assertRefusesUnknownKeys`), parce qu'un `tenantId` glissé dans un
 * corps JSON doit être **refusé** et non ignoré (tenant-isolation §2). Le refus
 * correspondant, `unrecognized_keys`, n'était pas traité ici : il retombait sur
 * `ctx.defaultError`, c'est-à-dire sur la phrase native de zod — « Unrecognized
 * key(s) in object: 'xyz' » —, en anglais sur les deux consoles.
 *
 * Il a désormais sa phrase, `unexpected`, et cette phrase **ne nomme aucune
 * clé**. C'est un arbitrage, pas un oubli : la personne qui lit ce message n'a
 * pas composé la charge utile à la main — elle a soumis un formulaire dont un
 * appelant intermédiaire a ajouté un champ —, et lui réciter un nom de clé ne
 * lui dit rien qu'elle puisse corriger.
 *
 * Un journal, lui, ne demande pas la même chose qu'un écran : c'est le nom du
 * champ refusé qui y a toute la valeur. Les deux cartes se séparent donc ici, et
 * seulement sur ce code — `zodErrorMap` sert la phrase, `diagnosticErrorMap`
 * garde le texte de zod. Le pourquoi est écrit à `DIAGNOSTIC_LOCALE`.
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
  /**
   * Le refus d'un `.strict()` — une clé que le schéma ne déclare pas (#1309).
   *
   * Une phrase fixe, et non une fonction prenant les clés en cause : le nom de
   * la clé refusée n'a pas d'emploi pour qui lit le message, et le lui servir
   * ferait du corps d'erreur l'écho d'une entrée non validée.
   */
  readonly unexpected: string;
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
    unexpected: 'Cette demande contient des informations qui ne sont pas attendues.',
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
    unexpected: 'This request contains information that is not expected.',
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

// ---------------------------------------------------------------------------
// Les refus que seul le schéma sait nommer — #1232
// ---------------------------------------------------------------------------

/**
 * Le vocabulaire fermé des refus que les schémas partagés posent eux-mêmes.
 *
 * Une clé par **règle**, et non par champ : « la fin doit suivre le début » est
 * la même phrase sous une plage d'ouverture et sous une plage d'absence, et
 * deux clés pour une seule règle auraient divergé à la première reformulation.
 * Le préfixe suit le fichier qui porte la règle — `identifier.`, `time.`,
 * `tenant.`, `availability.` —, ce qui suffit à retrouver l'un depuis l'autre.
 *
 * Les valeurs sont stables : elles voyagent dans les `params` d'une `issue`, que
 * l'API sérialise à l'occasion. Les renommer ne casse rien de déployé — le front
 * ne branche jamais son comportement dessus (`error-codes.ts`) — mais laisserait
 * un journal illisible le temps d'un déploiement.
 */
const VALIDATION_MESSAGE_KEY_LIST = [
  /* --- identifiants et coordonnées ---------------------------------------- */
  'identifier.uuid',
  'identifier.slug',
  'identifier.slugReserved',
  'identifier.email',
  'identifier.countryCode',
  'identifier.countryCodeUnknown',
  'identifier.phone',
  'identifier.phoneTooShort',
  'identifier.phoneInternational',
  'identifier.phoneNational',

  /* --- argent -------------------------------------------------------------- */
  'money.currencyCode',

  /* --- temps --------------------------------------------------------------- */
  'time.offsetDateTime',
  'time.localTime',
  'time.calendarDate',
  'time.calendarDateUnreal',
  'time.timeZone',
  'time.intervalOrder',

  /* --- établissement ------------------------------------------------------- */
  'tenant.closesAfterOpens',
  'tenant.openingHoursTooMany',
  'tenant.openingHoursOverlap',
  'tenant.receiptPrefix',
  'tenant.vatNumber',
  'tenant.legalIdPair',
  'tenant.legalIdInvalid',

  /* --- disponibilité ------------------------------------------------------- */
  'availability.rangeOrder',
  'availability.rangeTooWide',
  'availability.scheduleRangeOrder',
  'availability.scheduleOverlap',
  'availability.weekdayDuplicate',
  'availability.timeOffRange',
  'availability.timeOffWindow',

  /* --- rendez-vous et comptes ---------------------------------------------- */
  'appointment.dataConsent',
  'identity.accountDataConsent',

  /* --- console de la plateforme -------------------------------------------- */
  'platform.totpCode',
] as const;

/** Une clé du vocabulaire ci-dessus. */
export type ValidationMessageKey = (typeof VALIDATION_MESSAGE_KEY_LIST)[number];

/**
 * Ce qu'une phrase interpole — une borne, une nature d'identifiant.
 *
 * `string | number` et non `unknown` : ce qui entre dans un message de champ est
 * une valeur que la personne vient de saisir ou une constante du contrat, jamais
 * un objet dont la sérialisation surprendrait.
 */
export type ValidationMessageVars = Readonly<Record<string, string | number>>;

/** Une phrase, ou la fonction qui la compose à partir de ses bornes. */
type ValidationPhrase = string | ((vars: ValidationMessageVars) => string);

/**
 * Les phrases françaises — **reprises mot pour mot** de celles que les schémas
 * portaient avant #1232.
 *
 * La reprise est littérale à dessein : c'est elle qui garantit que
 * `details.violations` sert exactement le même texte qu'avant le ticket, donc
 * qu'aucune route ne change de comportement observable (troisième critère). Les
 * harmoniser avec la ponctuation de `PHRASES` ci-dessus est un autre travail,
 * qui touche aux captures de la recette et aux tests de l'API.
 */
const FR_VALIDATION: Readonly<Record<ValidationMessageKey, ValidationPhrase>> = {
  'identifier.uuid': 'identifiant attendu au format UUID v4',
  'identifier.slug': 'slug attendu en minuscules, chiffres et tirets simples',
  'identifier.slugReserved': 'ce nom est réservé par la plateforme — choisissez-en un autre',
  'identifier.email': 'adresse e-mail invalide',
  'identifier.countryCode': 'code pays ISO 3166-1 alpha-2 attendu (« FR »)',
  'identifier.countryCodeUnknown':
    'ce pays n’existe pas en ISO 3166-1 alpha-2 — « FR », « US », « CA »',
  'identifier.phone': 'numéro de téléphone invalide',
  'identifier.phoneTooShort': (vars) =>
    `numéro de téléphone incomplet — au moins ${String(vars.min)} chiffres attendus`,
  'identifier.phoneInternational':
    'numéro attendu au format international, indicatif compris — par exemple +261 34 12 345 67',
  'identifier.phoneNational':
    'numéro de téléphone invalide — au format national du pays de l’établissement, ' +
    'ou au format international (+261 34 12 345 67)',

  'money.currencyCode': 'code devise ISO 4217 invalide',

  'time.offsetDateTime':
    'une date-heure doit être en ISO 8601 avec offset explicite (« Z » ou « ±HH:MM »)',
  'time.localTime': 'heure locale attendue au format HH:MM (00:00 à 23:59)',
  'time.calendarDate': 'date attendue au format YYYY-MM-DD',
  'time.calendarDateUnreal': 'cette date n’existe pas au calendrier',
  'time.timeZone': 'fuseau horaire IANA inconnu',
  'time.intervalOrder': 'la fin doit être strictement postérieure au début',

  'tenant.closesAfterOpens': 'la fermeture doit être strictement postérieure à l’ouverture',
  'tenant.openingHoursTooMany': (vars) =>
    `au plus ${String(vars.max)} plages d’ouverture par semaine`,
  'tenant.openingHoursOverlap': 'deux plages d’ouverture du même jour se recouvrent',
  'tenant.receiptPrefix': 'préfixe attendu : 2 à 8 lettres majuscules ou chiffres, sans tiret',
  'tenant.vatNumber':
    'numéro de TVA attendu : deux lettres de pays puis 8 à 13 caractères ' +
    '(la clé du numéro français est vérifiée)',
  'tenant.legalIdPair': 'la nature et l’identifiant d’entreprise se posent ou s’effacent ensemble',
  'tenant.legalIdInvalid': (vars) => `identifiant invalide pour la nature « ${String(vars.type)} »`,

  'availability.rangeOrder': 'la fin de la plage ne peut pas précéder son début',
  'availability.rangeTooWide': (vars) => `la plage demandée dépasse ${String(vars.max)} jours`,
  'availability.scheduleRangeOrder':
    'la fin d’une plage doit être strictement postérieure à son début',
  'availability.scheduleOverlap': 'deux plages du même jour se recouvrent',
  'availability.weekdayDuplicate': 'un jour de semaine ne se déclare qu’une fois',
  'availability.timeOffRange': (vars) =>
    `la fin doit suivre le début, et l’absence ne peut excéder ${String(vars.max)} jours`,
  'availability.timeOffWindow': (vars) =>
    `la fin de la fenêtre doit suivre son début, sans excéder ${String(vars.max)} jours`,

  'appointment.dataConsent': 'le traitement des données doit être accepté pour réserver',
  'identity.accountDataConsent': 'le traitement des données doit être accepté pour créer un compte',

  'platform.totpCode': 'six chiffres, tels que les affiche votre application',
};

/**
 * Les mêmes refus, en anglais — la langue par défaut du système (#844).
 *
 * Même registre que le français : une phrase minuscule, sans point final. C'est
 * ce que les huit écrans concernés affichent déjà, et changer de registre dans
 * une seule des deux langues aurait fait paraître l'anglais rapporté d'ailleurs.
 */
const EN_VALIDATION: Readonly<Record<ValidationMessageKey, ValidationPhrase>> = {
  'identifier.uuid': 'identifier expected in UUID v4 format',
  'identifier.slug': 'address expected in lowercase letters, digits and single hyphens',
  'identifier.slugReserved': 'this name is reserved by the platform — please choose another',
  'identifier.email': 'invalid email address',
  'identifier.countryCode': 'ISO 3166-1 alpha-2 country code expected (“FR”)',
  'identifier.countryCodeUnknown':
    'no such country in ISO 3166-1 alpha-2 — “FR”, “US”, “CA”',
  'identifier.phone': 'invalid phone number',
  'identifier.phoneTooShort': (vars) =>
    `incomplete phone number — at least ${String(vars.min)} digits expected`,
  'identifier.phoneInternational':
    'number expected in international format, country code included — for example +261 34 12 345 67',
  'identifier.phoneNational':
    'invalid phone number — in the national format of the salon’s country, ' +
    'or in international format (+261 34 12 345 67)',

  'money.currencyCode': 'invalid ISO 4217 currency code',

  'time.offsetDateTime':
    'a date and time must be ISO 8601 with an explicit offset (“Z” or “±HH:MM”)',
  'time.localTime': 'local time expected in HH:MM format (00:00 to 23:59)',
  'time.calendarDate': 'date expected in YYYY-MM-DD format',
  'time.calendarDateUnreal': 'this date does not exist in the calendar',
  'time.timeZone': 'unknown IANA time zone',
  'time.intervalOrder': 'the end must be strictly after the start',

  'tenant.closesAfterOpens': 'closing time must be strictly after opening time',
  'tenant.openingHoursTooMany': (vars) => `at most ${String(vars.max)} opening ranges per week`,
  'tenant.openingHoursOverlap': 'two opening ranges on the same day overlap',
  'tenant.receiptPrefix': 'prefix expected: 2 to 8 uppercase letters or digits, no hyphen',
  'tenant.vatNumber':
    'VAT number expected: two country letters then 8 to 13 characters ' +
    '(the checksum of French numbers is verified)',
  'tenant.legalIdPair': 'the company identifier and its type are set or cleared together',
  'tenant.legalIdInvalid': (vars) => `invalid identifier for type “${String(vars.type)}”`,

  'availability.rangeOrder': 'the end of the range cannot come before its start',
  'availability.rangeTooWide': (vars) =>
    `the requested range is longer than ${String(vars.max)} days`,
  'availability.scheduleRangeOrder': 'the end of a range must be strictly after its start',
  'availability.scheduleOverlap': 'two ranges on the same day overlap',
  'availability.weekdayDuplicate': 'a weekday can only be declared once',
  'availability.timeOffRange': (vars) =>
    `the end must follow the start, and time off cannot exceed ${String(vars.max)} days`,
  'availability.timeOffWindow': (vars) =>
    `the end of the window must follow its start, and cannot exceed ${String(vars.max)} days`,

  'appointment.dataConsent': 'data processing must be accepted in order to book',
  'identity.accountDataConsent': 'data processing must be accepted in order to create an account',

  'platform.totpCode': 'six digits, as shown by your authenticator app',
};

/** Les refus nommés par les schémas, par langue puis par clé. */
export const VALIDATION_MESSAGES: Readonly<
  Record<Locale, Readonly<Record<ValidationMessageKey, ValidationPhrase>>>
> = Object.freeze({ fr: Object.freeze(FR_VALIDATION), en: Object.freeze(EN_VALIDATION) });

/** Le vocabulaire, en ensemble — l'appartenance se juge ici, jamais par `in`. */
const VALIDATION_MESSAGE_KEYS: ReadonlySet<string> = new Set(VALIDATION_MESSAGE_KEY_LIST);

/** `true` si `value` est une clé du vocabulaire. */
export function isValidationMessageKey(value: unknown): value is ValidationMessageKey {
  return typeof value === 'string' && VALIDATION_MESSAGE_KEYS.has(value);
}

/** La phrase de cette clé, dans cette langue, ses bornes interpolées. */
export function validationMessage(
  key: ValidationMessageKey,
  locale: Locale,
  vars: ValidationMessageVars = {},
): string {
  const phrase = VALIDATION_MESSAGES[locale][key];

  return typeof phrase === 'string' ? phrase : phrase(vars);
}

/** Ce qu'une `issue` porte pour être traduite : la clé, et ses bornes. */
interface ValidationIssueParams {
  readonly validationKey: ValidationMessageKey;
  readonly validationVars?: ValidationMessageVars;
}

/**
 * Le paramètre d'`issue` qui remplace une phrase écrite en dur dans un schéma.
 *
 * ```ts
 * schema.refine(estValide, messageKey('tenant.openingHoursOverlap'));
 * schema.refine(tientDansLaFenetre, { ...messageKey('availability.rangeTooWide', { max: 90 }), path: ['to'] });
 * ctx.addIssue({ code: z.ZodIssueCode.custom, ...messageKey('identifier.phoneNational') });
 * ```
 *
 * Il n'y a **pas** de `message` dans ce que cela produit, et c'est tout l'objet
 * de la manœuvre : zod court-circuite ses cartes d'erreurs dès qu'une `issue`
 * en porte un, si bien qu'une phrase posée ici gagnerait sur la langue de la
 * page. Sans message, la carte contextuelle est consultée — c'est elle qui sait
 * quelle langue l'écran affiche.
 */
export function messageKey(
  key: ValidationMessageKey,
  vars?: ValidationMessageVars,
): { readonly params: ValidationIssueParams } {
  return {
    params: vars === undefined ? { validationKey: key } : { validationKey: key, validationVars: vars },
  };
}

/**
 * La clé portée par une `issue`, ou `null` si elle n'en porte pas.
 *
 * Seules les `issues` `custom` ont des `params` — c'est le seul code d'`issue`
 * que zod laisse enrichir. La lecture reste défensive : ces `params` traversent
 * une frontière HTTP dans `details`, et rien ne garantit qu'un appelant ne
 * fabrique pas une `issue` à la main.
 */
function keyedMessage(issue: z.ZodIssueOptionalMessage, locale: Locale): string | null {
  if (issue.code !== z.ZodIssueCode.custom) {
    return null;
  }

  const params: unknown = issue.params;

  if (typeof params !== 'object' || params === null) {
    return null;
  }

  const bag = params as Record<string, unknown>;
  const key: unknown = bag.validationKey;

  if (!isValidationMessageKey(key)) {
    return null;
  }

  const vars: unknown = bag.validationVars;

  return validationMessage(
    key,
    locale,
    typeof vars === 'object' && vars !== null ? (vars as ValidationMessageVars) : {},
  );
}

/**
 * La carte d'erreurs de zod dans la langue demandée.
 *
 * Le repli est `ctx.defaultError` et non une phrase inventée : un refus que
 * cette carte ne connaît pas — `invalid_intersection_types`, un `refine` sans
 * message ni clé — n'est pas un refus de saisie mais un défaut de schéma, et le
 * message de zod est ce qui permet de le diagnostiquer. Le remplacer par « cette
 * valeur n'est pas valable » effacerait la seule trace utile.
 */
export function zodErrorMap(locale: Locale): z.ZodErrorMap {
  const phrases = PHRASES[locale];

  return (issue, ctx) => {
    // La clé d'abord : c'est le refus que le schéma a **nommé**, et il est plus
    // précis que tout ce que le code d'`issue` seul permettrait de dire.
    const named = keyedMessage(issue, locale);

    if (named !== null) {
      return { message: named };
    }

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

      case z.ZodIssueCode.unrecognized_keys:
        // Le refus d'un `.strict()` — #1309. La phrase ne reprend pas
        // `issue.keys` : une liste de noms de champs ne dit rien à qui vient de
        // soumettre un formulaire, et c'est elle qui rendait le message
        // intraduisible. Ce que le **journal** de l'API y perd lui est rendu par
        // `diagnosticErrorMap`, plus bas — voir `DIAGNOSTIC_LOCALE`.
        return { message: phrases.unexpected };

      case z.ZodIssueCode.invalid_union:
        // Arbitré en même temps que le cas ci-dessus (#1309, deuxième critère) :
        // la phrase reste la générique, et elle reste **une phrase traduite**
        // plutôt qu'un repli sur `ctx.defaultError` — lequel se lirait « Invalid
        // input », en anglais et sans rien apprendre.
        //
        // Générique parce qu'une union n'a rien de commun à dire : zod n'expose
        // au niveau de l'union que ce code, les refus de chaque branche restant
        // dans `unionErrors`, et ces branches sont par construction
        // hétérogènes — il n'existe donc pas de phrase plus précise qui soit
        // vraie pour toutes. Une union est d'ailleurs un choix de schéma que
        // personne ne voit à l'écran : la décrire n'aiderait pas à corriger la
        // saisie. Un refus qui mérite mieux que cette phrase-ci ne se dit donc
        // pas par une union mais par un `superRefine` qui pose sa clé — ce que
        // fait `identifier.phoneNational` (`common/identifiers.ts`), là où une
        // union « national | international » n'aurait rien su nommer.
        return { message: phrases.invalid };

      default:
        return { message: ctx.defaultError };
    }
  };
}

/**
 * La langue du **repli**, là où personne n'a de langue à demander : un service,
 * un journal, `details.violations`.
 *
 * Le français, pour la raison exposée en tête de ce module — c'est la langue des
 * diagnostics du dépôt, et c'est le texte que l'API servait déjà. Ce n'est pas
 * la langue par défaut du **produit**, qui est l'anglais (`DEFAULT_LOCALE`) et
 * qui se choisit écran par écran, carte contextuelle à l'appui.
 *
 * ## #1309 a rouvert la question, et la réponse ne bouge pas
 *
 * Traduire `unrecognized_keys` touche à ce que cette constante gouverne : la
 * phrase servie dans `details.violations`. Le troisième critère de #1309
 * demandait donc que son sort soit tranché sciemment plutôt que subi. Il l'est :
 * **elle reste `'fr'`**, pour trois raisons.
 *
 * 1. Ce n'est pas une langue d'affichage. `DomainExceptionFilter` sert un
 *    `{ code, message, details }` dont le front choisit le texte sur la foi du
 *    `code` (`error-codes.ts`) ; `violations` est lu par un journal et par qui
 *    intègre l'API, jamais rendu tel quel à un client. Le passer à l'anglais
 *    n'internationaliserait rien — cela traduirait un journal.
 * 2. Le reste du diagnostic est français et le resterait. Les messages de
 *    `DomainError`, les phrases de `FR_VALIDATION` reprises de #1232, les
 *    `TypeError` d'amorçage : basculer cette seule constante donnerait un
 *    `details` anglais sous un `message` français, ce qui est moins lisible que
 *    l'état actuel, pas plus.
 * 3. C'est ce que #1232 a gelé pour que « aucune route ne change de
 *    comportement observable », et la remettre en cause ferait basculer d'un
 *    coup la cinquantaine de phrases de `VALIDATION_MESSAGES` sur **toutes** les
 *    routes — un changement de contrat qui n'a rien à faire dans un correctif de
 *    trois lignes, et qui demanderait son propre ticket.
 */
export const DIAGNOSTIC_LOCALE: Locale = 'fr';

/**
 * La carte du **diagnostic** : celle des écrans, sauf là où un journal demande
 * autre chose qu'une phrase.
 *
 * Elle ne diffère de `zodErrorMap(DIAGNOSTIC_LOCALE)` que sur
 * `unrecognized_keys`, où elle rend le texte de zod — « Unrecognized key(s) in
 * object: 'client' ». C'est le second volet de l'arbitrage de #1309, et il
 * découle du premier : la phrase du catalogue est muette sur la clé refusée,
 * exprès, et cette discrétion qui protège un écran aveugle un journal.
 *
 * Or c'est justement là que le nom sert. `violationsOf` (API) énonce que ses
 * messages « citent des **noms de champs** », et le corps d'erreur est ce qui
 * dit à qui intègre l'API *lequel* de ses champs a été refusé ; sans le nom, un
 * `VALIDATION_ERROR` sur un corps de vingt champs n'est plus instruisible.
 * `appointments-desk.integration-spec.ts` en fait d'ailleurs une assertion : un
 * `client` glissé dans une création au comptoir doit se retrouver nommé dans le
 * refus, faute de quoi rien ne distingue ce 400-là d'un autre.
 *
 * Le partage tient donc en une phrase : **la langue de l'écran porte une phrase,
 * le journal porte un nom de champ.** Aucune route ne change de comportement
 * observable — ce que #1232 exigeait —, et aucun écran ne reçoit plus d'anglais
 * brut — ce que #1309 corrige.
 *
 * Elle n'est pas exportée : personne n'a à la poser à la main, c'est la ligne
 * ci-dessous qui l'installe, et une carte contextuelle l'emporte toujours.
 */
function diagnosticErrorMap(): z.ZodErrorMap {
  const parDefaut = zodErrorMap(DIAGNOSTIC_LOCALE);

  return (issue, ctx) =>
    issue.code === z.ZodIssueCode.unrecognized_keys
      ? { message: ctx.defaultError }
      : parDefaut(issue, ctx);
}

/*
 * La carte globale, posée au chargement de ce module.
 *
 * Elle ne décide de la langue d'aucun écran : zod consulte la carte
 * **contextuelle** en premier, et tout formulaire du produit en passe une. Elle
 * n'existe que pour qu'une clé de `messageKey` ne se lise jamais « Invalid
 * input » chez qui n'en a pas passé — le `ZodValidationPipe` de l'API, un
 * service, un test.
 *
 * Posée ici plutôt que dans l'amorçage de chaque application parce que c'est
 * **ce module** qui fabrique les clés : tout schéma qui en pose une importe
 * `messageKey`, donc charge cette ligne. Un point d'installation à appeler à la
 * main aurait été oublié dans exactement le cas où il manque le plus — un test
 * unitaire qui importe un schéma sans passer par le baril.
 */
z.setErrorMap(diagnosticErrorMap());
