/**
 * Les messages de validation des formulaires, dans les deux langues — #845,
 * douzième critère d'acceptation.
 *
 * Ce que cette suite garde : un refus de saisie se lit comme une phrase, dans la
 * langue de la page, et **jamais** comme le message par défaut de zod
 * (« String must contain at least 1 character(s) »), qui n'est ni traduit ni
 * adressé à qui a saisi.
 */

import { z } from 'zod';

import { validationPhrases, zodErrorMap } from '../errors/index';
import { LOCALES } from '../locale/index';

/** Le premier message rendu par un schéma sous la carte d'une langue. */
function refuse(schema: z.ZodTypeAny, value: unknown, locale: 'fr' | 'en'): string {
  const result = schema.safeParse(value, { errorMap: zodErrorMap(locale) });

  if (result.success) {
    throw new Error('la valeur a été acceptée, le test n’a rien à lire');
  }

  return result.error.issues[0]?.message ?? '';
}

describe('zodErrorMap', () => {
  it.each([...LOCALES])('nomme le champ obligatoire en « %s »', (locale) => {
    const phrases = validationPhrases(locale);

    expect(refuse(z.string(), undefined, locale)).toBe(phrases.required);
    // `min(1)` est la façon dont zod exprime « non vide » : la phrase attendue
    // est celle du champ obligatoire, pas une leçon de comptage.
    expect(refuse(z.string().min(1), '', locale)).toBe(phrases.required);
  });

  it.each([...LOCALES])('nomme l’adresse e-mail en « %s »', (locale) => {
    expect(refuse(z.string().email(), 'pas-une-adresse', locale)).toBe(
      validationPhrases(locale).email,
    );
  });

  it.each([...LOCALES])('donne la borne en « %s »', (locale) => {
    const phrases = validationPhrases(locale);

    expect(refuse(z.string().min(3), 'ab', locale)).toBe(phrases.tooShort(3));
    expect(refuse(z.string().max(2), 'abc', locale)).toBe(phrases.tooLong(2));
    expect(refuse(z.number().min(10), 9, locale)).toBe(phrases.tooSmall(10));
    expect(refuse(z.number().max(10), 11, locale)).toBe(phrases.tooBig(10));
  });

  it.each([...LOCALES])('renvoie aux options d’un choix en « %s »', (locale) => {
    expect(refuse(z.enum(['a', 'b']), 'c', locale)).toBe(validationPhrases(locale).choice);
  });

  it.each([...LOCALES])('demande un nombre en « %s »', (locale) => {
    expect(refuse(z.number(), 'douze', locale)).toBe(validationPhrases(locale).number);
  });

  it('ne dit pas la même chose dans les deux langues', () => {
    expect(refuse(z.string(), undefined, 'fr')).not.toBe(refuse(z.string(), undefined, 'en'));
  });

  it('laisse au schéma son propre message', () => {
    // Un `errorMap` posé sur un schéma précis gagne sur celui-ci, par conception
    // de zod : `localeSchema` nomme les valeurs attendues du contrat, et c'est
    // ce message-là qu'il faut lire.
    const schema = z.string().min(1, { message: 'Nommez votre salon.' });

    expect(refuse(schema, '', 'en')).toBe('Nommez votre salon.');
  });

  it('laisse remonter le message de zod sur un refus qu’elle ne connaît pas', () => {
    // Un `refine` sans message n'est pas un refus de saisie mais un défaut de
    // schéma : le message de zod est la seule trace utile pour le diagnostiquer.
    const schema = z.string().refine(() => false);

    expect(refuse(schema, 'valeur', 'fr')).toBe('Invalid input');
  });
});
