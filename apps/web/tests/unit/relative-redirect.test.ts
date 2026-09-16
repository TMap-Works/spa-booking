// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { redirectWithinSite } from '@/lib/relative-redirect';

/**
 * La redirection des routes de session — relative, et bornée au site (#856).
 *
 * Relative parce que l'hôte de `request.nextUrl` est l'adresse d'écoute du
 * serveur, jamais celle du navigateur ; bornée parce qu'un `Location` sert
 * aussi de tremplin à qui sait y glisser un autre domaine.
 */
describe('redirectWithinSite', () => {
  it('rend un 307 dont la destination est le chemin tel quel', () => {
    const response = redirectWithinSite('/maison-lotus/admin/reglages?onglet=horaires');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/maison-lotus/admin/reglages?onglet=horaires');
  });

  it('laisse poser des cookies sur la réponse', () => {
    const response = redirectWithinSite('/maison-lotus/admin/calendrier');
    response.cookies.set('spa_admin_access', 'jeton', { path: '/maison-lotus/admin' });

    expect(response.cookies.get('spa_admin_access')?.value).toBe('jeton');
  });

  it('encode une destination décodée au lieu de lever', () => {
    const response = redirectWithinSite('/maison-lotus/admin/日本\r\n?q=é');

    expect(response.headers.get('location')).toBe(
      '/maison-lotus/admin/%E6%97%A5%E6%9C%AC?q=%C3%A9',
    );
  });

  it.each([
    'https://exemple.test/piege',
    '//exemple.test/piege',
    '/\\exemple.test/piege',
    // Le bon préfixe, mais `//exemple.test` une fois les `..` résolus : un
    // `Location` relatif l'enverrait sur un autre domaine.
    '/maison-lotus/admin/../..//exemple.test/piege',
    '/maison-lotus/admin/%2e%2e/%2e%2e//exemple.test/piege',
    'maison-lotus/admin',
    '',
  ])('refuse une destination hors du site — « %s »', (destination) => {
    expect(() => redirectWithinSite(destination)).toThrow(/hors du site/);
  });
});
