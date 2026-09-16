/**
 * Le calendrier mensuel du sélecteur de créneau (#827).
 *
 * `docs/design/appointments/wireframes.md` étape 3 dessine un calendrier —
 * « ‹ août 2026 › », une ligne `L M M J V S D`, la date retenue mise en avant —
 * et le CDC §1.4 prescrit un « calendrier de disponibilité temps réel ». Ce qui
 * était rendu était une bande de journées à faire défiler, dont trois et demie
 * tenaient à 360 px.
 *
 * Éprouvé sur `SlotPicker` directement plutôt qu'au travers de ses deux écrans :
 * c'est le composant partagé qui porte le calendrier, et les deux appelants n'en
 * diffèrent que par ce qu'ils font d'un changement de mois — un état dans le
 * tunnel, une navigation dans le report.
 */

import type { AvailabilitySlot, CalendarDate, DayAvailability, UtcInstant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlotPicker } from '@/components/booking/slot-picker';
import type { BookingWindow } from '@/lib/booking/month-grid';

const TIMEZONE = 'UTC';

/**
 * La fenêtre de l'essai : du 16 septembre au 16 octobre 2026, soit exactement
 * les trente et un jours du contrat, et deux mois à parcourir.
 */
const BOUNDS: BookingWindow = {
  first: '2026-09-16' as CalendarDate,
  last: '2026-10-16' as CalendarDate,
};

function slot(date: string, heure: string): AvailabilitySlot {
  const startsAt = `${date}T${heure}:00:00.000Z` as UtcInstant;

  return { startsAt, endsAt: startsAt, staffId: '11111111-1111-4111-8111-111111111111' };
}

/** Les journées d'un mois telles que l'API les rend — une entrée par jour demandé. */
function journees(dates: readonly string[], ouvertes: readonly string[]): readonly DayAvailability[] {
  return dates.map((date) => ({
    date: date as CalendarDate,
    slots: ouvertes.includes(date) ? [slot(date, '09'), slot(date, '10')] : [],
  }));
}

const SEPTEMBRE = journees(
  ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'],
  ['2026-09-17', '2026-09-18'],
);

const OCTOBRE = journees(['2026-10-01', '2026-10-02'], ['2026-10-02']);

function afficher(options: {
  readonly days?: readonly DayAvailability[] | null;
  readonly month?: string;
  readonly onMonthChange?: (month: string) => void;
  readonly onChoose?: (startsAt: UtcInstant) => void;
}): ReturnType<typeof userEvent.setup> {
  render(
    <SlotPicker
      days={options.days === undefined ? SEPTEMBRE : options.days}
      month={options.month ?? '2026-09'}
      bounds={BOUNDS}
      onMonthChange={options.onMonthChange ?? vi.fn()}
      timeZone={TIMEZONE}
      emptyState={<p>Aucun créneau</p>}
      onChoose={options.onChoose ?? vi.fn()}
    />,
  );

  return userEvent.setup();
}

/** La case du calendrier dont le nom accessible commence par cette date. */
function journee(nom: string | RegExp): HTMLElement {
  return within(screen.getByRole('grid', { name: /Journée/ })).getByRole('button', { name: nom });
}

afterEach(() => {
  cleanup();
});

