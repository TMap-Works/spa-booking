/**
 * La bande de jours du sélecteur de créneau (#1049).
 *
 * L'audit `d20260918-1` a relevé qu'à 360 px l'étape « créneau » met un mois
 * entier de cases — cinq à six lignes — entre le titre de la prestation et le
 * premier horaire. `BM-CRENEAU-01` décrit l'usage du marché : une rangée de jours
 * d'abord, le mois complet à la demande.
 *
 * Éprouvée sur `SlotPicker` directement plutôt qu'au travers de ses deux écrans :
 * c'est le composant partagé qui porte la bande, et les deux appelants n'en
 * diffèrent que par ce qu'ils font d'un changement de mois — un état dans le
 * tunnel, une navigation dans le report.
 */

import type {
  AvailabilitySlot,
  CalendarDate,
  DayAvailability,
  OpeningHoursEntry,
  UtcInstant,
} from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlotPicker } from '@/components/booking/slot-picker';
import { BAND_DAYS } from '@/lib/booking/day-band';
import type { BookingWindow } from '@/lib/booking/month-grid';

const TIMEZONE = 'UTC';

/**
 * La fenêtre de l'essai : du 1er septembre au 1er octobre 2026, soit exactement
 * les trente et un jours du contrat. Septembre est donc chargé en entier —
 * trente journées, deux fenêtres de bande et des restes.
 */
const BOUNDS: BookingWindow = {
  first: '2026-09-01' as CalendarDate,
  last: '2026-10-01' as CalendarDate,
};

function slot(date: string, heure: string): AvailabilitySlot {
  const startsAt = `${date}T${heure}:00:00.000Z` as UtcInstant;

  return { startsAt, endsAt: startsAt, staffId: '11111111-1111-4111-8111-111111111111' };
}

/** Les journées d'un mois telles que l'API les rend — une entrée par jour demandé. */
function journees(ouvertes: readonly string[]): readonly DayAvailability[] {
  const jours: DayAvailability[] = [];

  for (let quantieme = 1; quantieme <= 30; quantieme += 1) {
    const date = `2026-09-${String(quantieme).padStart(2, '0')}` as CalendarDate;

    jours.push({ date, slots: ouvertes.includes(date) ? [slot(date, '09'), slot(date, '14')] : [] });
  }

  return jours;
}

/** Les horaires que le salon publie — du lundi au vendredi, comme l'établissement semé. */
const SEMAINE_OUVREE: readonly OpeningHoursEntry[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday: weekday as OpeningHoursEntry['weekday'],
  opensAt: '09:00',
  closesAt: '19:00',
}));

function afficher(options: {
  readonly days?: readonly DayAvailability[] | null;
  readonly openingHours?: readonly OpeningHoursEntry[];
  readonly onMonthChange?: (month: string) => void;
  readonly onChoose?: (startsAt: UtcInstant) => void;
} = {}): ReturnType<typeof userEvent.setup> {
  render(
    <SlotPicker
      days={options.days === undefined ? journees(['2026-09-02', '2026-09-03']) : options.days}
      month="2026-09"
      bounds={BOUNDS}
      openingHours={options.openingHours}
      onMonthChange={options.onMonthChange ?? vi.fn()}
      timeZone={TIMEZONE}
      emptyState={<p>Aucun créneau</p>}
      onChoose={options.onChoose ?? vi.fn()}
    />,
  );

  return userEvent.setup();
}

/** La bande, nommée par le mois qu'elle parcourt. */
function bande(): HTMLElement {
  return screen.getByRole('grid', { name: /^Jour du rendez-vous/ });
}

/** La case de la bande dont le nom accessible commence par cette date. */
function journee(nom: string | RegExp): HTMLElement {
  return within(bande()).getByRole('button', { name: nom });
}

afterEach(() => {
  cleanup();
});

