/**
 * Les messages de validation des formulaires, dans les deux langues — #845,
 * douzième critère d'acceptation.
 *
 * Ce que cette suite garde : un refus de saisie se lit comme une phrase, dans la
 * langue de la page, et **jamais** comme le message par défaut de zod
 * (« String must contain at least 1 character(s) »), qui n'est ni traduit ni
 * adressé à qui a saisi.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  DIAGNOSTIC_LOCALE,
  VALIDATION_MESSAGES,
  messageKey,
  validationMessage,
  validationPhrases,
  zodErrorMap,
} from '../errors/index';
import { LOCALES, type Locale } from '../locale/index';
import { openingHoursSchema } from '../schemas/tenant';

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

  it.each([...LOCALES])('refuse une clé que le schéma ne déclare pas, en « %s »', (locale) => {
    // Les schémas d'entrée du contrat sont `.strict()`, et l'API l'exige de
    // chacun au montage (`assertRefusesUnknownKeys`). Le refus correspondant
    // s'affichait « Unrecognized key(s) in object: 'tenantId' » — le message
    // natif de zod, en anglais sur les deux consoles (#1309).
    const schema = z.object({ name: z.string() }).strict();
    const message = refuse(schema, { name: 'Zen Spa', tenantId: 'tnt_voisin' }, locale);

    expect(message).toBe(validationPhrases(locale).unexpected);
  });

  it.each([...LOCALES])('ne recopie pas la clé refusée dans le message, en « %s »', (locale) => {
    // La clé vient de la charge utile reçue, pas du schéma : la renvoyer ferait
    // du message d'erreur l'écho d'une entrée jamais validée.
    const schema = z.object({ name: z.string() }).strict();
    const message = refuse(schema, { name: 'Zen Spa', tenantId: 'tnt_voisin' }, locale);

    expect(message).not.toContain('tenantId');
    expect(message).not.toContain('Unrecognized');
  });

  it('refuse la clé surnuméraire dans deux phrases distinctes', () => {
    const schema = z.object({ name: z.string() }).strict();
    const charge = { name: 'Zen Spa', tenantId: 'tnt_voisin' };

    expect(refuse(schema, charge, 'fr')).not.toBe(refuse(schema, charge, 'en'));
  });

  it.each([...LOCALES])('reste sur la phrase générique face à une union, en « %s »', (locale) => {
    // Arbitrage écrit à côté du cas (#1309) : une union ne surface que son
    // propre code, les refus de ses branches restant dans `unionErrors`. Ce qui
    // est gardé ici, c'est que le message soit une **phrase traduite** et non le
    // « Invalid input » de zod.
    const schema = z.union([z.string(), z.number()]);

    expect(refuse(schema, true, locale)).toBe(validationPhrases(locale).invalid);
  });

  it('laisse au schéma son propre message', () => {
    // Un message posé sur un check court-circuite toutes les cartes d'erreurs,
    // par conception de zod. C'est précisément ce qui rendait les phrases des
    // schémas partagés intraduisibles, et pourquoi #1232 les a remplacées par
    // des clés : un appelant qui écrit vraiment sa propre phrase, lui, la garde.
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

/**
 * Le repli de diagnostic — troisième critère de #1309.
 *
 * Ce que cette suite garde : la langue de `details.violations` est un choix, et
 * elle ne dérive pas au gré des tickets. Le corps d'erreur de l'API est servi
 * sans carte contextuelle (`ZodValidationPipe` appelle `safeParse(value)` tout
 * court) : c'est la carte globale de ce module qui répond, et c'est ce que ces
 * tests exercent.
 */
describe('repli de diagnostic', () => {
  /** Le premier message rendu **sans** carte contextuelle — ce que l'API sert. */
  function refuseSansCarte(schema: z.ZodTypeAny, value: unknown): string {
    const result = schema.safeParse(value);

    if (result.success) {
      throw new Error('la valeur a été acceptée, le test n’a rien à lire');
    }

    return result.error.issues[0]?.message ?? '';
  }

  it('reste en français, et c’est une décision', () => {
    // #1232 l'a gelé, #1309 l'a reconduit : `violations` est lu par un journal
    // et par qui intègre l'API, pas rendu à un client — le passer à l'anglais
    // traduirait un journal sans internationaliser quoi que ce soit, et
    // laisserait un `details` anglais sous un `message` français.
    expect(DIAGNOSTIC_LOCALE).toBe('fr');
  });

  it('sert les clés du catalogue dans cette langue', () => {
    const schema = z.string().refine(() => false, messageKey('identifier.phone'));

    expect(refuseSansCarte(schema, 'zéro six')).toBe(
      validationMessage('identifier.phone', DIAGNOSTIC_LOCALE),
    );
  });

  it('garde le nom du champ refusé, là où un écran ne le garde pas', () => {
    // Le second volet de l'arbitrage de #1309. La phrase du catalogue est muette
    // sur la clé, exprès — et cette discrétion qui protège un écran aveuglerait
    // un journal. `violationsOf` (API) énonce que ses messages citent des noms
    // de champs, et `appointments-desk.integration-spec.ts` en fait une
    // assertion : un `client` glissé au comptoir doit se retrouver nommé.
    const schema = z.object({ name: z.string() }).strict();
    const message = refuseSansCarte(schema, { name: 'Zen Spa', client: { firstName: 'Camille' } });

    expect(message).toContain('client');
    expect(message).not.toBe(validationPhrases(DIAGNOSTIC_LOCALE).unexpected);
  });

  it('cède toujours le pas à la langue de l’écran', () => {
    // La propriété qui rend le repli inoffensif : une carte passée à
    // `safeParse` est contextuelle, et la contextuelle gagne sur la globale.
    // Elle vaut aussi en français, où les deux cartes ne divergent que sur ce
    // code-ci : l'écran a sa phrase, le journal garde son nom de champ.
    const schema = z.object({ name: z.string() }).strict();
    const charge = { name: 'Zen Spa', client: { firstName: 'Camille' } };

    for (const locale of LOCALES) {
      expect(refuse(schema, charge, locale)).toBe(validationPhrases(locale).unexpected);
      expect(refuse(schema, charge, locale)).not.toBe(refuseSansCarte(schema, charge));
    }
  });
});

