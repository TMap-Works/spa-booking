import { escapeLikeTerm, matchesTerm } from '../crm.repository';

/**
 * Les prédicats de la recherche libre — la seule partie du dépôt qui soit du
 * raisonnement plutôt que de l'accès, et la raison pour laquelle `matchesTerm`
 * est sortie de la classe et exportée.
 *
 * Ce que ces cas verrouillent, et qu'aucune autre suite ne peut verrouiller :
 * `FakeCrmRepository` **réimplémente** la recherche en mémoire, si bien qu'une
 * régression dans le vrai `where` — la canonisation de l'adresse, le `mode:
 * 'insensitive'` des noms, le passage de « préfixe » à « contient » — laisserait
 * les suites unitaires, d'intégration et d'isolation au vert. Elle ne se verrait
 * qu'en production, sur une recherche qui cesse de trouver.
 */
describe('matchesTerm', () => {
  it('interroge les quatre axes annoncés, et eux seuls', () => {
    expect(matchesTerm('Dur').map((predicate) => Object.keys(predicate)[0])).toEqual([
      'lastName',
      'firstName',
      'email',
      'phone',
    ]);
  });

  it('cherche les noms par préfixe, insensibles à la casse', () => {
    // « Contient » (`contains`) n'est servi par aucun B-tree : le promettre
    // serait promettre un balayage complet du fichier client.
    expect(matchesTerm('Dur')).toEqual(
      expect.arrayContaining([
        { lastName: { startsWith: 'Dur', mode: 'insensitive' } },
        { firstName: { startsWith: 'Dur', mode: 'insensitive' } },
      ]),
    );
  });

  it('canonise l’adresse et la compare sensiblement à la casse', () => {
    // La colonne ne contient que des minuscules (`normalizeEmail` à l'écriture) :
    // abaisser le terme ici est ce qui permet à l'index unique
    // `(tenant_id, email)` de servir le préfixe. Sans cette minuscule, une
    // recherche sur « Alice@ » ne trouverait plus rien.
    expect(matchesTerm('ALICE@Example.test')).toContainEqual({
      email: { startsWith: 'alice@example.test' },
    });
  });

  it('laisse le numéro intact — un chiffre n’a pas de casse', () => {
    expect(matchesTerm('+261 34')).toContainEqual({ phone: { startsWith: '+261 34' } });
  });

  /**
   * La colonne est canonisée en E.164 depuis #824 — `+261341234567`, sans
   * séparateur. Un terme tapé comme le numéro se lit ne serait donc plus le
   * préfixe de rien : c'est la recherche du comptoir qui cesserait de trouver,
   * et aucune autre suite ne le verrait (`FakeCrmRepository` réimplémente la
   * recherche en mémoire).
   */
  it('cherche aussi le numéro compacté — la colonne est en E.164 (#824)', () => {
    expect(matchesTerm('+261 34 99')).toEqual(
      expect.arrayContaining([
        { phone: { startsWith: '+261 34 99' } },
        { phone: { startsWith: '+2613499' } },
      ]),
    );
  });

  it('ramène le `00` de composition internationale au `+` (#824)', () => {
    expect(matchesTerm('0026134')).toContainEqual({ phone: { startsWith: '+26134' } });
  });

  it('neutralise les métacaractères de `LIKE` sur les quatre axes', () => {
    // `startsWith` de Prisma n'échappe rien : sans cette neutralisation,
    // `?q=%%` deviendrait `LIKE '%%%'` — le fichier client entier, au prix d'un
    // balayage complet — et `?q=jean_` désignerait `jeanX` autant que `jeanne`.
    expect(matchesTerm('%_\\')).toEqual([
      { lastName: { startsWith: '\\%\\_\\\\', mode: 'insensitive' } },
      { firstName: { startsWith: '\\%\\_\\\\', mode: 'insensitive' } },
      { email: { startsWith: '\\%\\_\\\\' } },
      { phone: { startsWith: '\\%\\_\\\\' } },
    ]);
  });
});

describe('escapeLikeTerm', () => {
  it('ne touche pas à un terme sans métacaractère', () => {
    expect(escapeLikeTerm('Durand')).toBe('Durand');
  });

  it('préfixe `%`, `_` et `\\` du caractère d’échappement de PostgreSQL', () => {
    expect(escapeLikeTerm('100%_du\\temps')).toBe('100\\%\\_du\\\\temps');
  });
});
