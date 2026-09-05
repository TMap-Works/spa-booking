import type { Appointment, AppointmentStatus } from '@spa/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';

/**
 * Le planning tel qu'il se manipule (#49, critères 1, 2, 3, 4 et 5).
 *
 * L'action serveur est doublée : ce qui est exercé ici, c'est l'écran — les
 * colonnes, la navigation, le cache, la virtualisation —, pas le transport. Le
 * transport a sa recette, et l'API a la sienne.
 */

const loadCalendarRangeAction = vi.fn();
const push = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  loadCalendarRangeAction: (...args: unknown[]) => loadCalendarRangeAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const TIMEZONE = 'Indian/Antananarivo';
const SLUG = 'maison-lotus';

let sequence = 0;

function appointment(overrides: {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly staff?: { readonly id: string; readonly displayName: string };
  readonly client?: { readonly firstName: string; readonly lastName: string };
  readonly status?: AppointmentStatus;
}): Appointment {
  sequence += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const staff = overrides.staff ?? { id: 'staff-hasina', displayName: 'Hasina' };
  const client = overrides.client ?? { firstName: 'Rina', lastName: 'Andriamana' };

  return {
    id,
    status: overrides.status ?? 'confirmed',
    client: { id: `client-${id}`, ...client },
    staff,
    service: {
      id: `service-${id}`,
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-08-01T08:00:00.000Z',
  };
}

/** 09:00 – 10:00 au salon, le mercredi 26 août 2026. */
const matin = appointment({
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
});

/** 11:00 – 12:00 chez une autre praticienne, statut « non présenté ». */
const midi = appointment({
  startsAt: '2026-08-26T08:00:00.000Z',
  endsAt: '2026-08-26T09:00:00.000Z',
  staff: { id: 'staff-tiana', displayName: 'Tiana' },
  client: { firstName: 'Lova', lastName: 'Andrian' },
  status: 'no_show',
});

/** Les trois périodes que la page amorce : celle qu'on ouvre et ses voisines. */
const amorce = {
  'jour:2026-08-25': [],
  'jour:2026-08-26': [matin, midi],
  'jour:2026-08-27': [
    appointment({ startsAt: '2026-08-27T06:00:00.000Z', endsAt: '2026-08-27T07:00:00.000Z' }),
  ],
};

beforeEach(() => {
  // Le préchargement des périodes voisines part au montage : sans réponse par
  // défaut, chaque rendu laisserait une promesse rejetée derrière lui.
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
});

afterEach(() => {
  cleanup();
  loadCalendarRangeAction.mockReset();
  push.mockReset();
});

function renderBoard(
  overrides: {
    readonly periods?: Readonly<Record<string, readonly Appointment[]>>;
    readonly date?: string;
    readonly view?: 'jour' | 'semaine';
    readonly loadError?: string | null;
  } = {},
): void {
  render(
    <CalendarBoard
      date={overrides.date ?? '2026-08-26'}
      initialPeriods={overrides.periods ?? amorce}
      loadError={overrides.loadError ?? null}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
      view={overrides.view ?? 'jour'}
    />,
  );
}

describe('vue jour — ce que l’écran montre', () => {
  it('ouvre une colonne par praticienne, nommée et comptée', () => {
    renderBoard();

    expect(screen.getByText('Hasina')).toBeDefined();
    expect(screen.getByText('Tiana')).toBeDefined();
    expect(screen.getByText('Mercredi 26 août 2026')).toBeDefined();
  });

  it('relie chaque colonne à son en-tête', () => {
    // `aria-labelledby` : sans lui, un lecteur d'écran annonce « liste » sans
    // dire de qui est l'agenda qu'il parcourt.
    renderBoard();

    // Le nom accessible est celui de l'en-tête entier — nom et compte de RDV.
    const colonne = screen.getByRole('list', { name: /^Hasina/ });

    expect(within(colonne).getByRole('button', { name: /Rina Andriamana/ })).toBeDefined();
  });

  it('porte le statut par la classe **et** par le texte, jamais par la seule couleur', () => {
    renderBoard();

    const bloc = screen.getByRole('button', { name: /Lova Andrian/ });

    expect(bloc.className).toContain('spa-admin-calendar__event--no-show');
    // WCAG 1.4.1 : la couleur ne peut pas être le seul véhicule de l'information.
    expect(bloc.textContent).toContain('Statut : non présenté.');
  });

  it('écrit l’heure du salon, pas celle du navigateur', () => {
    renderBoard();

    expect(screen.getByRole('button', { name: /09:00 – 10:00/ })).toBeDefined();
  });

  it('propose chaque créneau libre comme un bouton nommé', () => {
    // Le geste le plus fréquent du comptoir : « le client est devant moi, je le
    // pose à 10 h 30 ». Une case morte ne le permettrait pas.
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    expect(screen.getByRole('button', { name: '08 h 00, libre' })).toBeDefined();
  });
});

describe('navigation entre périodes — cinquième critère', () => {
  it('avance d’un jour et repart de la période déjà en cache', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    expect(screen.getByText('Jeudi 27 août 2026')).toBeDefined();
    // Le 27 était préchargé par la page : aucun aller-retour pour l'afficher.
    expect(
      loadCalendarRangeAction.mock.calls.filter((call) => call[2] === '2026-08-27'),
    ).toHaveLength(0);
  });

  it('recule d’un jour', async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Jour précédent' }));

    // Le 25 est vide : le libellé paraît deux fois — dans la barre d'outils et
    // dans l'en-tête de l'état vide, comme la maquette le prévoit.
    expect(screen.getAllByText('Mardi 25 août 2026').length).toBeGreaterThan(0);
  });

  it('revient à la journée du salon', async () => {
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Jour précédent' }));
    await user.click(screen.getByRole('button', { name: 'Aujourd’hui' }));

    // La date du jour dépend de quand le test tourne : ce qui se vérifie, c'est
    // qu'on a quitté le 25 — pas quel jour on est.
    expect(screen.queryByText('Mardi 25 août 2026')).toBeNull();
  });

  it('bascule en vue semaine et ouvre les sept journées', async () => {
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [matin, midi] } });
    renderBoard();

    await user.click(screen.getByRole('radio', { name: 'Semaine' }));

    await waitFor(() => {
      expect(screen.getByText('24 – 30 août 2026')).toBeDefined();
    });
    expect(screen.getAllByRole('list')).toHaveLength(7);
  });
});

