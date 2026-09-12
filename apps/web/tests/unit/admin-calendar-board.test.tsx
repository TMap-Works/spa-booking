import type { Appointment, AppointmentStatus, Service, StaffMemberSummary } from '@spa/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';

import { deskSlots } from './admin-desk-fixtures';

/**
 * Le planning tel qu'il se manipule (#49, critères 1, 2, 3, 4 et 5).
 *
 * L'action serveur est doublée : ce qui est exercé ici, c'est l'écran — les
 * colonnes, la navigation, le cache, la virtualisation —, pas le transport. Le
 * transport a sa recette, et l'API a la sienne.
 */

const loadCalendarRangeAction = vi.fn();
const loadDeskAvailabilityAction = vi.fn();
const loadDeskServiceStaffAction = vi.fn();
const loadAppointmentNotificationsAction = vi.fn();
const createDeskAppointmentAction = vi.fn();
const rescheduleDeskAppointmentAction = vi.fn();
const markDeskAppointmentStatusAction = vi.fn();
const searchDeskClientsAction = vi.fn();
const createDeskClientAction = vi.fn();
const push = vi.fn();
const replace = vi.fn();

// Le module d'actions est doublé **en entier** : le tiroir de #50 en importe six
// autres, et un module simulé qui ne les porte pas fait échouer l'import bien
// avant le premier rendu.
vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  loadCalendarRangeAction: (...args: unknown[]) => loadCalendarRangeAction(...args),
  loadDeskAvailabilityAction: (...args: unknown[]) => loadDeskAvailabilityAction(...args),
  loadDeskServiceStaffAction: (...args: unknown[]) => loadDeskServiceStaffAction(...args),
  loadAppointmentNotificationsAction: (...args: unknown[]) =>
    loadAppointmentNotificationsAction(...args),
  createDeskAppointmentAction: (...args: unknown[]) => createDeskAppointmentAction(...args),
  rescheduleDeskAppointmentAction: (...args: unknown[]) =>
    rescheduleDeskAppointmentAction(...args),
  markDeskAppointmentStatusAction: (...args: unknown[]) =>
    markDeskAppointmentStatusAction(...args),
  searchDeskClientsAction: (...args: unknown[]) => searchDeskClientsAction(...args),
  createDeskClientAction: (...args: unknown[]) => createDeskClientAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace }),
}));

const TIMEZONE = 'Indian/Antananarivo';
const SLUG = 'maison-lotus';

/** Le catalogue que la page passe au planning — de quoi ouvrir le tiroir de #50. */
const CATALOGUE: readonly Service[] = [
  {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
  },
];

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
  // Le tiroir lit les créneaux de la journée dès son ouverture (#611) : la
  // réponse par défaut porte ceux que le moteur rend vraiment — au quart
  // d'heure, alignés sur 07:10, et donc jamais à la minute 00.
  loadDeskAvailabilityAction.mockResolvedValue({
    ok: true,
    data: { slots: deskSlots('2026-08-26') },
  });
});

afterEach(() => {
  cleanup();
  loadCalendarRangeAction.mockReset();
  loadDeskServiceStaffAction.mockReset();
  loadDeskAvailabilityAction.mockReset();
  push.mockReset();
  replace.mockReset();
});

