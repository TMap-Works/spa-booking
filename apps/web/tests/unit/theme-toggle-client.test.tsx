import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookingTunnelHeader } from '@/components/booking/tunnel-header';
import { SalonShell } from '@/components/salon/salon-shell';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { THEME_COOKIE } from '@/lib/theme';

import { tenant } from './fixtures';

/*
 * Le sélecteur de thème sur la partie cliente — #1114.
 *
 * Le mécanisme existait depuis #1058 (cookie `spa-theme`, script d'amorçage,
 * jeu sombre explicite), mais seul le back-office montait le sélecteur : la
 * cliente suivait le réglage de son appareil sans pouvoir choisir.
 *
 * Le gabarit public le monte **deux fois** — dans l'en-tête, visible au-delà de
 * 48 rem, et dans le pied, visible en dessous. jsdom ne peint rien : la
 * répartition se lit donc sur les classes que `salon-shell.css` cible, et la
 * suite vérifie surtout ce qui ne se voit qu'à l'usage — que les deux
 * exemplaires restent d'accord quand la fenêtre franchit le seuil.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => `/${tenant.slug}`,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

const SELECTEUR = { name: 'Thème d’affichage' } as const;

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0`;
});

function coche(radio: HTMLElement): boolean {
  return (radio as HTMLInputElement).checked;
}

/** Le bouton radio du `rang`-ième sélecteur de la page, dans l'ordre du document. */
function option(nom: string, rang: number): HTMLElement {
  const radio = screen.getAllByRole('radio', { name: nom })[rang];
  if (radio === undefined) {
    throw new Error(`aucun sélecteur de rang ${rang} pour « ${nom} »`);
  }
  return radio;
}

describe('le gabarit public du salon', () => {
  it('porte le sélecteur dans l’en-tête et dans le pied de page', () => {
    render(
      <SalonShell
        tenantSlug={tenant.slug}
        tenant={tenant}
        signedIn={false}
        presence={null}
        bookingHref={`/${tenant.slug}/reservation`}
      >
        <p>contenu de l’écran</p>
      </SalonShell>,
    );

    const enTete = within(screen.getByRole('banner')).getByRole('group', SELECTEUR);
    const pied = within(screen.getByRole('contentinfo')).getByRole('group', SELECTEUR);

    // Les classes que `salon-shell.css` bascule à 48 rem : l'en-tête au-delà,
    // le pied en dessous. Sans elles, les deux s'afficheraient ensemble.
    expect(enTete.classList.contains('spa-shell__theme')).toBe(true);
    expect(pied.classList.contains('spa-shell__footer-theme')).toBe(true);
  });
});

describe('le tunnel de réservation', () => {
  it('n’a pas de sélecteur : son en-tête se borne à revenir et quitter (BM-TUNNEL-10)', () => {
    render(
      <BookingTunnelHeader
        tenantName={tenant.name}
        exitHref={`/${tenant.slug}`}
        onBack={() => undefined}
        unsavedWork={false}
      />,
    );

    expect(screen.queryByRole('group', SELECTEUR)).toBeNull();
  });
});

describe('deux sélecteurs sur une même page', () => {
  it('restent d’accord : un choix fait dans l’un se voit dans l’autre', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    );

    await user.click(option('Thème sombre', 0));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    await waitFor(() => {
      expect(coche(option('Thème sombre', 1))).toBe(true);
    });

    // Et dans l'autre sens, jusqu'au retour au réglage du système.
    await user.click(option('Thème du système', 1));

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    await waitFor(() => {
      expect(coche(option('Thème du système', 0))).toBe(true);
    });
  });

  it('se recale sur le choix déjà posé par le script d’amorçage', () => {
    document.documentElement.setAttribute('data-theme', 'light');

    render(<ThemeToggle />);

    expect(coche(screen.getByRole('radio', { name: 'Thème clair' }))).toBe(true);
  });
});
