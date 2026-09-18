/**
 * Le calendrier mensuel du sélecteur de créneau (#827, #1049).
 *
 * `docs/design/appointments/wireframes.md` étape 3 dessine un calendrier —
 * « ‹ août 2026 › », une ligne `L M M J V S D`, la date retenue mise en avant —
 * et le CDC §1.4 prescrit un « calendrier de disponibilité temps réel ».
 *
 * Il n'est plus le contrôle de **premier plan** depuis #1049 : à 360 px,
 * trente-cinq cases de 40 px passaient avant le premier horaire, et
 * `BM-CRENEAU-01` décrit l'usage du marché — une rangée de jours d'abord, le mois
 * complet *à la demande*. Le calendrier s'ouvre donc dans un panneau
 * (`BM-TUNNEL-12`), et c'est le bouton de période de la bande qui l'appelle. Ce
 * qu'il fait une fois ouvert n'a pas changé, et c'est ce que cette suite vérifie.
 *
 * Éprouvé sur `SlotPicker` directement plutôt qu'au travers de ses deux écrans :
 * c'est le composant partagé qui porte le calendrier, et les deux appelants n'en
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

/**
 * Les horaires que le salon publie sur sa vitrine — du lundi au vendredi, comme
 * l'établissement semé (`apps/api/prisma/seed.ts`, `WORKING_WEEKDAYS`).
 *
 * C'est la semaine qui a motivé #742 : les samedis et dimanches s'annonçaient
 * « complet » alors que le salon n'ouvre simplement pas ces jours-là.
 */
const SEMAINE_OUVREE: readonly OpeningHoursEntry[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday: weekday as OpeningHoursEntry['weekday'],
  opensAt: '09:00',
  closesAt: '19:00',
}));

function afficher(options: {
  readonly days?: readonly DayAvailability[] | null;
  readonly month?: string;
  readonly openingHours?: readonly OpeningHoursEntry[];
  readonly onMonthChange?: (month: string) => void;
  readonly onChoose?: (startsAt: UtcInstant) => void;
}): ReturnType<typeof userEvent.setup> {
  render(
    <SlotPicker
      days={options.days === undefined ? SEPTEMBRE : options.days}
      month={options.month ?? '2026-09'}
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

/**
 * Ouvrir le mois complet — le geste que `BM-CRENEAU-01` place en second.
 *
 * Toutes les épreuves du calendrier passent par là depuis #1049 : fermé, il n'est
 * pas monté du tout, précisément pour que ses trente et une cases ne restent pas
 * focalisables derrière un voile.
 */
async function ouvrirLeCalendrier(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^Ouvrir le calendrier/ }));
}

/** La case du calendrier dont le nom accessible commence par cette date. */
function journee(nom: string | RegExp): HTMLElement {
  return within(screen.getByRole('grid', { name: /^Journée/ })).getByRole('button', { name: nom });
}

afterEach(() => {
  cleanup();
});