describe('la grille du mois', () => {
  it('coiffe les colonnes des sept jours, lundi en tête', () => {
    afficher({});

    const entetes = screen.getAllByRole('columnheader');

    expect(entetes.map((entete) => entete.getAttribute('aria-label'))).toEqual([
      'lundi',
      'mardi',
      'mercredi',
      'jeudi',
      'vendredi',
      'samedi',
      'dimanche',
    ]);
    // L'initiale reste visible : c'est elle qui tient sur sept colonnes à 360 px.
    expect(entetes[0]?.textContent).toBe('L');
  });

  it('rend le mois entier, jours hors fenêtre compris', () => {
    afficher({});

    // Le 1er septembre précède la fenêtre : la case existe et se lit, mais elle
    // n'est pas réservable.
    const avant = journee(/^mardi 1 septembre 2026/);

    expect(avant.getAttribute('aria-label')).toContain('hors de la période de réservation');
    expect(avant.getAttribute('aria-disabled')).toBe('true');
    // `aria-disabled` et non `disabled` : la case reste atteignable au clavier —
    // c'est précisément son état qu'on vient y lire.
    expect(avant.hasAttribute('disabled')).toBe(false);
  });

  it('dit le nombre de créneaux d’une journée libre et le mot « complet » d’une journée pleine', () => {
    afficher({});

    expect(journee(/17 septembre 2026/).getAttribute('aria-label')).toBe(
      'jeudi 17 septembre 2026 — 2 créneaux',
    );
    expect(journee(/16 septembre 2026/).getAttribute('aria-label')).toBe(
      'mercredi 16 septembre 2026 — complet',
    );
  });

  it('marque la journée retenue sur sa cellule, là où le lecteur d’écran la lit', () => {
    afficher({});

    // À défaut de choix, le sélecteur retient la première journée ouverte.
    const cellule = journee(/17 septembre 2026/).closest('[role="gridcell"]');

    expect(cellule?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: /jeudi 17 septembre 2026/ })).toBeDefined();
  });

  it('reste opérable pendant le chargement, sous un squelette de grille', () => {
    // `states.md` étape 3 : « grille de créneaux en squelette, en gardant la
    // navigation de dates interactive pour changer de jour sans attendre ».
    afficher({ days: null });

    expect(screen.getByRole('grid', { name: /Journée/ })).toBeDefined();
    expect(journee(/17 septembre 2026/).getAttribute('aria-label')).toContain(
      'disponibilités en cours de chargement',
    );
  });

  it('garde le calendrier à l’écran quand le mois n’a rien à proposer', () => {
    // C'est ce qui change avec lui : la bande disparaissait, emportant la seule
    // commande qui menait ailleurs.
    afficher({ days: journees(['2026-09-16', '2026-09-17'], []) });

    expect(screen.getByText('Aucun créneau')).toBeDefined();
    expect(screen.getByRole('grid', { name: /Journée/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeDefined();
  });
});

describe('la navigation de mois', () => {
  it('annonce le mois affiché entre les deux chevrons', () => {
    afficher({});

    expect(screen.getByText('septembre 2026')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mois précédent' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeDefined();
  });

  it('remonte le mois demandé à l’appelant, qui seul sait recharger', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });

    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));

    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('éteint le chevron qui ne mène nulle part, sans le retirer du clavier', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    const avant = screen.getByRole('button', { name: 'Mois précédent' });

    expect(avant.getAttribute('aria-disabled')).toBe('true');
    expect(avant.hasAttribute('disabled')).toBe(false);

    await user.click(avant);

    expect(onMonthChange).not.toHaveBeenCalled();
  });

  it('éteint le chevron suivant au dernier mois de la fenêtre', () => {
    afficher({ days: OCTOBRE, month: '2026-10' });

    expect(screen.getByRole('button', { name: 'Mois suivant' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Mois précédent' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('laisse le focus sur le chevron, pour enchaîner les mois sans viser de nouveau', async () => {
    const user = afficher({ onMonthChange: vi.fn() });
    const apres = screen.getByRole('button', { name: 'Mois suivant' });

    await user.click(apres);

    expect(document.activeElement).toBe(apres);
  });
});

describe('le clavier du calendrier', () => {
  it('n’a qu’un seul arrêt de tabulation — le roving tabindex', () => {
    afficher({});

    const grille = screen.getByRole('grid', { name: /Journée/ });
    const arrets = [...grille.querySelectorAll('button')].filter(
      (bouton) => bouton.getAttribute('tabindex') === '0',
    );

    expect(arrets).toHaveLength(1);
    expect(arrets[0]?.getAttribute('aria-label')).toContain('17 septembre 2026');
  });

  it('déplace le focus et retient la journée sous une flèche', async () => {
    const user = afficher({});

    journee(/17 septembre 2026/).focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('18 septembre 2026');
    expect(screen.getByRole('heading', { name: /vendredi 18 septembre 2026/ })).toBeDefined();
  });

  it('descend d’une semaine sous `↓`, et ne boucle pas au bord de la fenêtre', async () => {
    const user = afficher({});

    journee(/17 septembre 2026/).focus();
    await user.keyboard('{ArrowUp}');

    // Le 10 septembre précède la fenêtre : le déplacement s'arrête sur sa borne.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('16 septembre 2026');

    await user.keyboard('{ArrowUp}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('16 septembre 2026');
  });

  it('change de mois sous `PageSuiv`, et le remonte à l’appelant', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });

    journee(/17 septembre 2026/).focus();
    await user.keyboard('{PageDown}');

    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('atteint une journée complète sans la retenir', async () => {
    const user = afficher({});

    journee(/17 septembre 2026/).focus();
    await user.keyboard('{ArrowLeft}');

    // Le 16 est complet : le focus s'y pose — c'est là qu'on lit « complet » —
    // mais la grille continue de détailler la journée qui était retenue.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('complet');
    expect(screen.getByRole('heading', { name: /jeudi 17 septembre 2026/ })).toBeDefined();
  });
});