describe('la rangée de jours', () => {
  it('montre quatorze journées, et non le mois entier', () => {
    // C'est la mesure du ticket : trente cases de calendrier passaient avant le
    // premier horaire à 360 px.
    afficher();

    expect(within(bande()).getAllByRole('button')).toHaveLength(BAND_DAYS);
    expect(journee(/^mardi 1 septembre 2026/)).toBeDefined();
    expect(journee(/^lundi 14 septembre 2026/)).toBeDefined();
    expect(within(bande()).queryByRole('button', { name: /^mardi 15 septembre 2026/ })).toBeNull();
  });

  it('retient d’emblée la première journée qui a des créneaux', () => {
    // `BM-CRENEAU-02` : « la cliente ne tombe jamais sur un écran vide au premier
    // affichage ». Le 1er est complet, le 2 ne l'est pas.
    afficher();

    expect(journee(/^mercredi 2 septembre 2026/).closest('[role="gridcell"]')).toHaveProperty(
      'ariaSelected',
      'true',
    );
    expect(screen.getByRole('heading', { name: /mercredi 2 septembre 2026/ })).toBeDefined();
    expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
  });

  it('dit le nombre de créneaux d’une journée libre et le mot d’une journée pleine', () => {
    afficher();

    expect(journee(/^mercredi 2 septembre 2026/).getAttribute('aria-label')).toBe(
      'mercredi 2 septembre 2026 — 2 créneaux',
    );
    expect(journee(/^mardi 1 septembre 2026/).getAttribute('aria-label')).toBe(
      'mardi 1 septembre 2026 — complet',
    );
  });

  it('marque les journées libres d’une pastille, et les autres d’aucune', () => {
    // Une **forme** et non une teinte : c'est ce qui distingue une journée qui a
    // des créneaux d'une journée complète pour qui ne perçoit pas la couleur
    // (WCAG 1.4.1).
    afficher();

    expect(journee(/^mercredi 2 septembre 2026/).querySelector('.spa-date-band__mark')).not.toBeNull();
    expect(journee(/^mardi 1 septembre 2026/).querySelector('.spa-date-band__mark')).toBeNull();
  });

  it('rend une journée sans place inerte, mais atteignable au clavier', () => {
    afficher();

    const complet = journee(/^mardi 1 septembre 2026/);

    // `aria-disabled` et non `disabled` : la case reste atteignable — c'est
    // précisément son état qu'on vient y lire —, et la désactiver ferait un trou
    // dans le parcours des flèches.
    expect(complet.getAttribute('aria-disabled')).toBe('true');
    expect(complet.hasAttribute('disabled')).toBe(false);
  });

  it('distingue « fermé » de « complet », et le montre autrement que par la couleur', () => {
    // #742 et `BM-CRENEAU-04`. Le 5 septembre 2026 est un samedi : le salon
    // n'ouvre pas, ce ne sont pas les rendez-vous qui manquent.
    afficher({ openingHours: SEMAINE_OUVREE });

    expect(journee(/^samedi 5 septembre 2026/).getAttribute('aria-label')).toBe(
      'samedi 5 septembre 2026 — fermé',
    );
    expect(journee(/^samedi 5 septembre 2026/).closest('[role="gridcell"]')?.getAttribute('data-state')).toBe(
      'ferme',
    );
    expect(journee(/^mardi 1 septembre 2026/).closest('[role="gridcell"]')?.getAttribute('data-state')).toBe(
      'complet',
    );
  });

  it('reste opérable pendant le chargement, sous un squelette de grille', () => {
    // `states.md` étape 3 : « grille de créneaux en squelette, en gardant la
    // barre de dates interactive ». Les journées sont des dates : le navigateur
    // les pose sans le serveur.
    afficher({ days: null });

    expect(within(bande()).getAllByRole('button')).toHaveLength(BAND_DAYS);
    expect(journee(/^mercredi 2 septembre 2026/).getAttribute('aria-label')).toContain(
      'disponibilités en cours de chargement',
    );
    expect(screen.getByText('Chargement des disponibilités…')).toBeDefined();
  });

  it('garde la bande à l’écran quand le mois n’a rien à proposer', () => {
    // La bande ne disparaît jamais : c'est elle qui porte la seule commande qui
    // mène ailleurs, et c'est elle que le focus suit après un changement de mois.
    afficher({ days: journees([]) });

    expect(screen.getByText('Aucun créneau')).toBeDefined();
    expect(bande()).toBeDefined();
  });
});

