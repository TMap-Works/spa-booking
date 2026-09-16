/**
 * La lecture du slug d'établissement depuis le chemin courant (#703, #710).
 *
 * Cette fonction était écrite trois fois, caractère pour caractère — frontières
 * `not-found` du report de rendez-vous (#627), de la fiche praticien (#696) et
 * de la fiche prestation (#697). Elle vit désormais dans `lib/tenant-slug.ts`,
 * où les trois frontières la lisent — les deux premières y ont été branchées
 * par #703, la troisième par #710 —, et c'est ici que ses deux gardes sont
 * tenues :
 *
 * 1. premier segment absent → `null`, jamais une chaîne vide, faute de quoi le
 *    chemin reconstruit commence par `//` et sort du site ;
 * 2. `decodeURIComponent` enveloppé, faute de quoi un échappement tronqué
 *    remplace le 404 par la frontière d'erreur.
 *
 * Les suites des trois frontières n'en gardent qu'un cas chacune — celui qui
 * prouve qu'un `null` fait bien taire le lien. L'énumération des façons de ne
 * pas lire un slug est ici, une fois.
 */

import { describe, expect, it } from 'vitest';

import { tenantSlugFromPathname } from '@/lib/tenant-slug';

describe('tenantSlugFromPathname', () => {
  it('rend le premier segment du chemin', () => {
    expect(tenantSlugFromPathname('/salon-lotus/admin/personnel/pas-un-uuid')).toBe('salon-lotus');
  });

  it('ignore ce qui suit le premier segment, quelle qu’en soit la profondeur', () => {
    expect(
      tenantSlugFromPathname(
        '/spa-lumiere/compte/rendez-vous/00000000-0000-4000-8000-000000000000/report',
      ),
    ).toBe('spa-lumiere');
  });

  /**
   * `usePathname()` rend le chemin **encodé**, et les constructeurs de chemins
   * réencodent ce qu'on leur donne : sans ce décodage, un slug à espace serait
   * encodé deux fois et le lien de retour pointerait à côté.
   */
  it('décode le segment avant de le rendre', () => {
    expect(tenantSlugFromPathname('/salon%20des%20lilas/compte')).toBe('salon des lilas');
  });

  it('décode aussi les caractères hors ASCII', () => {
    expect(tenantSlugFromPathname('/institut-beaut%C3%A9/admin')).toBe('institut-beauté');
  });

  /**
   * Première garde. Une chaîne vide rendue ici donnerait `//admin/...` ou
   * `//compte`, que le navigateur lit comme l'URL **absolue** `https://admin/...`
   * ou `https://compte/` : la seule issue de l'écran sortirait du site. C'est
   * `null` — et donc l'absence de lien — qui l'empêche.
   */
  it.each([
    ['la racine', '/'],
    ['la chaîne vide', ''],
    ['une barre oblique redoublée', '//admin/personnel'],
  ])('rend null quand le premier segment manque (%s)', (_cas, chemin) => {
    expect(tenantSlugFromPathname(chemin)).toBeNull();
  });

  /**
   * Seconde garde. `decodeURIComponent('%')` lève `URIError` ; non rattrapée
   * dans une frontière `not-found`, l'exception remplacerait le 404 par la
   * frontière d'erreur — l'écran même dont #627, #696 et #697 cherchaient à
   * sortir.
   */
  it.each([
    ['un échappement tronqué', '/salon%/compte'],
    ['une séquence incomplète', '/%E0%A4%A/admin/personnel/pas-un-uuid'],
    ['un octet isolé invalide en UTF-8', '/%FF/admin'],
  ])('rend null plutôt que de lever quand le segment ne se décode pas (%s)', (_cas, chemin) => {
    expect(() => tenantSlugFromPathname(chemin)).not.toThrow();
    expect(tenantSlugFromPathname(chemin)).toBeNull();
  });
});
