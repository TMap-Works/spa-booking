/**
 * La navigation de période de la bande de journées (#738).
 *
 * `docs/design/appointments/wireframes.md` étape 3 coiffe la bande d'un
 * « ‹ août 2026 › » et la termine par « ( Voir plus de jours ) » ;
 * `states.md` étape 3 reprend la même navigation dans ses trois états. Ni l'une
 * ni l'autre n'était rendue : la bande listait ses quatorze dates et s'arrêtait,
 * dans un défilement horizontal sans affordance.
 *
 * Éprouvé sur `SlotPicker` directement plutôt qu'au travers de ses deux écrans :
 * c'est le composant partagé qui porte la commande, et les deux appelants n'en
 * diffèrent que par ce qu'ils font de « Voir plus de jours ».
 */

import type { AvailabilitySlot, CalendarDate, DayAvailability, UtcInstant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlotPicker } from '@/components/booking/slot-picker';
import { addCalendarDays } from '@/lib/booking/calendar';

/**
 * jsdom ne fournit pas `scrollIntoView` du tout — pas même une fonction vide.
 * Les chevrons l'appellent pour amener la journée visée sous les yeux, le focus
 * restant sur le chevron ; sans ce double, le clic lèverait une `TypeError`.
 * Installé sur le prototype et retiré par `delete`, comme `admin-rail.test.tsx`.
 */
const scrollIntoView = vi.fn();

const PREMIER_JOUR = '2026-09-28' as CalendarDate;
const TIMEZONE = 'UTC';

function slot(date: CalendarDate, heure: string): AvailabilitySlot {
  const startsAt = `${date}T${heure}:00:00.000Z` as UtcInstant;

  return { startsAt, endsAt: startsAt, staffId: '11111111-1111-4111-8111-111111111111' };
}

/**
 * Une fenêtre de `length` journées consécutives à partir du 28 septembre 2026,
 * toutes ouvertes — la bande franchit donc un changement de mois au quatrième
 * jour, ce qui est précisément ce que le libellé de période doit suivre.
 */
function fenetre(length: number): readonly DayAvailability[] {
  return Array.from({ length }, (_unused, index) => {
    const date = addCalendarDays(PREMIER_JOUR, index);

    return { date, slots: [slot(date, '09')] };
  });
}

function afficher(
  days: readonly DayAvailability[],
  onWiden?: () => void,
): ReturnType<typeof userEvent.setup> {
  render(
    <SlotPicker
      days={days}
      timeZone={TIMEZONE}
      emptyState={<p>Aucun créneau</p>}
      onWiden={onWiden}
      onChoose={vi.fn()}
    />,
  );

  return userEvent.setup();
}

/** La journée que la bande montre comme retenue. */
function journeeRetenue(): string {
  return screen.getByRole('radio', { checked: true }).getAttribute('aria-label') ?? '';
}

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockReset();
  // `delete` et non une réaffectation : jsdom ne définit pas `scrollIntoView`,
  // et lui laisser une fonction vide masquerait la prochaine régression.
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('la navigation de période', () => {
  it('annonce le mois de la journée retenue entre les deux chevrons', () => {
    afficher(fenetre(14));

    expect(screen.getByText('septembre 2026')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Semaine précédente' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Semaine suivante' })).toBeDefined();
  });

  it('avance d’une semaine — le pas de `PageSuiv`, à la souris', async () => {
    const user = afficher(fenetre(14));

    expect(journeeRetenue()).toMatch(/28 septembre 2026/);

    await user.click(screen.getByRole('button', { name: 'Semaine suivante' }));

    expect(journeeRetenue()).toMatch(/5 octobre 2026/);
    expect(screen.getByText('octobre 2026')).toBeDefined();
  });

  it('recule d’une semaine, et revient au point de départ', async () => {
    const user = afficher(fenetre(14));

    await user.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    await user.click(screen.getByRole('button', { name: 'Semaine précédente' }));

    expect(journeeRetenue()).toMatch(/28 septembre 2026/);
    expect(screen.getByText('septembre 2026')).toBeDefined();
  });

  it('éteint le chevron qui ne mène nulle part, sans le retirer du clavier', async () => {
    // `aria-disabled` et non `disabled` : le chevron reste atteignable, comme
    // les journées complètes de la bande et les créneaux inertes de la grille.
    const user = afficher(fenetre(8));
    const avant = screen.getByRole('button', { name: 'Semaine précédente' });

    expect(avant.getAttribute('aria-disabled')).toBe('true');
    expect(avant.hasAttribute('disabled')).toBe(false);

    // Huit journées : une seule semaine à franchir, et plus rien après.
    await user.click(screen.getByRole('button', { name: 'Semaine suivante' }));

    expect(journeeRetenue()).toMatch(/5 octobre 2026/);
    expect(screen.getByRole('button', { name: 'Semaine suivante' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('ne retient rien quand le chevron éteint est tout de même cliqué', async () => {
    const user = afficher(fenetre(14));

    await user.click(screen.getByRole('button', { name: 'Semaine précédente' }));

    expect(journeeRetenue()).toMatch(/28 septembre 2026/);
  });

  it('amène la journée visée sous les yeux sans lui donner le focus', async () => {
    // Le focus reste sur le chevron : on remonte trois semaines en trois clics
    // sans avoir à viser de nouveau. Le défilement est donc explicite — le
    // navigateur ne le fait de lui-même que pour l'élément qu'il focalise.
    const user = afficher(fenetre(14));
    const apres = screen.getByRole('button', { name: 'Semaine suivante' });

    await user.click(apres);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(apres);
  });
});

describe('« Voir plus de jours », en bout de bande', () => {
  it('appelle l’élargissement de l’appelant', async () => {
    const onWiden = vi.fn();
    const user = afficher(fenetre(14), onWiden);

    await user.click(screen.getByRole('button', { name: 'Voir plus de jours' }));

    expect(onWiden).toHaveBeenCalledTimes(1);
  });

  it('n’est pas rendu quand l’appelant n’a plus rien à élargir', () => {
    afficher(fenetre(31));

    expect(screen.queryByRole('button', { name: 'Voir plus de jours' })).toBeNull();
  });

  it('reste hors du groupe de boutons radio', () => {
    // Un `radiogroup` ne possède que des radios : y glisser une action ferait
    // annoncer « 15 sur 15 » sur une commande qui n'est pas une journée.
    afficher(fenetre(14), vi.fn());

    const bande = screen.getByRole('radiogroup', { name: 'Journée' });

    expect(within(bande).queryByRole('button', { name: 'Voir plus de jours' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Voir plus de jours' })).toBeDefined();
  });
});
