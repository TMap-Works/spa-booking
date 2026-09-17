import { validate } from 'class-validator';

import { SettleSaleDto } from '../dto/settlement.dto';
import {
  MAX_TERMINAL_REFERENCE_LENGTH,
  isTerminalReferenceShape,
  judgeTerminalReference,
  looksLikeCardNumber,
} from '../terminal-reference';

/**
 * La référence du ticket du TPE, et le **numéro de carte qui ne doit jamais y
 * entrer** — #834, deuxième critère.
 *
 * C'est la seule frontière PCI que ce ticket ajoute, et elle mérite d'être
 * exercée numéro par numéro : le module n'a par ailleurs aucun champ où une
 * carte pourrait aller, et celui-ci est le premier texte libre que le comptoir
 * saisisse sur le chemin de l'argent (payments-stripe §1).
 *
 * La suite couvre les deux barrières — la forme et la clé de Luhn — puis leur
 * effet réel : **400 au `ValidationPipe`**, donc avant qu'aucune ligne de code
 * métier ne s'exécute et avant que la valeur n'atteigne un journal.
 */

/** Numéros de test des marques, publiés par les prestataires. Aucun n'est réel. */
const CARD_NUMBERS = [
  '4242424242424242', // Visa, 16 chiffres
  '4000056655665556', // Visa debit
  '5555555555554444', // Mastercard
  '378282246310005', // American Express, 15 chiffres
  '38520000023237', // Diners, 14 chiffres
  '6011111111111117', // Discover
  '3056930009020004', // Diners, 16 chiffres
] as const;

/** Références telles qu'un terminal les imprime — opaques, alphanumériques. */
const TERMINAL_REFERENCES = ['A0000123', '000123456789', 'TRX7H2K9', 'AUT0042', '9'] as const;

const assign = <T extends object>(dto: T, values: Partial<T>): T => Object.assign(dto, values);

describe('looksLikeCardNumber — la clé de Luhn', () => {
  it.each(CARD_NUMBERS)('reconnaît « %s » comme un numéro de carte', (value) => {
    expect(looksLikeCardNumber(value)).toBe(true);
  });

  it('refuse de reconnaître un numéro dont la clé est fausse', () => {
    // Le dernier chiffre changé casse la clé. La fonction rend alors `false`, et
    // c'est la limite **assumée** du contrôle : un PAN mal recopié passe. La
    // garantie structurelle est ailleurs — il n'existe aucun champ de carte dans
    // ce module —, et c'est écrit en tête de `terminal-reference.ts`.
    expect(looksLikeCardNumber('4242424242424241')).toBe(false);
  });

  it.each([
    ['123456789012', '12 chiffres : trop court pour un PAN (ISO/IEC 7812)'],
    ['42424242424242424242', '20 chiffres : trop long'],
    ['A0000123', 'des lettres : ce n’est pas une suite de chiffres'],
    ['4242 4242 4242 4242', 'des espaces — arrêté par la barrière de forme, pas par celle-ci'],
    ['', 'rien du tout'],
  ])('ne voit pas de carte dans « %s » — %s', (value) => {
    expect(looksLikeCardNumber(value)).toBe(false);
  });
});

describe('isTerminalReferenceShape — la barrière de forme', () => {
  it.each(TERMINAL_REFERENCES)('accepte « %s »', (value) => {
    expect(isTerminalReferenceShape(value)).toBe(true);
  });

  it('accepte la longueur maximale exactement, et refuse le caractère de trop', () => {
    const maximum = 'A'.repeat(MAX_TERMINAL_REFERENCE_LENGTH);

    expect(isTerminalReferenceShape(maximum)).toBe(true);
    expect(isTerminalReferenceShape(`${maximum}A`)).toBe(false);
  });

  it.each([
    ['', 'une chaîne vide n’est pas une référence — le champ doit être absent'],
    ['4242 4242 4242 4242', 'les espaces sont ce qui rend un PAN méconnaissable à Luhn'],
    ['4242-4242-4242-4242', 'les tirets, pour la même raison'],
    ['Mme Dupont', 'un nom de porteur'],
    ['A0000123/2', 'une barre oblique — aucun terminal n’en imprime'],
  ])('refuse « %s » — %s', (value) => {
    expect(isTerminalReferenceShape(value)).toBe(false);
  });
});

describe('judgeTerminalReference — le verdict rendu au DTO', () => {
  it('laisse passer une référence de terminal', () => {
    expect(judgeTerminalReference('A0000123')).toBe('ok');
  });

  it('nomme la ressemblance à une carte quand la forme est par ailleurs bonne', () => {
    expect(judgeTerminalReference('4242424242424242')).toBe('ressemble-a-une-carte');
  });

  it('nomme la forme d’abord, même sur un PAN — et c’est délibéré', () => {
    // `4242-4242-4242-4242` est les deux à la fois. Le message de forme est vrai
    // et n'apprend rien de plus à qui sonderait : dire « cela ressemble à une
    // carte » indiquerait qu'il suffit de retirer les tirets pour savoir.
    expect(judgeTerminalReference('4242-4242-4242-4242')).toBe('mal-formee');
  });
});

/**
 * Le **400**, et à quel endroit il tombe.
 *
 * Quatrième point du septième critère : « une référence qui ressemble à un
 * numéro de carte rend 400 ». C'est le `ValidationPipe` global qui le rend, sur
 * la foi de ce validateur — donc avant le contrôleur, avant le service, avant
 * toute écriture, et avant tout journal.
 */
describe('SettleSaleDto — la référence à la frontière HTTP', () => {
  const errorsOn = async (values: Partial<SettleSaleDto>): Promise<readonly string[]> => {
    const errors = await validate(assign(new SettleSaleDto(), values));

    return errors.map((error) => error.property);
  };

  it('accepte un règlement au terminal avec sa référence', async () => {
    await expect(
      errorsOn({ method: 'CARD_TERMINAL', terminalReference: 'A0000123' }),
    ).resolves.toEqual([]);
  });

  it('accepte un règlement au terminal sans référence — elle est facultative', async () => {
    await expect(errorsOn({ method: 'CARD_TERMINAL' })).resolves.toEqual([]);
  });

  it.each(CARD_NUMBERS)('refuse « %s » en nommant le champ', async (value) => {
    await expect(
      errorsOn({ method: 'CARD_TERMINAL', terminalReference: value }),
    ).resolves.toEqual(['terminalReference']);
  });

  it('refuse une référence sur un règlement en espèces', async () => {
    // Un billet ne passe par aucun terminal : la référence n'aurait rien à
    // désigner, et `payments_terminal_reference_check` la refuserait en base.
    await expect(errorsOn({ method: 'CASH', terminalReference: 'A0000123' })).resolves.toEqual([
      'terminalReference',
    ]);
  });

  it('refuse un moyen que le comptoir ne sait pas produire', async () => {
    // `CARD_ONLINE` est une valeur du vocabulaire, pas du comptoir : « Stripe
    // n'est plus utilisé au comptoir » (premier critère de #834).
    await expect(
      errorsOn({ method: 'CARD_ONLINE' as unknown as SettleSaleDto['method'] }),
    ).resolves.toEqual(['method']);
  });
});