function renderBoard(
  overrides: {
    readonly periods?: Readonly<Record<string, readonly Appointment[]>>;
    readonly date?: string;
    readonly view?: 'jour' | 'semaine';
    readonly loadError?: string | null;
    readonly services?: readonly Service[];
    readonly staff?: readonly StaffMemberSummary[];
  } = {},
): void {
  render(
    <CalendarBoard
      date={overrides.date ?? '2026-08-26'}
      initialPeriods={overrides.periods ?? amorce}
      loadError={overrides.loadError ?? null}
      services={overrides.services ?? CATALOGUE}
      // Répertoire vide par défaut : les colonnes se déduisent alors des seuls
      // rendez-vous, ce qui laisse l'état vide observable là où ces cas
      // l'éprouvent. Le répertoire garni a son propre bloc, plus bas (#507).
      staff={overrides.staff ?? []}
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

    // Le bloc, désigné par son heure : sa poignée de déplacement (#51) porte
    // aussi le nom de la cliente, et c'est voulu — un lecteur d'écran doit savoir
    // quel rendez-vous elle saisit.
    expect(
      within(colonne).getByRole('button', { name: /^09:00 – 10:00 Rina Andriamana/ }),
    ).toBeDefined();
    expect(
      within(colonne).getByRole('button', { name: 'Déplacer Rina Andriamana' }),
    ).toBeDefined();
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
    // pose à 10 h 30 ». Une case morte ne le permettrait pas — et depuis #50 le
    // nom accessible dit aussi **ce que le clic fait**, le bouton ouvrant le
    // tiroir de prise de rendez-vous.
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    expect(
      screen.getByRole('button', { name: '08 h 00, libre — poser un rendez-vous à partir de cette heure' }),
    ).toBeDefined();
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

  it('renouvelle la session au lieu de renvoyer à la connexion', async () => {
    // #458, deuxième critère : la route `admin/session/refresh` existe depuis
    // #48, et le planning était le seul écran à ne pas en profiter. Il ne renvoie
    // donc plus à la connexion — c'est la route qui décidera, si le jeton de
    // rafraîchissement manque lui aussi.
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré.',
    });
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(push).not.toHaveBeenCalled();
    // Et c'est la **journée affichée** qui est rendue au retour, pas le planning
    // du jour — troisième critère.
    expect(replace).toHaveBeenLastCalledWith(
      `/${SLUG}/admin/session/refresh?next=${encodeURIComponent(
        `/${SLUG}/admin/calendrier?date=2026-08-27`,
      )}`,
    );
  });

  it('rend la vue semaine et sa date au retour du renouvellement', async () => {
    // La vue est dans l'URL (`paths.ts`) : un renouvellement qui la perdrait
    // ramènerait l'opérateur à la journée courante, sur l'écran qu'un comptoir
    // garde ouvert huit heures d'affilée.
    loadCalendarRangeAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré.',
    });
    renderBoard({ view: 'semaine', date: '2026-08-24' });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        `/${SLUG}/admin/session/refresh?next=${encodeURIComponent(
          `/${SLUG}/admin/calendrier?vue=semaine&date=2026-08-24`,
        )}`,
      );
    });
  });
});

