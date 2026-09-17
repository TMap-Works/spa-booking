import { describe, expect, it } from 'vitest';

import { salonSlugFromAddress } from '@/lib/salon-address';

/**
 * #927 — ce qu'une personne tape pour désigner son salon.
 *
 * Le champ de l'accueil remplace la saisie d'une URL : il doit donc accepter
 * toutes les formes sous lesquelles on connaît l'adresse d'un salon, et
 * refuser d'emblée ce qu'aucun salon ne peut porter.
 */

describe('les formes d’une même adresse', () => {
  it.each([
    ['le slug', 'maison-lotus'],
    ['le slug en capitales, entouré d’espaces', '  Maison-Lotus  '],
    ['le nom lu sur la devanture', 'Maison Lotus'],
    ['un lien de réservation collé', 'https://reservation.exemple.fr/maison-lotus/reservation'],
    ['un lien sans schéma', 'reservation.exemple.fr/maison-lotus'],
    ['un lien local de recette', 'localhost:3000/maison-lotus/compte/connexion'],
    ['un chemin nu', '/maison-lotus/reservation'],
    ['une adresse par sous-domaine', 'https://maison-lotus.exemple.fr/'],
    ['un sous-domaine sans schéma', 'maison-lotus.exemple.fr'],
    ['un sous-domaine local', 'maison-lotus.localhost:3000'],
    ['le lien d’un e-mail par sous-domaine', 'https://maison-lotus.exemple.fr/compte'],
    ['un lien de réservation par sous-domaine', 'maison-lotus.exemple.fr/reservation'],
  ])('lit %s', (_forme, saisie) => {
    expect(salonSlugFromAddress(saisie)).toBe('maison-lotus');
  });

  it('retire les accents et les signes d’un nom', () => {
    expect(salonSlugFromAddress('L’Atelier de Zoé & Cie')).toBe('l-atelier-de-zoe-cie');
  });

  it('relit comme un nom une saisie qui porte une barre et des espaces', () => {
    expect(salonSlugFromAddress('Coiffure 24/7')).toBe('coiffure-24-7');
  });

  it('décode un segment échappé', () => {
    expect(salonSlugFromAddress('https://exemple.fr/salon%2Dlilas')).toBe('salon-lilas');
  });
});

describe('ce qui ne désigne aucun salon', () => {
  it.each([
    ['une saisie vide', ''],
    ['des espaces', '   '],
    ['des signes seuls', '— ! —'],
    ['un nom réservé', 'www'],
    ['un nom réservé, en lien', 'https://exemple.fr/admin'],
  ])('refuse %s', (_cas, saisie) => {
    expect(salonSlugFromAddress(saisie)).toBeNull();
  });

  it('ne prend pas le domaine lui-même pour un salon', () => {
    // `exemple.fr` n'a pas d'étiquette de salon devant lui, et `www` est
    // réservé. Un lien qui ne désigne rien ne se relit pas comme un nom.
    expect(salonSlugFromAddress('https://www.exemple.fr/')).toBeNull();
    expect(salonSlugFromAddress('https://exemple.fr')).toBeNull();
  });

  it('relit comme un nom un mot pointé qui n’a rien d’un lien', () => {
    expect(salonSlugFromAddress('Beauty.Bar')).toBe('beauty-bar');
  });

  it('ne lève pas sur un échappement tronqué', () => {
    expect(salonSlugFromAddress('https://exemple.fr/salon%')).toBeNull();
  });
});