describe('l’ouverture du mois complet', () => {
  it('ne monte le calendrier que lorsqu’on le demande', async () => {
    const user = afficher({});

    expect(screen.queryByRole('grid', { name: /^Journée/ })).toBeNull();

    await ouvrirLeCalendrier(user);

    expect(screen.getByRole('grid', { name: /^Journée/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Choisir une date' })).toBeDefined();
  });

  it('se referme sur la date retenue, et la bande la ramène sous les yeux', async () => {
    // Le panneau s'ouvre pour un seul geste : le garder ouvert sur sa réponse
    // obligerait à un second pour voir ce qu'on vient de demander.
    const user = afficher({ days: journees(['2026-10-01', '2026-10-16'], ['2026-10-16']), month: '2026-10' });

    await ouvrirLeCalendrier(user);
    await user.click(journee(/^vendredi 16 octobre 2026/));

    expect(screen.queryByRole('grid', { name: /^Journée/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /vendredi 16 octobre 2026/ })).toBeDefined();
    expect(
      within(screen.getByRole('grid', { name: /^Jour du rendez-vous/ })).getByRole('button', {
        name: /^vendredi 16 octobre 2026/,
      }),
    ).toBeDefined();
  });
});

describe('la grille du mois', () => {
  it('coiffe les colonnes des sept jours, lundi en tête', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

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

  it('rend le mois entier, jours hors fenêtre compris', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    // Le 1er septembre précède la fenêtre : la case existe et se lit, mais elle
    // n'est pas réservable.
    const avant = journee(/^mardi 1 septembre 2026/);

    expect(avant.getAttribute('aria-label')).toContain('hors de la période de réservation');
    expect(avant.getAttribute('aria-disabled')).toBe('true');
    // `aria-disabled` et non `disabled` : la case reste atteignable au clavier —
    // c'est précisément son état qu'on vient y lire.
    expect(avant.hasAttribute('disabled')).toBe(false);
  });

  it('dit le nombre de créneaux d’une journée libre et le mot « complet » d’une journée pleine', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    expect(journee(/^jeudi 17 septembre 2026/).getAttribute('aria-label')).toBe(
      'jeudi 17 septembre 2026 — 2 créneaux',
    );
    expect(journee(/^mercredi 16 septembre 2026/).getAttribute('aria-label')).toBe(
      'mercredi 16 septembre 2026 — complet',
    );
  });

  it('marque la journée retenue sur sa cellule, là où le lecteur d’écran la lit', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    // À défaut de choix, le sélecteur retient la première journée ouverte.
    const cellule = journee(/^jeudi 17 septembre 2026/).closest('[role="gridcell"]');

    expect(cellule?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: /jeudi 17 septembre 2026/ })).toBeDefined();
  });

  it('reste opérable pendant le chargement, sous un squelette de grille', async () => {
    // `states.md` étape 3 : « grille de créneaux en squelette, en gardant la
    // navigation de dates interactive pour changer de jour sans attendre ».
    const user = afficher({ days: null });
    await ouvrirLeCalendrier(user);

    expect(screen.getByRole('grid', { name: /^Journée/ })).toBeDefined();
    expect(journee(/^jeudi 17 septembre 2026/).getAttribute('aria-label')).toContain(
      'disponibilités en cours de chargement',
    );
  });

  it('reste atteignable quand le mois n’a rien à proposer', async () => {
    // C'est la bande qui ne disparaît jamais — le calendrier, lui, se rouvre du
    // même bouton, et l'état vide n'emporte donc aucune commande.
    const user = afficher({ days: journees(['2026-09-16', '2026-09-17'], []) });

    expect(screen.getByText('Aucun créneau')).toBeDefined();
    expect(screen.getByRole('grid', { name: /^Jour du rendez-vous/ })).toBeDefined();

    await ouvrirLeCalendrier(user);

    expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeDefined();
  });
});

/**
 * #742 — le salon qui n'ouvre pas ne s'annonce pas « complet ».
 *
 * CDC §2.3, module Disponibilités & agenda : le module distingue les horaires du
 * salon des rendez-vous pris, et l'interface doit dire lequel des deux empêche
 * de réserver. « Complet » invite à repasser plus tard ; « Fermé » invite à
 * choisir un autre jour.
 */
describe('une journée où le salon n’ouvre pas', () => {
  it('s’annonce « fermé » là où une journée pleine s’annonce « complet »', async () => {
    const user = afficher({ openingHours: SEMAINE_OUVREE });
    await ouvrirLeCalendrier(user);

    // Samedi : le salon n'ouvre pas — ce ne sont pas les rendez-vous qui manquent.
    expect(journee(/^samedi 19 septembre 2026/).getAttribute('aria-label')).toBe(
      'samedi 19 septembre 2026 — fermé',
    );
    // Mercredi : le salon ouvre, et tout est pris.
    expect(journee(/^mercredi 16 septembre 2026/).getAttribute('aria-label')).toBe(
      'mercredi 16 septembre 2026 — complet',
    );
  });

  it('porte son quantième barré, pour se distinguer sans la seule couleur', async () => {
    // `BM-CRENEAU-04` : un jour de fermeture doit se distinguer autrement que par
    // la couleur, les plateformes du benchmark grisant **ou barrant** les jours
    // impossibles (WCAG 1.4.1).
    const user = afficher({ openingHours: SEMAINE_OUVREE });
    await ouvrirLeCalendrier(user);

    expect(journee(/^samedi 19 septembre 2026/).querySelector('s')?.textContent).toBe('19');
    expect(journee(/^mercredi 16 septembre 2026/).querySelector('s')).toBeNull();
  });

  it('reste inerte, et atteignable au clavier comme une journée pleine', async () => {
    const user = afficher({ openingHours: SEMAINE_OUVREE });
    await ouvrirLeCalendrier(user);

    const samedi = journee(/^samedi 19 septembre 2026/);

    expect(samedi.getAttribute('aria-disabled')).toBe('true');
    expect(samedi.hasAttribute('disabled')).toBe(false);
  });

  it('garde ses créneaux quand le moteur en rend, quoi qu’annonce la vitrine', async () => {
    // Les horaires publiés décrivent la vitrine, pas l'agenda : un praticien qui
    // ouvre exceptionnellement un samedi ne doit pas voir sa journée masquée.
    const user = afficher({
      days: journees(['2026-09-18', '2026-09-19'], ['2026-09-19']),
      openingHours: SEMAINE_OUVREE,
    });
    await ouvrirLeCalendrier(user);

    expect(journee(/^samedi 19 septembre 2026/).getAttribute('aria-label')).toBe(
      'samedi 19 septembre 2026 — 2 créneaux',
    );
  });

  it('s’en tient à « complet » quand le salon n’a publié aucun horaire', async () => {
    // L'API omet `openingHours` plutôt que de rendre une semaine vide : rien ne
    // distingue alors « ferme le samedi » de « pas encore renseigné », et
    // affirmer le premier enverrait une cliente devant une porte ouverte.
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    expect(journee(/^samedi 19 septembre 2026/).getAttribute('aria-label')).toBe(
      'samedi 19 septembre 2026 — complet',
    );
  });
});