describe('virtualisation — troisième critère', () => {
  it('ne monte pas la journée entière', async () => {
    renderBoard({ periods: { 'jour:2026-08-26': [matin] } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '08 h 00, libre — poser un rendez-vous à partir de cette heure' }),
      ).toBeDefined();
    });

    // 24 rangées affichées, une fenêtre de repli de 12 : la fin de journée n'est
    // pas dans le DOM tant qu'on n'y a pas défilé.
    expect(
      screen.queryByRole('button', { name: '18 h 00, libre — poser un rendez-vous à partir de cette heure' }),
    ).toBeNull();
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
      expect(
        screen.getAllByRole('button', { name: /, libre — poser un rendez-vous à partir de cette heure$/ }).length,
      ).toBeGreaterThan(0);
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
    // Vide n'est pas une panne : le salon n'a peut-être rien ce jour-là. Depuis
    // #507 cet état ne reste que pour un salon sans aucune fiche praticien — ou
    // un répertoire illisible, ce que `staff: []` représente ici.
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

/**
 * Poser le **premier** rendez-vous d'une journée — #507.
 *
 * Le tiroir de création n'a qu'un point d'entrée : le clic sur une case libre.
 * Tant que les colonnes se déduisaient des seuls rendez-vous, une journée creuse
 * rendait l'état vide, donc aucune case, donc aucun moyen d'ouvrir le tiroir là
 * où on en a justement besoin.
 */
describe('journée sans rendez-vous — les deux premiers critères', () => {
  const REPERTOIRE: readonly StaffMemberSummary[] = [
    { id: 'staff-hasina', displayName: 'Hasina' },
    { id: 'staff-tiana', displayName: 'Tiana' },
  ];

  function renderJourneeVide(): void {
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
    // Le tiroir demande les praticiens de la prestation dès son montage : sans
    // réponse, l'effet part sur une promesse absente et le rendu échoue.
    loadDeskServiceStaffAction.mockResolvedValue({
      ok: true,
      data: { staff: REPERTOIRE.map((membre) => ({ ...membre, isActive: true })) },
    });
    renderBoard({ periods: { 'jour:2026-08-26': [] }, staff: REPERTOIRE });
  }

  it('rend une grille de créneaux libres, et non l’état vide', () => {
    renderJourneeVide();

    expect(screen.queryByText('Aucun rendez-vous sur cette période')).toBeNull();
    // Une colonne par praticienne du répertoire, chacune annoncée vide.
    expect(screen.getByRole('list', { name: /^Hasina/ })).toBeDefined();
    expect(screen.getByRole('list', { name: /^Tiana/ })).toBeDefined();
    expect(screen.getAllByRole('button', { name: /libre — poser un rendez-vous/ }).length)
      .toBeGreaterThan(0);
  });

  it('ouvre le tiroir « Nouveau rendez-vous » au clic sur une case libre', async () => {
    const user = userEvent.setup();
    renderJourneeVide();

    const colonne = screen.getByRole('list', { name: /^Hasina/ });
    // 08 h 00, la première rangée du cadrage par défaut.
    await user.click(
      within(colonne).getByRole('button', { name: /^08 h 00, libre — poser un rendez-vous/ }),
    );

    expect(screen.getByRole('heading', { name: 'Nouveau rendez-vous' })).toBeDefined();
    // Le créneau cliqué amorce le tiroir : c'est bien celui de la journée creuse.
    expect(screen.getByLabelText<HTMLInputElement>(/^Date/).value).toBe('2026-08-26');
    // …et l'heure retenue est le premier créneau **réel** à partir de 08 h,
    // c'est-à-dire 08:10 et non l'heure ronde que la rangée affiche (#611).
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('08:10');
    });
  });
});

/**
 * Le tiroir s'ouvre DANS la fenêtre — #617.
 *
 * Rendu dans le flux, il tombait 210 px sous la ligne de flottaison en
 * 1920 × 1080 et 480 px sous elle en 1280 × 800 : rien ne bougeait au clic, ni
 * la fenêtre ni le focus, et l'opératrice croyait que son clic s'était perdu.
 *
 * Ce qui se vérifie ici est ce qu'une suite en jsdom peut vraiment prouver — la
 * classe de surimpression est posée, le focus entre et revient, Échap referme.
 * La géométrie elle-même est du ressort de `styles/admin/calendar.css` et de la
 * campagne de QA, qui la mesure au pixel dans un vrai navigateur.
 */
