import { BusinessRuleError } from '../../../common/errors';
import { requireSlug, SLUG_MAX_LENGTH, SLUG_PATTERN, slugify } from '../catalog.slug';

/**
 * Dérivation du slug — logique pure, exerçable sans base ni HTTP.
 *
 * Ce que ces cas protègent n'est pas cosmétique : un slug mal formé produit une
 * URL publique de réservation injoignable, et le seul signe en serait une page
 * 404 chez la cliente.
 */
describe('slugify', () => {
  it('abaisse la casse, retire les accents et relie par des tirets', () => {
    expect(slugify('Soin du Visage Éclat')).toBe('soin-du-visage-eclat');
  });

  it('replie toute ponctuation en une seule frontière de mot', () => {
    // Un slug fait de tirets consécutifs (`massage---60`) reste un label DNS
    // valide au sens strict, mais il trahit une dérivation naïve et se retrouve
    // tel quel dans l'URL publique.
    expect(slugify('Massage  «  60 min  » — Duo !')).toBe('massage-60-min-duo');
  });

  it('ne laisse jamais de tiret en tête ni en fin', () => {
    // `-salon` n'est pas un label DNS valide : la page publique serait
    // injoignable.
    expect(slugify('  --- Épilation ---  ')).toBe('epilation');
  });

  it('borne la longueur et ne coupe pas sur un tiret', () => {
    const derived = slugify('a'.repeat(SLUG_MAX_LENGTH - 1) + ' suite');

    expect(derived).not.toBeNull();
    expect(derived?.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    // La troncature tombe pile après le tiret séparateur ; il doit disparaître.
    expect(derived?.endsWith('-')).toBe(false);
  });

  it('rend toujours une forme que le motif du contrat accepte', () => {
    for (const label of [
      'Massage californien 60 min',
      'Coupe + Brushing',
      'Soin n°1',
      '2 mains, 4 mains',
      'Épilation --- jambes',
    ]) {
      const derived = slugify(label);
      expect(derived).not.toBeNull();
      expect(derived).toMatch(SLUG_PATTERN);
    }
  });

  it('rend `null` quand il ne reste rien à sluguer', () => {
    // Ponctuation seule, ou écriture non latine : aucun label DNS n'en sort. Un
    // slug vide passerait l'unicité une fois puis échouerait pour toutes les
    // suivantes, et produirait une URL publique inatteignable.
    expect(slugify('!!! ???')).toBeNull();
    expect(slugify('指圧')).toBeNull();
    expect(slugify('   ')).toBeNull();
  });
});

/**
 * L'erreur levée, pour les assertions qui portent sur son **contenu** — statut,
 * `details` — et pas seulement sur son type. `expect(fn).toThrow(Classe)` ne
 * rend pas l'instance, et un test qui se contenterait du type laisserait passer
 * un `details` vide ou faux.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('aucune erreur levée alors qu’un échec était attendu');
}

describe('requireSlug', () => {
  it('normalise un slug fourni au lieu de le prendre tel quel', () => {
    // Le DTO en a déjà validé la forme ; y repasser garantit qu'une validation
    // et une normalisation divergentes ne puissent pas coexister.
    expect(requireSlug('Massage-60-MIN', 'slug')).toBe('massage-60-min');
  });

  it('lève un 422 qui nomme le champ à corriger', () => {
    // Le nom quand le slug est dérivé, le slug quand il est fourni : l'appelant
    // doit savoir lequel des deux changer, et il n'a pas envoyé le premier.
    expect(() => requireSlug('指圧', 'name')).toThrow(BusinessRuleError);

    expect(thrownBy(() => requireSlug('指圧', 'name'))).toMatchObject({
      status: 422,
      code: 'BUSINESS_RULE_VIOLATION',
      details: { field: 'name' },
    });
    expect(thrownBy(() => requireSlug('!!!', 'slug'))).toMatchObject({
      details: { field: 'slug' },
    });
  });
});