describe('chargement de la seule plage visible — deuxième critère', () => {
  it('précharge les deux périodes voisines qui manquent', async () => {
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await waitFor(() => {
      expect(loadCalendarRangeAction).toHaveBeenCalledTimes(2);
    });

    const demandes = loadCalendarRangeAction.mock.calls.map((call) => call[2]);

    expect(demandes).toContain('2026-08-25');
    expect(demandes).toContain('2026-08-27');
    // Et jamais la période affichée : la page l'a déjà servie.
    expect(demandes).not.toContain('2026-08-26');
  });

  it('ne redemande rien quand les trois périodes sont déjà là', async () => {
    renderBoard();

    await waitFor(() => {
      expect(screen.getByText('Hasina')).toBeDefined();
    });
    expect(loadCalendarRangeAction).not.toHaveBeenCalled();
  });

  it('renvoie à la connexion quand la session a expiré', async () => {
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré.',
    });
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/maison-lotus/admin/connexion');
    });
  });
});

describe('virtualisation — troisième critère', () => {
  it('ne monte pas la journée entière', async () => {
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '08 h 00, libre' })).toBeDefined();
    });

    // 24 rangées affichées, une fenêtre de repli de 12 : la fin de journée n'est
    // pas dans le DOM tant qu'on n'y a pas défilé.
    expect(screen.queryByRole('button', { name: '18 h 00, libre' })).toBeNull();
    expect(screen.getAllByRole('listitem').length).toBeLessThan(24);
  });

  it('remesure la grille quand elle remplace un planning vide', async () => {
    // Régression : l'état vide ne monte pas le conteneur qu'on mesure. Sans
    // remesure au retour de la grille, la fenêtre restait à zéro rangée et le
    // planning s'affichait sans un seul créneau — trouvé en recette.
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [matin] } });
    renderBoard({ periods: { 'jour:2026-08-26': [] } });

    expect(screen.getByText('Aucun rendez-vous sur cette période')).toBeDefined();

    await user.click(screen.getByRole('radio', { name: 'Semaine' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /, libre$/ }).length).toBeGreaterThan(0);
    });
  });
});