describe('#617 — le tiroir s’ouvre dans la fenêtre', () => {
  const REPERTOIRE: readonly StaffMemberSummary[] = [
    { id: 'staff-hasina', displayName: 'Hasina' },
  ];

  function ouvrirJournee(): void {
    loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
    loadDeskServiceStaffAction.mockResolvedValue({
      ok: true,
      data: { staff: REPERTOIRE.map((membre) => ({ ...membre, isActive: true })) },
    });
    renderBoard({ periods: { 'jour:2026-08-26': [] }, staff: REPERTOIRE });
  }

  /** Le bouton d'un créneau libre de la colonne de Hasina. */
  function creneau(heure: string): HTMLElement {
    return within(screen.getByRole('list', { name: /^Hasina/ })).getByRole('button', {
      name: new RegExp(`^${heure}, libre — poser un rendez-vous`),
    });
  }

  /** La région du tiroir — c'est elle qui porte la surimpression et le focus. */
  function tiroir(): HTMLElement {
    const titre = screen.getByRole('heading', { name: 'Nouveau rendez-vous' });
    const region = titre.closest('aside');

    if (region === null) {
      throw new Error('le titre du tiroir n’est pas dans une région <aside>.');
    }

    return region;
  }

  it('pose le tiroir en surimpression et non dans le flux', async () => {
    const user = userEvent.setup();
    ouvrirJournee();

    await user.click(creneau('08 h 00'));

    // La classe est le contrat passé avec `styles/admin/calendar.css` : c'est
    // elle qui sort le tiroir du flux et l'ancre au bord de la fenêtre.
    expect(tiroir().classList.contains('spa-admin-calendar__drawer')).toBe(true);
  });

  it('fait entrer le focus dans le tiroir dès l’ouverture', async () => {
    const user = userEvent.setup();
    ouvrirJournee();

    await user.click(creneau('08 h 00'));

    // Sur la région et non sur le premier champ : son nom accessible est annoncé
    // avant la saisie, et la tabulation suivante mène au premier contrôle.
    expect(document.activeElement).toBe(tiroir());
  });

  it('referme sur Échap et rend le focus au créneau cliqué', async () => {
    const user = userEvent.setup();
    ouvrirJournee();

    const declencheur = creneau('08 h 00');

    await user.click(declencheur);
    expect(screen.queryByRole('heading', { name: 'Nouveau rendez-vous' })).not.toBeNull();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('heading', { name: 'Nouveau rendez-vous' })).toBeNull();
    // Le focus ne retombe pas sur le `<body>` : l'opératrice au clavier reprend
    // sa tabulation là où elle l'avait laissée.
    expect(document.activeElement).toBe(declencheur);
  });

  it('rend le focus au DERNIER créneau cliqué quand on ouvre sans refermer', async () => {
    const user = userEvent.setup();
    ouvrirJournee();

    await user.click(creneau('08 h 00'));
    const second = creneau('09 h 00');
    await user.click(second);

    // Le tiroir se remonte sur la nouvelle cible ; le déclencheur retenu est
    // celui qu'on vient de cliquer, pas celui du premier clic.
    await waitFor(() => {
      expect(document.activeElement).toBe(tiroir());
    });

    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(second);
  });

  /**
   * Échap referme le tiroir **et** repose ce qui était saisi à la poignée.
   *
   * Le tiroir écoute Échap sur sa région ; le planning l'écoute sur la fenêtre
   * pour reposer un rendez-vous saisi (#51). Couper la propagation depuis le
   * tiroir empêchait le second de s'exécuter : la saisie restait armée derrière
   * un tiroir refermé, tous les créneaux libres restaient des cibles de dépôt,
   * et le clic suivant — censé poser un nouveau rendez-vous — déplaçait celui
   * d'avant. Le nom accessible du créneau libre est la preuve la plus directe :
   * il dit ce que le clic fera.
   */
  it('repose aussi le rendez-vous saisi à la poignée', async () => {
    const user = userEvent.setup();
    loadDeskServiceStaffAction.mockResolvedValue({ ok: true, data: { staff: [] } });
    loadAppointmentNotificationsAction.mockResolvedValue({
      ok: true,
      data: { notifications: [] },
    });
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Déplacer Rina Andriamana' }));
    // La fiche d'un AUTRE bloc s'ouvre sans reposer la saisie : c'est le geste
    // du comptoir — « attends, celui de 11 h, il est à quelle heure déjà ? ».
    await user.click(screen.getByRole('button', { name: /^11:00 – 12:00 Lova Andrian/ }));

    await user.keyboard('{Escape}');

    const colonne = screen.getByRole('list', { name: /^Hasina/ });

    expect(
      within(colonne).getByRole('button', { name: /^08 h 00, libre/ }).textContent,
    ).toContain('poser un rendez-vous');
  });
});
