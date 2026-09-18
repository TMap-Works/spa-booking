import type { BookedAppointment } from '@spa/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppointmentHistory } from '@/app/(account)/[tenantSlug]/compte/components/appointment-history';
import type { HistoryEntry } from '@/components/account/appointment-history';

import { service } from './fixtures';

/**
 * L'historique en liste groupée, filtrable et rejouable — #1054.
 *
 * La suite éprouve les trois critères d'acceptation du ticket et les motifs qui
 * les motivent :
 *
 * - **la mention du fuseau a quitté les lignes** — elle est en tête de liste, une
 *   fois, et seulement hors du fuseau du salon (`BM-RDV-06`) ;
 * - **le filtre ne recharge pas la page** — il est rendu par un îlot, et les
 *   lignes changent sans qu'aucune navigation ne parte ;
 * - **ce que la ligne porte** — bloc date, prestation, statut écrit
 *   (`BM-VISUEL-05`), et « Réserver à nouveau » sur ce qui se rejoue
 *   (`BM-HISTO-02`).
 *
 * La densité à 360 px, elle, ne se mesure pas ici : jsdom ne peint rien et
 * rendrait vert n'importe quel écart de mise en page. C'est la recette au
 * navigateur qui en fait foi.
 */

const MENTION = 'heure de Indian/Antananarivo';

/**
 * Le fuseau du visiteur est piloté par le test, comme dans
 * `appointment-card.test.tsx` : `timeZoneMention` lit celui du navigateur, et
 * une assertion dessus dépendrait sinon de la machine où la suite tourne.
 */
vi.mock('@/lib/format', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/format')>();

  return { ...actual, timeZoneMention: () => MENTION };
});

const TIME_ZONE = 'Europe/Paris';

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'completed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '44444444-4444-4444-8444-444444444444',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-21T08:00:00.000Z',
    endsAt: '2026-09-21T09:30:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

function entry(overrides: Partial<BookedAppointment> = {}, rebookHref: string | null = null): HistoryEntry {
  return {
    brief: {
      appointment: appointment(overrides),
      serviceName: service.name,
      practitioner: 'Hery',
      durationMinutes: 90,
    },
    rebookHref,
  };
}

/** Le panneau ouvert — les deux autres sont dans le document, mais vides. */
function panneau(): HTMLElement {
  const open = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');

  if (open === null) {
    throw new Error('aucun panneau ouvert');
  }

  return open;
}

afterEach(cleanup);

describe('la mention du fuseau quitte les lignes (#1054, BM-RDV-06)', () => {
  it('ne l’écrit qu’une fois, et pas sur une ligne', () => {
    render(<AppointmentHistory entries={[entry(), entry({ id: 'b' })]} timeZone={TIME_ZONE} />);

    expect(screen.getAllByText(new RegExp(MENTION))).toHaveLength(1);

    for (const ligne of panneau().querySelectorAll('.spa-history__meta')) {
      expect(ligne.textContent).not.toContain(MENTION);
    }
  });

  it('ne la sort pas du rendu serveur, qui ignore où est la visiteuse (#680)', () => {
    const markup = renderToStaticMarkup(
      <AppointmentHistory entries={[entry()]} timeZone={TIME_ZONE} />,
    );

    expect(markup).toContain('Massage suédois');
    expect(markup).not.toContain(MENTION);
  });
});

describe('ce que porte une ligne d’historique (#1054)', () => {
  it('nomme la prestation, la plage, la durée, le praticien, le prix et le statut', () => {
    render(<AppointmentHistory entries={[entry()]} timeZone={TIME_ZONE} />);

    const ligne = within(panneau());

    expect(ligne.getByText('Massage suédois')).toBeDefined();
    expect(panneau().querySelector('.spa-history__meta')?.textContent).toContain('10:00');
    expect(panneau().querySelector('.spa-history__meta')?.textContent).toContain('1 h 30');
    expect(panneau().querySelector('.spa-history__meta')?.textContent).toContain('Hery');
    expect(ligne.getByText('35,00 €')).toBeDefined();
    // Le statut est un mot, jamais une couleur seule (BM-VISUEL-05).
    expect(ligne.getByText('Honoré')).toBeDefined();
  });

  it('garde la date accessible en toutes lettres malgré le bloc abrégé', () => {
    render(<AppointmentHistory entries={[entry()]} timeZone={TIME_ZONE} />);

    expect(within(panneau()).getByText(/21 septembre 2026/)).toBeDefined();
  });

  it('dit ce que « Déplacé » laisse ouvert, et rien sur les pastilles qui se suffisent', () => {
    // Un report annule la ligne d'origine sans auteur (`lib/appointment-status.ts`).
    // La ligne d'explication que la carte compacte lui donnait (#1053) suit la
    // liste : « Déplacé » ne dit pas de lui-même où est passé le rendez-vous.
    const { rerender } = render(
      <AppointmentHistory entries={[entry({ status: 'cancelled' })]} timeZone={TIME_ZONE} />,
    );

    expect(within(panneau()).getByText('Déplacé')).toBeDefined();
    expect(within(panneau()).getByText(/libéré au profit d’un autre rendez-vous/)).toBeDefined();

    rerender(<AppointmentHistory entries={[entry()]} timeZone={TIME_ZONE} />);

    expect(panneau().querySelector('.spa-history__status-note')).toBeNull();
  });

  it('replie la note au salon au lieu de lui donner un encart', () => {
    render(
      <AppointmentHistory
        entries={[entry({ clientNote: 'Je serai peut-être en retard de dix minutes.' })]}
        timeZone={TIME_ZONE}
      />,
    );

    const note = panneau().querySelector('details.spa-history__note');

    expect(note).not.toBeNull();
    // Le texte est dans le résumé : il reste lisible par un lecteur d'écran
    // sans avoir à déplier, et n'est écrit qu'une fois dans le document.
    expect(screen.getAllByText(/peut-être en retard/)).toHaveLength(1);
  });
});

