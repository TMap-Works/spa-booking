import { afterEach, describe, expect, it } from 'vitest';

import {
  isTrackedNavigation,
  type CurrentLocation,
  type NavigationClick,
} from '@/lib/navigation-intent';

/*
 * Quel clic allume l'indicateur de navigation (#830).
 *
 * Ce que la suite protège : que la barre ne s'allume que pour un clic qui quitte
 * vraiment l'écran courant **dans cet onglet**. Une barre allumée pour un
 * nouvel onglet, un téléchargement ou une ancre ne s'éteindrait jamais — aucune
 * URL ne changerait dans la page.
 */

const HERE: CurrentLocation = {
  href: 'http://localhost:3000/maison-lotus/admin/calendrier?date=2026-09-17',
  origin: 'http://localhost:3000',
  pathname: '/maison-lotus/admin/calendrier',
  search: '?date=2026-09-17',
};

afterEach(() => {
  document.body.innerHTML = '';
});

function link(attributes: Record<string, string>): HTMLAnchorElement {
  const anchor = document.createElement('a');
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  anchor.textContent = 'Clients';
  document.body.append(anchor);
  return anchor;
}

function click(target: EventTarget | null, overrides: Partial<NavigationClick> = {}): NavigationClick {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...overrides,
  };
}

describe('indicateur de navigation — les clics qui quittent l’écran', () => {
  it('suit un lien vers un autre écran du même site', () => {
    const anchor = link({ href: '/maison-lotus/admin/clients' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(true);
  });

  it('suit un lien qui ne change que les paramètres — la journée suivante du planning', () => {
    const anchor = link({ href: '/maison-lotus/admin/calendrier?date=2026-09-18' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(true);
  });

  it('remonte au lien depuis un descendant — le repère « en cours » lui-même', () => {
    const anchor = link({ href: '/maison-lotus/admin/reporting' });
    const inner = document.createElement('span');
    anchor.append(inner);

    expect(isTrackedNavigation(click(inner), HERE)).toBe(true);
  });

  it('accepte une cible `_self` explicite', () => {
    const anchor = link({ href: '/maison-lotus/admin/clients', target: '_self' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(true);
  });
});

describe('indicateur de navigation — les clics qui ne quittent rien', () => {
  it('ignore l’écran déjà ouvert : aucune URL ne changerait pour l’éteindre', () => {
    const anchor = link({ href: '/maison-lotus/admin/calendrier?date=2026-09-17' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });

  it('ignore une ancre dans la page', () => {
    const anchor = link({ href: '#contenu' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });

  it.each([
    ['le bouton du milieu', { button: 1 }],
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Maj', { shiftKey: true }],
    ['Alt', { altKey: true }],
  ])('ignore un clic avec %s — nouvel onglet, fenêtre ou téléchargement', (_, overrides) => {
    const anchor = link({ href: '/maison-lotus/admin/clients' });

    expect(isTrackedNavigation(click(anchor, overrides), HERE)).toBe(false);
  });

  it('ignore une cible qui ouvre un autre onglet', () => {
    const anchor = link({ href: '/maison-lotus/admin/clients', target: '_blank' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });

  it('ignore un téléchargement', () => {
    const anchor = link({ href: '/maison-lotus/admin/reporting?format=csv', download: '' });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });

  it.each([
    ['une autre origine', 'https://stripe.com/fr'],
    ['un courriel', 'mailto:contact@spa-lumiere.test'],
    ['un appel', 'tel:+261340000000'],
  ])('ignore %s : le navigateur a son propre indicateur', (_, href) => {
    const anchor = link({ href });

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });

  it('ignore un clic hors de tout lien', () => {
    const button = document.createElement('button');
    document.body.append(button);

    expect(isTrackedNavigation(click(button), HERE)).toBe(false);
    expect(isTrackedNavigation(click(null), HERE)).toBe(false);
  });

  it('ignore un `<a>` sans adresse', () => {
    const anchor = document.createElement('a');
    document.body.append(anchor);

    expect(isTrackedNavigation(click(anchor), HERE)).toBe(false);
  });
});