describe('états', () => {
  it('dit ce qui manque quand le chargement a échoué', () => {
    renderBoard({ loadError: 'L’agenda n’est pas encore servi par l’API.' });

    const alerte = screen.getByRole('alert');

    expect(alerte.textContent).toContain('Planning indisponible');
    expect(alerte.textContent).toContain('L’agenda n’est pas encore servi par l’API.');
  });

  it('dit la route manquante en français, pas le refus brut du cadre HTTP', async () => {
    // Régression : la journée ouverte est traduite côté serveur, les périodes
    // suivantes passaient par l'action et recrachaient « Cannot GET … ».
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Cannot GET /api/v1/appointments?from=2026-08-27&to=2026-08-27',
    });
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'L’agenda du back-office n’est pas encore servi par l’API',
      );
    });
    expect(screen.getByRole('alert').textContent).not.toContain('Cannot GET');
  });

  it('ne dit pas « aucun rendez-vous » tant que la période n’est pas arrivée', async () => {
    // Régression : la période absente du cache et la période vide se rendaient
    // pareil. L'écran affirmait une journée libre pendant l'aller-retour —
    // exactement celui sur lequel le comptoir décide de poser un client.
    const user = userEvent.setup();
    const attente: { readonly settle?: (value: unknown) => void } = {};

    loadCalendarRangeAction.mockReturnValue(
      new Promise((settle) => {
        Object.assign(attente, { settle });
      }),
    );
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    expect(screen.getByText('Chargement de la période…')).toBeDefined();
    expect(screen.queryByText('Aucun rendez-vous sur cette période')).toBeNull();

    attente.settle?.({ ok: true, data: { appointments: [] } });

    await waitFor(() => {
      expect(screen.getByText('Aucun rendez-vous sur cette période')).toBeDefined();
    });
  });

  it('parle quand le clic tombe pendant le préchargement de la même période', async () => {
    // Régression : le second appel sur une période déjà en vol abandonnait. Un
    // clic « jour suivant » lancé pendant son préchargement laissait donc
    // l'écran sans indicateur — et, si ce préchargement échouait, sans le
    // moindre message : un planning vide au lieu d'un agenda illisible.
    const user = userEvent.setup();
    const attente: { readonly settle?: (value: unknown) => void } = {};

    loadCalendarRangeAction.mockReturnValue(
      new Promise((settle) => {
        Object.assign(attente, { settle });
      }),
    );
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    attente.settle?.({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Cannot GET /api/v1/appointments?from=2026-08-27&to=2026-08-27',
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'L’agenda du back-office n’est pas encore servi par l’API',
      );
    });
  });

  it('retire la bannière au retour sur une période déjà servie', async () => {
    // Régression : une période servie depuis le cache ne touchait pas à l'état
    // d'échec. « Planning indisponible » restait affiché au-dessus d'un planning
    // parfaitement rendu, celui de la veille.
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Route absente.',
    });
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Jour précédent' }));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explique un planning vide et propose la suite', async () => {
    // Vide n'est pas une panne : le salon n'a peut-être rien ce jour-là.
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
    renderBoard({ periods: { 'jour:2026-08-26': [] } });

    expect(screen.getByText('Aucun rendez-vous sur cette période')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Aller au jour suivant' }));

    expect(screen.getAllByText('Jeudi 27 août 2026').length).toBeGreaterThan(0);
  });

  it('rappelle le fuseau dans lequel les heures sont lues', () => {
    renderBoard();

    expect(screen.getByText(/Indian\/Antananarivo/)).toBeDefined();
  });
});