describe('le filtre segmenté (#1054)', () => {
  const lignes = [
    entry({ id: 'a', status: 'completed', startsAt: '2026-09-21T08:00:00.000Z' }),
    entry({
      id: 'b',
      status: 'cancelled',
      cancelledBy: 'client',
      startsAt: '2026-08-12T08:00:00.000Z',
    }),
    entry({ id: 'c', status: 'no_show', startsAt: '2026-08-03T08:00:00.000Z' }),
  ];

  it('ouvre sur « Tous » et compte ce que chaque filtre retient', () => {
    render(<AppointmentHistory entries={lignes} timeZone={TIME_ZONE} />);

    expect(screen.getByRole('tab', { name: /Tous/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Tous/ }).textContent).toContain('3');
    expect(screen.getByRole('tab', { name: /Honorés/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Annulés/ }).textContent).toContain('1');
    expect(panneau().querySelectorAll('.spa-history__row')).toHaveLength(3);
  });

  it('change les lignes sans navigation — la page n’est pas rechargée', () => {
    render(<AppointmentHistory entries={lignes} timeZone={TIME_ZONE} />);

    fireEvent.click(screen.getByRole('tab', { name: /Annulés/ }));

    const rows = panneau().querySelectorAll('.spa-history__row');

    expect(rows).toHaveLength(1);
    expect(within(panneau()).getByText('Annulé par vous')).toBeDefined();
    // Aucun lien : la rangée est faite de boutons, et rien dans cet îlot ne
    // pousse d'adresse — le filtre vit dans l'état du composant.
    expect(screen.getByRole('tab', { name: /Annulés/ }).tagName).toBe('BUTTON');
  });

  it('dit ce qu’il ne retient pas plutôt que de laisser un vide', () => {
    render(<AppointmentHistory entries={[lignes[2] as HistoryEntry]} timeZone={TIME_ZONE} />);

    fireEvent.click(screen.getByRole('tab', { name: /Honorés/ }));

    expect(within(panneau()).getByText(/Aucune visite honorée/)).toBeDefined();
  });

  it('groupe par mois, le plus récent d’abord', () => {
    render(<AppointmentHistory entries={lignes} timeZone={TIME_ZONE} />);

    const titres = [...panneau().querySelectorAll('.spa-history__month-title')].map(
      (titre) => titre.textContent,
    );

    expect(titres).toEqual(['Septembre 2026', 'Août 2026']);
  });
});

describe('« Réserver à nouveau » et « Voir plus » (#1054)', () => {
  it('pose le lien de reprise que la page a calculé, nommé par sa prestation', () => {
    render(
      <AppointmentHistory
        entries={[entry({}, '/maison-lotus/reservation?etape=creneau&prestation=x')]}
        timeZone={TIME_ZONE}
      />,
    );

    const lien = screen.getByRole('link', { name: /Réserver à nouveau — Massage suédois/ });

    expect(lien.getAttribute('href')).toBe('/maison-lotus/reservation?etape=creneau&prestation=x');
  });

  it('n’en pose aucun quand la page n’a rien à rouvrir', () => {
    render(<AppointmentHistory entries={[entry()]} timeZone={TIME_ZONE} />);

    expect(screen.queryByRole('link', { name: /Réserver à nouveau/ })).toBeNull();
  });

  it('s’arrête à dix lignes et dit combien le clic en ouvrira', () => {
    const douze = Array.from({ length: 12 }, (_, index) =>
      entry({ id: `rdv-${String(index)}`, startsAt: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00.000Z` }),
    );

    render(<AppointmentHistory entries={douze} timeZone={TIME_ZONE} />);

    expect(panneau().querySelectorAll('.spa-history__row')).toHaveLength(10);

    const plus = screen.getByRole('button', { name: 'Voir 2 rendez-vous de plus' });
    fireEvent.click(plus);

    expect(panneau().querySelectorAll('.spa-history__row')).toHaveLength(12);
    expect(screen.queryByRole('button', { name: /rendez-vous de plus/ })).toBeNull();
  });

  it('repart de la première page quand le filtre change', () => {
    const douze = Array.from({ length: 12 }, (_, index) =>
      entry({ id: `rdv-${String(index)}`, startsAt: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00.000Z` }),
    );

    render(<AppointmentHistory entries={douze} timeZone={TIME_ZONE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Voir 2 rendez-vous de plus' }));
    fireEvent.click(screen.getByRole('tab', { name: /Honorés/ }));

    expect(panneau().querySelectorAll('.spa-history__row')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Voir 2 rendez-vous de plus' })).toBeDefined();
  });
});