/**
 * Les refus que les schémas **nomment** — #1232.
 *
 * Ce que cette suite garde : une règle du contrat qui a son mot à dire — « deux
 * plages du même jour se recouvrent » — se lit dans la langue de l'écran, et le
 * vocabulaire est traduit en entier.
 */
describe('clés de message des schémas', () => {
  const keys = Object.keys(VALIDATION_MESSAGES.fr) as (keyof typeof VALIDATION_MESSAGES.fr)[];

  it('couvre le même vocabulaire dans les deux langues', () => {
    expect(Object.keys(VALIDATION_MESSAGES.en).sort()).toEqual([...keys].sort());
  });

  it.each(keys)('« %s » a une phrase distincte dans chaque langue', (key) => {
    // Les bornes sont interpolées avec des valeurs quelconques : ce qui est
    // mesuré est la phrase, pas le nombre qu'elle porte.
    const vars = { min: 3, max: 90, type: 'SIRET', locales: 'fr, en' };
    const fr = validationMessage(key, 'fr', vars);
    const en = validationMessage(key, 'en', vars);

    expect(fr).not.toBe('');
    expect(en).not.toBe('');
    // Une clé laissée non traduite se lit ici, et nulle part ailleurs : `tsc`
    // n'attrape qu'une clé **absente**, pas une phrase française recopiée.
    expect(fr).not.toBe(en);
  });

  it('interpole la borne qu’on lui donne', () => {
    expect(validationMessage('availability.rangeTooWide', 'en', { max: 90 })).toContain('90');
    expect(validationMessage('availability.rangeTooWide', 'fr', { max: 90 })).toContain('90');
  });

  it.each([...LOCALES])('rend le refus d’un schéma en « %s »', (locale: Locale) => {
    const semaine = [
      { weekday: 1, opensAt: '09:00', closesAt: '18:00' },
      { weekday: 1, opensAt: '17:00', closesAt: '19:00' },
    ];

    expect(refuse(openingHoursSchema, semaine, locale)).toBe(
      validationMessage('tenant.openingHoursOverlap', locale),
    );
  });

  it('ignore des `params` qui ne portent pas de clé connue', () => {
    // Ces `params` traversent une frontière HTTP : une valeur inventée ne doit
    // pas faire lever la carte, seulement la laisser retomber sur zod.
    const schema = z.string().refine(() => false, { params: { validationKey: 'pas.une.cle' } });

    expect(refuse(schema, 'valeur', 'fr')).toBe('Invalid input');
  });

  it('pose la clé sans jamais poser de message', () => {
    // La propriété qui fait tout marcher : `messageKey` ne produit **pas** de
    // `message`, sans quoi zod court-circuiterait la carte contextuelle et la
    // langue de l'écran n'aurait plus voix au chapitre.
    expect(messageKey('identifier.phone')).toEqual({
      params: { validationKey: 'identifier.phone' },
    });
    expect(messageKey('identifier.phoneTooShort', { min: 6 })).toEqual({
      params: { validationKey: 'identifier.phoneTooShort', validationVars: { min: 6 } },
    });
  });
});

/**
 * Aucun schéma du contrat ne porte plus de phrase — le premier critère de #1232,
 * gardé par une lecture des sources plutôt que par la vigilance.
 *
 * Un `message:` réintroduit dans un schéma ne casse aucun test : il refuse ce
 * qu'il doit refuser, et il le refuse dans **une** langue. C'est exactement le
 * défaut que ce ticket a refermé, et il se réintroduirait à la première règle
 * ajoutée si rien ne le nommait.
 *
 * Ce module-ci est l'exception : c'est lui qui porte les deux tables.
 */
describe('les schémas partagés ne portent plus de phrase', () => {
  const racine = join(__dirname, '..');
  const exclus = new Set(['__tests__', 'errors']);

  function sources(dossier: string): readonly string[] {
    return readdirSync(dossier).flatMap((entree) => {
      const chemin = join(dossier, entree);

      if (statSync(chemin).isDirectory()) {
        return exclus.has(entree) ? [] : sources(chemin);
      }

      return entree.endsWith('.ts') ? [chemin] : [];
    });
  }

  it.each(sources(racine))('%s', (fichier) => {
    const lignes = readFileSync(fichier, 'utf8')
      .split('\n')
      // Les lignes de commentaire citent les anciennes phrases à dessein.
      .filter((ligne) => !/^\s*(\*|\/\/)/.test(ligne))
      .filter((ligne) => /\bmessage:/.test(ligne));

    expect(lignes).toEqual([]);
  });
});