describe('le défilement de la bande', () => {
  it('avance d’une semaine sans reposer de question au serveur', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });

    await user.click(screen.getByRole('button', { name: 'Jours suivants' }));

    // Une semaine, pas une page : garder la moitié des journées à l'écran
    // conserve le repère.
    expect(journee(/^mardi 8 septembre 2026/)).toBeDefined();
    expect(within(bande()).queryByRole('button', { name: /^mardi 1 septembre 2026/ })).toBeNull();
    expect(onMonthChange).not.toHaveBeenCalled();
  });

  it('passe au mois voisin une fois la plage chargée épuisée', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    const suivants = screen.getByRole('button', { name: 'Jours suivants' });

    // Trente journées, quatorze par fenêtre : deux semaines de défilement, puis
    // la butée — et c'est là que le mois suivant prend le relais.
    await user.click(suivants);
    await user.click(suivants);
    await user.click(suivants);

    expect(onMonthChange).not.toHaveBeenCalled();

    await user.click(suivants);

    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('éteint le chevron qui ne mène nulle part, sans le retirer du clavier', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    const avant = screen.getByRole('button', { name: 'Jours précédents' });

    // Le 1er septembre **est** aujourd'hui : rien avant lui n'est réservable, et
    // août n'est pas un mois qu'on puisse atteindre.
    expect(avant.getAttribute('aria-disabled')).toBe('true');
    expect(avant.hasAttribute('disabled')).toBe(false);

    await user.click(avant);

    expect(onMonthChange).not.toHaveBeenCalled();
    expect(journee(/^mardi 1 septembre 2026/)).toBeDefined();
  });

  it('propose le prochain créneau libre plutôt qu’un cadre vide', async () => {
    // `BM-CRENEAU-03` : « un jour plein devient une piste plutôt qu'une
    // impasse ». Sans cela, faire défiler la bande sur deux semaines pleines
    // laissait un cadre vide et aucune sortie.
    const user = afficher({ days: journees(['2026-09-01', '2026-09-25']) });

    await user.click(screen.getByRole('button', { name: 'Jours suivants' }));

    expect(screen.getByText(/^Complet du mardi 8 septembre 2026 au/)).toBeDefined();

    const renvoi = screen.getByRole('button', {
      name: 'Prochain créneau : vendredi 25 septembre 2026 à 09:00',
    });

    await user.click(renvoi);

    // La bande l'a ramené sous les yeux, et la grille détaille sa journée.
    expect(journee(/^vendredi 25 septembre 2026/)).toBeDefined();
    expect(screen.getByRole('heading', { name: /vendredi 25 septembre 2026/ })).toBeDefined();
  });

  it('ne laisse pas le focus retomber quand le renvoi s’efface sous le clic', async () => {
    // Le bouton vit dans l'état vide, que son propre clic remplace par la grille
    // d'horaires : sans rattrapage, le focus retombe sur `<body>` et le clavier
    // repart du haut de la page juste après un geste délibéré.
    const user = afficher({ days: journees(['2026-09-01', '2026-09-25']) });

    await user.click(screen.getByRole('button', { name: 'Jours suivants' }));
    await user.click(screen.getByRole('button', { name: /^Prochain créneau/ }));

    expect(document.activeElement).not.toBe(document.body);
    expect(bande().contains(document.activeElement)).toBe(true);
  });
});

describe('le clavier de la bande', () => {
  it('n’a qu’un seul arrêt de tabulation — le roving tabindex', () => {
    afficher();

    const arrets = [...bande().querySelectorAll('button')].filter(
      (bouton) => bouton.getAttribute('tabindex') === '0',
    );

    expect(arrets).toHaveLength(1);
    expect(arrets[0]?.getAttribute('aria-label')).toContain('mercredi 2 septembre 2026');
  });

  it('déplace le focus et retient la journée sous une flèche', async () => {
    const user = afficher();

    journee(/^mercredi 2 septembre 2026/).focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('jeudi 3 septembre 2026');
    expect(screen.getByRole('heading', { name: /jeudi 3 septembre 2026/ })).toBeDefined();
  });

  it('va aux bornes de la fenêtre visible sous Début et Fin', async () => {
    // Le critère d'acceptation de l'issue les nomme : « bande de jours navigable
    // au clavier (flèches, Début / Fin) ».
    const user = afficher();

    journee(/^mercredi 2 septembre 2026/).focus();
    await user.keyboard('{End}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('lundi 14 septembre 2026');

    await user.keyboard('{Home}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('mardi 1 septembre 2026');
  });

  it('fait glisser la bande d’un cran quand la flèche sort par le bord', async () => {
    const user = afficher();

    journee(/^mercredi 2 septembre 2026/).focus();
    await user.keyboard('{End}{ArrowRight}');

    // La bande suit le focus plutôt que de le précéder : un cran, pas une page.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('mardi 15 septembre 2026');
    expect(journee(/^mercredi 2 septembre 2026/)).toBeDefined();
    expect(within(bande()).queryByRole('button', { name: /^mardi 1 septembre 2026/ })).toBeNull();
  });

  it('ne boucle pas au bord de la plage chargée', async () => {
    const user = afficher();
    const premier = journee(/^mardi 1 septembre 2026/);

    premier.focus();
    await user.keyboard('{ArrowLeft}');

    expect(document.activeElement).toBe(premier);
  });

  it('ne rappelle pas le focus une fois qu’on a quitté la bande', async () => {
    // Une flèche qui ne mène nulle part ne fait bouger aucun état : rien ne vient
    // alors consommer un rattrapage de focus armé au passage, et le premier rendu
    // venu — un créneau choisi — ramènerait le focus dans la bande.
    const user = afficher();

    journee(/^mercredi 2 septembre 2026/).focus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');

    await user.click(screen.getByRole('button', { name: '09 h 00' }));

    expect(bande().contains(document.activeElement)).toBe(false);
  });

  it('atteint une journée complète sans la retenir', async () => {
    const user = afficher();

    journee(/^mercredi 2 septembre 2026/).focus();
    await user.keyboard('{ArrowLeft}');

    // Le 1er est complet : le focus s'y pose — c'est là qu'on lit « complet » —
    // mais la grille continue de détailler la journée qui était retenue.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('complet');
    expect(screen.getByRole('heading', { name: /mercredi 2 septembre 2026/ })).toBeDefined();
  });
});