describe('la navigation de mois', () => {
  it('annonce le mois affiché entre les deux chevrons', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    // Dans le panneau : la bande porte elle aussi le mois, sur le bouton qui
    // ouvre ce calendrier.
    const panneau = screen.getByRole('dialog');

    expect(within(panneau).getByText('septembre 2026')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mois précédent' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeDefined();
  });

  it('ne referme pas le panneau quand une flèche traverse le mois', async () => {
    // L'activation automatique des flèches date de la bande d'avant #827 : elle
    // retient la journée au passage. Refermer le panneau à chaque `→` rendrait le
    // mois impossible à parcourir au clavier.
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    journee(/^jeudi 17 septembre 2026/).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('grid', { name: /^Journée/ })).toBeDefined();

    await user.keyboard('{Enter}');

    // `Entrée` sur un `<button>` natif, c'est une activation : elle conclut.
    expect(screen.queryByRole('grid', { name: /^Journée/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /vendredi 18 septembre 2026/ })).toBeDefined();
  });

  it('remonte le mois demandé à l’appelant, qui seul sait recharger', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    await ouvrirLeCalendrier(user);

    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));

    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('éteint le chevron qui ne mène nulle part, sans le retirer du clavier', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    await ouvrirLeCalendrier(user);

    const avant = screen.getByRole('button', { name: 'Mois précédent' });

    expect(avant.getAttribute('aria-disabled')).toBe('true');
    expect(avant.hasAttribute('disabled')).toBe(false);

    await user.click(avant);

    expect(onMonthChange).not.toHaveBeenCalled();
  });

  it('éteint le chevron suivant au dernier mois de la fenêtre', async () => {
    const user = afficher({ days: OCTOBRE, month: '2026-10' });
    await ouvrirLeCalendrier(user);

    expect(screen.getByRole('button', { name: 'Mois suivant' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Mois précédent' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('laisse le focus sur le chevron, pour enchaîner les mois sans viser de nouveau', async () => {
    const user = afficher({ onMonthChange: vi.fn() });
    await ouvrirLeCalendrier(user);

    const apres = screen.getByRole('button', { name: 'Mois suivant' });

    await user.click(apres);

    expect(document.activeElement).toBe(apres);
  });
});

describe('le clavier du calendrier', () => {
  it('n’a qu’un seul arrêt de tabulation — le roving tabindex', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    const grille = screen.getByRole('grid', { name: /^Journée/ });
    const arrets = [...grille.querySelectorAll('button')].filter(
      (bouton) => bouton.getAttribute('tabindex') === '0',
    );

    expect(arrets).toHaveLength(1);
    expect(arrets[0]?.getAttribute('aria-label')).toContain('17 septembre 2026');
  });

  it('déplace le focus et retient la journée sous une flèche', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    journee(/^jeudi 17 septembre 2026/).focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('18 septembre 2026');
    expect(screen.getByRole('heading', { name: /vendredi 18 septembre 2026/ })).toBeDefined();
  });

  it('descend d’une semaine sous `↓`, et ne boucle pas au bord de la fenêtre', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    journee(/^jeudi 17 septembre 2026/).focus();
    await user.keyboard('{ArrowUp}');

    // Le 10 septembre précède la fenêtre : le déplacement s'arrête sur sa borne.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('16 septembre 2026');

    await user.keyboard('{ArrowUp}');

    expect(document.activeElement?.getAttribute('aria-label')).toContain('16 septembre 2026');
  });

  it('change de mois sous `PageSuiv`, et le remonte à l’appelant', async () => {
    const onMonthChange = vi.fn();
    const user = afficher({ onMonthChange });
    await ouvrirLeCalendrier(user);

    journee(/^jeudi 17 septembre 2026/).focus();
    await user.keyboard('{PageDown}');

    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('atteint une journée complète sans la retenir', async () => {
    const user = afficher({});
    await ouvrirLeCalendrier(user);

    journee(/^jeudi 17 septembre 2026/).focus();
    await user.keyboard('{ArrowLeft}');

    // Le 16 est complet : le focus s'y pose — c'est là qu'on lit « complet » —
    // mais la grille continue de détailler la journée qui était retenue.
    expect(document.activeElement?.getAttribute('aria-label')).toContain('complet');
    expect(screen.getByRole('heading', { name: /jeudi 17 septembre 2026/ })).toBeDefined();
  });
});
