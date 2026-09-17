import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NAVIGATION_PROGRESS_MAX_MS,
  NavigationProgress,
} from '@/components/ui/navigation-progress';

/*
 * L'indicateur global de navigation (#830).
 *
 * Ce que la suite protège : qu'un clic sur un lien interne allume la barre
 * **tout de suite** — c'est le constat du PO, « aucun chargement » —, qu'elle
 * s'éteigne à l'arrivée de l'URL, chemin ou paramètres, et qu'elle ne reste
 * jamais allumée pour rien.
 */

let pathname = '/maison-lotus/admin/calendrier';
let search = '';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  window.history.replaceState(null, '', '/maison-lotus/admin/calendrier');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  pathname = '/maison-lotus/admin/calendrier';
  search = '';
});

function bar(): Element | null {
  return document.querySelector('.spa-progress');
}

/** Un lien posé hors du composant, comme ceux du rail ou d'une page. */
function linkTo(href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = 'Écran';
  // Le routeur annule la navigation du navigateur ; jsdom, lui, ne sait pas
  // naviguer et le signalerait.
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
  });
  document.body.append(anchor);
  return anchor;
}

function clickOn(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
}

describe('indicateur de navigation', () => {
  it('ne montre rien tant qu’aucun clic n’a eu lieu', () => {
    render(<NavigationProgress />);

    expect(bar()).toBeNull();
  });

  it('s’allume au clic sur un lien vers un autre écran, et reste muet pour les lecteurs d’écran', () => {
    render(<NavigationProgress />);

    clickOn(linkTo('/maison-lotus/admin/clients'));

    expect(bar()).not.toBeNull();
    expect(bar()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('s’éteint quand l’écran suivant a pris l’URL', () => {
    const { rerender } = render(<NavigationProgress />);
    clickOn(linkTo('/maison-lotus/admin/clients'));

    pathname = '/maison-lotus/admin/clients';
    rerender(<NavigationProgress />);

    expect(bar()).toBeNull();
  });

  it('s’éteint aussi quand seuls les paramètres changent — la journée suivante du planning', () => {
    const { rerender } = render(<NavigationProgress />);
    clickOn(linkTo('/maison-lotus/admin/calendrier?date=2026-09-18'));
    expect(bar()).not.toBeNull();

    search = 'date=2026-09-18';
    rerender(<NavigationProgress />);

    expect(bar()).toBeNull();
  });

  it('ne s’allume pas pour l’écran déjà ouvert, que rien ne viendrait éteindre', () => {
    render(<NavigationProgress />);

    clickOn(linkTo('/maison-lotus/admin/calendrier'));

    expect(bar()).toBeNull();
  });

  it('ne s’allume pas pour une ouverture dans un nouvel onglet', () => {
    render(<NavigationProgress />);

    clickOn(linkTo('/maison-lotus/admin/clients'), { ctrlKey: true });

    expect(bar()).toBeNull();
  });

  it('s’éteint d’elle-même si aucune URL n’arrive — une redirection vers l’écran de départ', () => {
    vi.useFakeTimers();
    render(<NavigationProgress />);
    clickOn(linkTo('/maison-lotus/admin/clients'));
    expect(bar()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(NAVIGATION_PROGRESS_MAX_MS - 1);
    });
    expect(bar()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()).toBeNull();
  });

  it('s’éteint quand l’onglet revient du cache d’historique, où aucune URL ne change', () => {
    render(<NavigationProgress />);
    clickOn(linkTo('/maison-lotus/compte'));
    expect(bar()).not.toBeNull();

    // Un affichage ordinaire de la page ne dit rien à l'indicateur…
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    expect(bar()).not.toBeNull();

    // …une page restaurée par le bfcache, si : son état est celui du départ.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(bar()).toBeNull();
  });

  it('cesse d’écouter une fois démonté', () => {
    const { unmount } = render(<NavigationProgress />);
    const anchor = linkTo('/maison-lotus/admin/clients');
    unmount();

    clickOn(anchor);

    expect(bar()).toBeNull();
  });
});
