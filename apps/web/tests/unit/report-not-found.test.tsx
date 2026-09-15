import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReportAppointmentNotFound from '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/report/not-found';

/**
 * La frontière `not-found` du report (#627).
 *
 * Ce que la suite protège : qu'un rendez-vous introuvable soit annoncé comme
 * tel — et non comme une adresse publique erronée —, qu'il reste au moins une
 * issue cliquable vers l'espace client, et que le chemin de retour se
 * reconstruise sans se réencoder au passage.
 */

let pathname = '/spa-lumiere/compte/rendez-vous/00000000-0000-4000-8000-000000000000/report';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

afterEach(() => {
  cleanup();
  pathname = '/spa-lumiere/compte/rendez-vous/00000000-0000-4000-8000-000000000000/report';
});

describe('ReportAppointmentNotFound', () => {
  it('annonce le rendez-vous introuvable, et non une adresse erronée', () => {
    render(<ReportAppointmentNotFound />);

    expect(
      screen.getByRole('heading', { name: /ce rendez-vous n’est plus disponible/i }),
    ).toBeDefined();
    // Le message du 404 générique n'a rien à faire ici : la cliente est dans son
    // propre espace et n'a suivi aucun lien du salon.
    expect(screen.queryByText(/le lien que le salon vous a communiqué/i)).toBeNull();
  });

  it('laisse une issue vers les rendez-vous de la cliente', () => {
    render(<ReportAppointmentNotFound />);

    const back = screen.getByRole('link', { name: /revenir à mes rendez-vous/i });

    expect(back.getAttribute('href')).toBe('/spa-lumiere/compte');
  });

  it('ne réencode pas un slug déjà encodé dans le chemin', () => {
    pathname = '/salon%20des%20lilas/compte/rendez-vous/abc/report';

    render(<ReportAppointmentNotFound />);

    expect(
      screen.getByRole('link', { name: /revenir à mes rendez-vous/i }).getAttribute('href'),
    ).toBe('/salon%20des%20lilas/compte');
  });

  it('ne fabrique jamais un lien qui sort du site', () => {
    // `accountPath('')` rend `//compte`, que le navigateur lit comme l'URL
    // **absolue** `https://compte/`. Aucun href du panneau ne doit y ressembler.
    pathname = '/';

    render(<ReportAppointmentNotFound />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByRole('heading', { name: /ce rendez-vous n’est plus disponible/i }),
    ).toBeDefined();
  });

  it('survit à un segment que `decodeURIComponent` refuse', () => {
    // Un échappement tronqué lève `URIError` : non rattrapé, il remplacerait le
    // 404 par la frontière d'erreur — l'écran que #627 fait disparaître.
    pathname = '/salon%/compte/rendez-vous/abc/report';

    render(<ReportAppointmentNotFound />);

    expect(
      screen.getByRole('heading', { name: /ce rendez-vous n’est plus disponible/i }),
    ).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('ne dit pas laquelle des trois situations s’est produite', () => {
    render(<ReportAppointmentNotFound />);

    // Annulé, déplacé ou passé : les trois doivent rester indiscernables, sans
    // quoi l'écran confirme l'existence d'un rendez-vous à qui essaie des
    // identifiants au hasard (tenant-isolation §4).
    expect(screen.getByText(/annulé, déjà déplacé, ou avoir eu lieu/i)).toBeDefined();
  });
});
