import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminRail } from '@/app/(admin)/[tenantSlug]/admin/components/admin-rail';

/*
 * Le rail du back-office (#48).
 *
 * Ce que la suite protège : qu'aucune entrée inerte ne se présente comme un
 * lien, que le repère de section survive aux paramètres d'URL, que le contexte
 * du salon soit lu tel qu'il est écrit, et que la déconnexion ne parte qu'une
 * fois même sur un double clic.
 */

const adminLogoutAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
let pathname = '/maison-lotus/admin/calendrier';

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

const LOTUS = { slug: 'maison-lotus', name: 'Maison Lotus' };

afterEach(() => {
  cleanup();
  pathname = '/maison-lotus/admin/calendrier';
  adminLogoutAction.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

function renderRail(
  overrides: Partial<Parameters<typeof AdminRail>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <AdminRail
      establishments={[LOTUS]}
      role="manager"
      tenantSlug="maison-lotus"
      timeZone="Indian/Antananarivo"
      userName="Hasina R."
      {...overrides}
    />,
  );
}

describe('rail — la navigation', () => {
  it('mène aux écrans servis et n’en invente aucun', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/calendrier',
    );
    expect(screen.getByRole('link', { name: 'Prestations' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/catalogue',
    );
    // Branchés depuis #480 : les deux écrans existaient et n'étaient
    // atteignables qu'en tapant leur URL.
    expect(screen.getByRole('link', { name: 'Clients' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/clients',
    );
    expect(screen.getByRole('link', { name: 'Personnel' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/personnel',
    );
  });

  it('annonce les sections non livrées sans en faire des liens', () => {
    renderRail();

    // Le nom accessible porte la raison : sans elle, un lecteur d'écran
    // n'annoncerait qu'un mot inerte.
    expect(screen.queryByRole('link', { name: /Reporting/ })).toBeNull();

    const reporting = screen.getByText('Reporting');

    expect(reporting.getAttribute('aria-disabled')).toBe('true');
    expect(reporting.textContent).toMatch(/à venir/);
  });

  it('marque la section courante, paramètres d’URL compris', () => {
    pathname = '/maison-lotus/admin/calendrier';
    renderRail();

    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('link', { name: 'Prestations' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('suit la section jusque dans ses écrans descendants', () => {
    pathname = '/maison-lotus/admin/catalogue/nouveau';
    renderRail();

    expect(screen.getByRole('link', { name: 'Prestations' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('cache les réglages à une gérante et les montre à une administratrice', () => {
    renderRail();
    expect(screen.queryByText('Réglages')).toBeNull();

    cleanup();
    renderRail({ role: 'admin' });
    expect(screen.getByRole('link', { name: 'Réglages' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/reglages',
    );
  });
});

describe('rail — le contexte du salon', () => {
  it('nomme l’établissement et écrit son fuseau en clair', () => {
    // Toutes les heures du back-office sont écrites dans le fuseau du salon :
    // un opérateur qui consulte depuis ailleurs doit pouvoir le constater sans
    // le chercher.
    renderRail();

    expect(screen.getAllByText('Maison Lotus').length).toBeGreaterThan(0);
    expect(screen.getByText(/Indian\/Antananarivo/)).toBeDefined();
    expect(screen.getByText(/Hasina R\., gérant·e/)).toBeDefined();
  });

  it('n’offre aucun choix quand le compte ne gère qu’un salon', () => {
    renderRail();

    expect(screen.queryByRole('navigation', { name: /Changer d’établissement/ })).toBeNull();
  });

  it('offre les autres établissements dès qu’il y en a', () => {
    renderRail({
      establishments: [LOTUS, { slug: 'villa-ravinala', name: 'Villa Ravinala' }],
    });

    const switcher = screen.getByRole('navigation', { name: /Changer d’établissement/ });

    // Le salon courant n'est pas répété dans la liste : on n'y va pas, on y est.
    expect(within(switcher).queryByRole('link', { name: 'Maison Lotus' })).toBeNull();
    expect(within(switcher).getByRole('link', { name: 'Villa Ravinala' }).getAttribute('href')).toBe(
      '/villa-ravinala/admin/calendrier',
    );
  });
});

describe('rail — la déconnexion', () => {
  it('ferme la session et quitte l’écran sans le laisser dans l’historique', async () => {
    renderRail();

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));

    expect(adminLogoutAction).toHaveBeenCalledWith('maison-lotus');
    // `replace` et non `push` : sur un poste de comptoir partagé, un
    // « précédent » réafficherait le planning depuis le cache du routeur.
    expect(replace).toHaveBeenCalledWith('/maison-lotus/admin/connexion');
    expect(refresh).toHaveBeenCalled();
  });

  it('ne part qu’une fois sur un double clic', async () => {
    let release = (): void => {};
    adminLogoutAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            resolve();
          };
        }),
    );

    renderRail();
    const button = screen.getByRole('button', { name: 'Se déconnecter' });

    await userEvent.dblClick(button);

    expect(adminLogoutAction).toHaveBeenCalledTimes(1);
    release();
  });
});
