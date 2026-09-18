/**
 * Le sélecteur de praticien et de créneau (#44).
 *
 * C'est le contrôle le plus souvent raté du parcours, et celui qui décide de la
 * réservation : il est donc éprouvé étape par étape plutôt qu'au travers du
 * tunnel. Chaque `describe` reprend un critère d'acceptation de l'issue.
 *
 * L'action serveur est remplacée : sous test, c'est un module Next qui n'existe
 * pas hors du serveur. Ce qu'on éprouve ici est ce que l'écran fait de la
 * réponse, pas le transport.
 */

import type {
  AvailabilityResponse,
  AvailabilitySlot,
  CalendarDate,
  PublicService,
  TimeZone,
  UtcInstant,
} from '@spa/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlotStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/slot-step';
import { addCalendarDays } from '@/lib/booking/calendar';

import { service, tenant } from './fixtures';

const loadAvailabilityAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
  bookAppointmentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
}));

/**
 * Le fuseau du visiteur est piloté par le test.
 *
 * `timeZoneMention` lit celui du navigateur, qui dépend de la machine où la
 * suite tourne : une assertion sur la mention y serait verte à Paris et rouge en
 * CI. Seule cette fonction est remplacée — les mises en forme d'heure restent
 * les vraies, puisque c'est précisément ce qu'on vérifie.
 */
let mention: string | null = 'heure de Indian/Antananarivo';

vi.mock('@/lib/format', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/format')>();

  return { ...actual, timeZoneMention: () => mention };
});

/**
 * Le jour « aujourd'hui », dans le fuseau du salon, est piloté par le test.
 *
 * Le calendrier rend le **mois** de cette date-là, et non les journées que la
 * réponse contient : sans cela, un jeu d'essai daté de septembre 2026 ne
 * trouverait aucune case le jour où la suite tourne. Seule cette fonction est
 * remplacée — l'arithmétique de dates reste la vraie, puisque c'est elle qu'on
 * éprouve. Lu dans une fermeture et non capturé à la construction du double :
 * le module est encore en zone morte quand la fabrique s'installe.
 */
const AUJOURDHUI = '2026-09-01' as CalendarDate;

/**
 * L'appel porte-t-il l'**horloge**, plutôt qu'un instant que le test a daté ?
 *
 * L'étape lit les deux par la même fonction : « aujourd'hui » pour borner la
 * fenêtre de réservation, et la journée du créneau déjà retenu pour rouvrir son
 * mois (#947). Seule la première se pilote — la seconde est précisément le
 * calcul qu'on éprouve, et la remplacer ferait passer le test quel que soit le
 * fuseau employé. `new Date()` est construit dans le même tour de boucle que
 * l'appel ; un instant du jeu d'essai, lui, en est à des jours.
 */
function estLHorloge(instant: Date): boolean {
  return Math.abs(Date.now() - instant.getTime()) < 1_000;
}

vi.mock('@/lib/booking/calendar', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/booking/calendar')>();

  return {
    ...actual,
    calendarDateInTimeZone: (instant: Date, timeZone: TimeZone): CalendarDate =>
      estLHorloge(instant) ? AUJOURDHUI : actual.calendarDateInTimeZone(instant, timeZone),
  };
});

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;
const APRES_MIDI = '2026-09-01T11:00:00.000Z' as UtcInstant;
const MARDI_APRES_MIDI = '2026-09-02T12:00:00.000Z' as UtcInstant;
const LUNDI = '2026-09-01' as CalendarDate;
const MARDI = '2026-09-02' as CalendarDate;
const MERCREDI = '2026-09-03' as CalendarDate;

const HERY = service.staff[0]?.id ?? '';
const NIVO = '55555555-5555-4555-8555-555555555555';

/** Une prestation tenue par deux praticiens — le cas où le sélecteur a un sens. */
const deuxPraticiens: PublicService = {
  ...service,
  staff: [...service.staff, { id: NIVO, displayName: 'Nivo' }],
};

function slot(startsAt: UtcInstant, staffId: string): AvailabilitySlot {
  return { startsAt, endsAt: startsAt, staffId };
}

function availability(
  days: readonly { date: CalendarDate; slots: readonly AvailabilitySlot[] }[],
): AvailabilityResponse {
  return {
    serviceId: service.id,
    timezone: tenant.timezone,
    days: days.map((day) => ({ date: day.date, slots: [...day.slots] })),
  };
}

const journeeOrdinaire = availability([
  { date: LUNDI, slots: [slot(MATIN, HERY), slot(APRES_MIDI, HERY)] },
]);

const onBack = vi.fn();
const onStaffChange = vi.fn();
const onChoose = vi.fn();

function renderStep(
  overrides: Partial<{
    service: PublicService;
    staffId: string | null;
    startsAt: UtcInstant | null;
  }> = {},
): ReturnType<typeof userEvent.setup> {
  render(
    <SlotStep
      tenant={tenant}
      service={overrides.service ?? service}
      staffId={overrides.staffId ?? null}
      startsAt={overrides.startsAt ?? null}
      onBack={onBack}
      onStaffChange={onStaffChange}
      onChoose={onChoose}
    />,
  );

  return userEvent.setup();
}

beforeEach(() => {
  mention = 'heure de Indian/Antananarivo';
  loadAvailabilityAction.mockResolvedValue({ ok: true, data: journeeOrdinaire });
});

afterEach(() => {
  cleanup();
  loadAvailabilityAction.mockReset();
  onBack.mockReset();
  onStaffChange.mockReset();
  onChoose.mockReset();
});

describe('créneaux par journée, dans le fuseau du salon', () => {
  it('affiche les heures du salon et non celles du navigateur', async () => {
    renderStep();

    // 06:00 UTC vaut 09:00 à Antananarivo. Un affichage qui aurait oublié le
    // fuseau du salon rendrait « 06:00 » — ou l'heure de la machine de test.
    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(screen.getByRole('button', { name: '14 h 00' })).toBeDefined();
  });

  it('énonce l’heure en toutes lettres tout en affichant la forme courte', async () => {
    // `keyboard-navigation.md`, « États et attributs par créneau ». Les deux
    // formes ne disent pas la même chose parce qu'elles ne sont pas lues dans le
    // même contexte : dans sa colonne, sous « Après-midi », « 14:00 » se comprend
    // d'un coup d'œil et tient sur un téléphone ; énoncé seul par un lecteur
    // d'écran, il s'entend « un quatre deux points zéro zéro ».
    //
    // Les deux assertions tiennent ensemble : c'est le même bouton, trouvé par
    // son nom accessible, dont on relit le texte visible. Verrouiller l'une sans
    // l'autre laisserait passer la correction paresseuse — écrire « 14 h 00 »
    // dans la grille — qui rendrait ce test vert en cassant la lisibilité.
    renderStep();

    const apresMidi = await screen.findByRole('button', { name: '14 h 00' });

    expect(apresMidi.textContent).toBe('14:00');
    expect(apresMidi.getAttribute('aria-label')).toBe('14 h 00');
    expect(screen.getByRole('button', { name: '09 h 00' }).textContent).toBe('09:00');
  });

  it('mentionne le fuseau du salon quand le visiteur est ailleurs', async () => {
    renderStep();

    const titre = await screen.findByRole('heading', { level: 3 });

    expect(titre.textContent).toContain('1 septembre 2026');
    expect(titre.textContent).toContain('heure de Indian/Antananarivo');
  });

  it('tait la mention quand le visiteur est dans le fuseau du salon', async () => {
    // La mention n'apprend alors rien et alourdit chaque ligne du parcours.
    mention = null;
    renderStep();

    const titre = await screen.findByRole('heading', { level: 3 });

    expect(titre.textContent).toContain('1 septembre 2026');
    expect(titre.textContent).not.toContain('heure de');
  });

  it('ne propose qu’un bouton par heure quand plusieurs praticiens sont libres', async () => {
    // Sans préférence, l'API rend un créneau par praticien libre. Deux boutons
    // « 09:00 » côte à côte ne laisseraient aucun choix à faire.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [slot(MATIN, HERY), slot(MATIN, NIVO)] }]),
    });
    renderStep({ service: deuxPraticiens });

    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: '09 h 00' })).toHaveLength(1);
  });

  it('garde les journées complètes dans le calendrier, inertes', async () => {
    // Le serveur les renvoie avec `slots: []` plutôt que de les omettre : les
    // retirer ferait croire à un salon fermé ce jour-là.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([
        { date: LUNDI, slots: [] },
        { date: MARDI, slots: [slot(APRES_MIDI, HERY)] },
      ]),
    });
    renderStep();

    const complet = await screen.findByRole('button', { name: /^mardi 1 septembre 2026 — complet/ });
    const ouverte = screen.getByRole('button', { name: /^mercredi 2 septembre 2026 — 1 créneau/ });

    // La journée ouverte est retenue d'office ; la journée pleine reste lisible
    // et **atteignable** — c'est son état qu'on vient y lire — mais ne se retient
    // pas : il n'y aurait rien à montrer dessous.
    expect(ouverte.closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe('true');
    expect(complet.getAttribute('aria-disabled')).toBe('true');
    expect(complet.hasAttribute('disabled')).toBe(false);
  });
});

describe('choix du praticien', () => {
  it('propose « premier disponible » et chaque praticien de la prestation', async () => {
    renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09 h 00' });

    expect(screen.getByRole('option', { name: 'Premier disponible' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Hery' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Nivo' })).toBeDefined();
    // Aucune préférence : c'est l'option retenue, et non un sélecteur vide.
    expect(screen.getByLabelText('Praticien')).toHaveProperty('value', '');
  });

  it('remonte le praticien choisi au brouillon plutôt que de le garder pour lui', async () => {
    const user = renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09 h 00' });

    await user.selectOptions(screen.getByLabelText('Praticien'), NIVO);

    // Le brouillon porte le praticien : il survit au rafraîchissement de page et
    // c'est lui que la réservation enverra.
    expect(onStaffChange).toHaveBeenCalledWith(NIVO);
  });

  it('n’interroge l’agenda d’un praticien que lorsqu’il est demandé', async () => {
    renderStep({ service: deuxPraticiens, staffId: NIVO });
    await screen.findByRole('button', { name: '09 h 00' });

    expect(loadAvailabilityAction.mock.calls[0]?.[1]).toMatchObject({
      serviceId: service.id,
      staffId: NIVO,
    });

    cleanup();
    loadAvailabilityAction.mockClear();
    renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09 h 00' });

    // « Premier disponible » n'est pas un praticien : la requête ne porte alors
    // aucun `staffId`, et c'est le serveur qui affecte.
    expect(loadAvailabilityAction.mock.calls[0]?.[1]).not.toHaveProperty('staffId');
  });

  it('repasse par le chargement plutôt que de montrer l’agenda du praticien précédent', async () => {
    const { rerender } = render(
      <SlotStep
        tenant={tenant}
        service={deuxPraticiens}
        staffId={null}
        startsAt={null}
        onBack={onBack}
        onStaffChange={onStaffChange}
        onChoose={onChoose}
      />,
    );

    await screen.findByRole('button', { name: '09 h 00' });

    let libere: (value: unknown) => void = () => undefined;

    loadAvailabilityAction.mockReturnValue(
      new Promise((resolve) => {
        libere = resolve;
      }),
    );

    rerender(
      <SlotStep
        tenant={tenant}
        service={deuxPraticiens}
        staffId={NIVO}
        startsAt={null}
        onBack={onBack}
        onStaffChange={onStaffChange}
        onChoose={onChoose}
      />,
    );

    // Les créneaux affichés répondaient à une autre question : les garder à
    // l'écran le temps de l'aller-retour proposerait l'agenda de quelqu'un d'autre.
    expect(screen.queryByRole('button', { name: '09 h 00' })).toBeNull();
    expect(screen.getByText('Chargement des disponibilités…')).toBeDefined();

    await act(async () => {
      libere({ ok: true, data: availability([{ date: LUNDI, slots: [slot(APRES_MIDI, NIVO)] }]) });
    });

    expect(screen.getByRole('button', { name: '14 h 00' })).toBeDefined();
  });
});

describe('états de chargement et état vide', () => {
  it('montre un squelette annoncé, pas une liste vide, tant que la réponse n’est pas là', async () => {
    let libere: (value: unknown) => void = () => undefined;

    loadAvailabilityAction.mockReturnValue(
      new Promise((resolve) => {
        libere = resolve;
      }),
    );
    renderStep();

    // « Ça charge » et « il n'y a rien » ne sont pas le même écran.
    expect(screen.getByText('Chargement des disponibilités…')).toBeDefined();
    expect(screen.queryByText(/Aucun créneau/)).toBeNull();

    await act(async () => {
      libere({ ok: true, data: journeeOrdinaire });
    });

    expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
  });

  it('explique l’agenda vide et propose de lever la préférence de praticien', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep({ service: deuxPraticiens, staffId: NIVO });

    expect(await screen.findByText(/Aucun créneau avec Nivo/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Voir tous les praticiens' }));

    expect(onStaffChange).toHaveBeenCalledWith(null);
  });

  it('ne propose pas de lever une préférence qui n’existe pas', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    renderStep({ service: deuxPraticiens });

    expect(await screen.findByText('Aucun créneau en septembre 2026')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Voir tous les praticiens' })).toBeNull();
  });

  it('propose de lever une préférence que le catalogue ne nomme plus', async () => {
    // Le brouillon relu de `sessionStorage` peut porter un praticien que la
    // prestation ne propose plus. La requête le porte encore et ne rendra plus
    // jamais un créneau : sans ce bouton, l'écran est un cul-de-sac.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep({ staffId: NIVO });

    expect(await screen.findByText(/Aucun créneau avec ce praticien/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Voir tous les praticiens' }));

    expect(onStaffChange).toHaveBeenCalledWith(null);
  });

  it('ne fait pas passer une panne de chargement pour un agenda complet', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Service indisponible.',
    });
    renderStep();

    expect(await screen.findByText('Service indisponible.')).toBeDefined();
    // Conseiller de changer de prestation n'y changerait rien.
    expect(screen.queryByText(/Aucun créneau/)).toBeNull();
  });

  it('ne retire pas un état vide déjà affiché quand la revalidation échoue', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    renderStep({ service: deuxPraticiens, staffId: NIVO });

    expect(await screen.findByText(/Aucun créneau avec Nivo/)).toBeDefined();

    loadAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Service indisponible.',
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Une panne passagère ne doit pas emporter l'explication ni le bouton qui
    // lève la préférence de praticien — la seule sortie de cet écran.
    expect(screen.getByText(/Aucun créneau avec Nivo/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Voir tous les praticiens' })).toBeDefined();
    expect(screen.getByText('Service indisponible.')).toBeDefined();
  });

  it('offre de réessayer sans attendre la revalidation', async () => {
    // `states.md` étape 3. La revalidation périodique rattrape déjà seule, mais
    // une minute devant un écran en panne est très longue, et rien n'y dit que
    // quelque chose est en train de se faire.
    loadAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Service indisponible.',
    });
    const user = renderStep();

    expect(await screen.findByText('Service indisponible.')).toBeDefined();

    loadAvailabilityAction.mockResolvedValue({ ok: true, data: journeeOrdinaire });
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(screen.queryByText('Service indisponible.')).toBeNull();
  });

  it('ne demande au serveur que le mois visible, rogné sur aujourd’hui', async () => {
    // La fenêtre glissante de quatorze jours a cédé la place au mois qu'on
    // regarde (#827) : le mois courant part d'aujourd'hui, personne ne réservant
    // dans le passé, et s'arrête à son dernier jour.
    renderStep();
    await screen.findByRole('button', { name: '09 h 00' });

    expect(loadAvailabilityAction.mock.calls[0]?.[1]).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('propose de tourner la page du calendrier quand le mois n’a rien', async () => {
    // `states.md` étape 3 : « Vide (aucune dispo sur toute la plage) : proposer
    // d'élargir la plage ». C'est le même geste, dans l'idiome du calendrier.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    expect(await screen.findByText('Aucun créneau en septembre 2026')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Voir le mois suivant' }));

    expect(await screen.findByText('Aucun créneau en octobre 2026')).toBeDefined();

    const query = loadAvailabilityAction.mock.calls.at(-1)?.[1] as {
      from: CalendarDate;
      to: CalendarDate;
    };

    // Octobre est rogné sur la fin de la fenêtre de réservation, soit trente et
    // une journées bornes comprises depuis aujourd'hui.
    expect(query.from).toBe('2026-10-01');
    expect(query.to).toBe('2026-10-01');
    expect(addCalendarDays(AUJOURDHUI, 30)).toBe(query.to);
    // Le dernier mois de la fenêtre atteint, le bouton n'a plus rien à ouvrir.
    expect(screen.queryByRole('button', { name: 'Voir le mois suivant' })).toBeNull();
  });

  it('laisse changer de mois sans passer par l’agenda vide', async () => {
    // Une cliente qui voit des créneaux cette semaine mais veut réserver le mois
    // prochain n'a aucune raison de devoir d'abord tomber sur un agenda vide
    // pour trouver la sortie : le chevron est toujours là.
    const user = renderStep();

    await screen.findByRole('button', { name: '09 h 00' });
    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));

    await waitFor(() => {
      expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
    });

    expect(loadAvailabilityAction.mock.calls.at(-1)?.[1]).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(screen.getByText('octobre 2026')).toBeDefined();
  });

  it('rattrape le focus que le bouton emporte en disparaissant', async () => {
    // Le clic efface le bouton — le mois atteint est le dernier de la fenêtre.
    // Sans rattrapage, le focus retombe sur `<body>` et le clavier repart du
    // haut du document juste après un geste délibéré.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    await screen.findByRole('button', { name: 'Voir le mois suivant' });
    await user.click(screen.getByRole('button', { name: 'Voir le mois suivant' }));

    await screen.findByText('Aucun créneau en octobre 2026');

    // Le calendrier, lui, ne disparaît pas : le focus s'y pose, sur la journée
    // qu'il retient dans le nouveau mois — et non sur le squelette d'attente,
    // qu'un second rendu emporterait aussitôt. Ce que le mois a donné est
    // annoncé par ailleurs, en `role="status"`.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/octobre 2026/);
  });

  it('rattrape le focus sur le calendrier quand le mois suivant rend des créneaux', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    await screen.findByRole('button', { name: 'Voir le mois suivant' });
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: '2026-10-01' as CalendarDate, slots: [slot(MATIN, HERY)] }]),
    });
    await user.click(screen.getByRole('button', { name: 'Voir le mois suivant' }));

    await screen.findByRole('grid', { name: /Créneaux/ });

    const calendrier = screen.getByRole('grid', { name: /Journée/ });

    expect(document.activeElement).toBe(
      within(calendrier).getByRole('button', { name: /^jeudi 1 octobre 2026/ }),
    );
  });
});

describe('rafraîchissement des disponibilités', () => {
  it('recharge au retour sur l’onglet', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09 h 00' });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
  });

  it('recharge à intervalle court sans attendre un geste', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      renderStep();
      await vi.waitFor(() => {
        expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Entre le moment où la cliente ouvre la page et celui où elle choisit, un
      // créneau a pu partir.
      expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne vide pas une liste déjà affichée quand la revalidation échoue', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09 h 00' });

    loadAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Service indisponible.',
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // La panne est passagère ; les créneaux affichés restent la meilleure
    // information disponible, et l'avis dit qu'ils peuvent avoir vieilli.
    expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(screen.getByText('Service indisponible.')).toBeDefined();
  });
});

/**
 * Le calendrier mensuel — `wireframes.md` étape 3 et CDC §1.4 (#827), et
 * `states.md` étape 3 pour son maintien pendant le chargement.
 *
 * Le détail de son clavier et de sa navigation de mois est éprouvé sur
 * `SlotPicker` directement, dans `slot-picker-calendar.test.tsx` : ce qui se
 * vérifie ici est ce que le **tunnel** en fait — la plage qu'il demande, et le
 * lien entre la journée retenue et la grille d'heures.
 */
describe('calendrier mensuel', () => {
  /**
   * La grille d'heures n'existe qu'une fois la réponse reçue : elle fait un
   * point d'attente sûr. Elle se nomme par son titre de journée, le calendrier
   * étant lui aussi une `grid`.
   */
  const chargee = async (): Promise<HTMLElement> =>
    screen.findByRole('grid', { name: /Créneaux/ });

  /** Le calendrier, nommé par son mois. */
  const calendrier = (): HTMLElement => screen.getByRole('grid', { name: /Journée/ });

  const deuxJournees = availability([
    { date: LUNDI, slots: [slot(MATIN, HERY)] },
    { date: MARDI, slots: [slot(MARDI_APRES_MIDI, HERY)] },
  ]);

  it('reste à l’écran et opérable pendant le chargement', async () => {
    // `states.md` : « grille de créneaux en squelette, **en gardant la barre de
    // dates interactive** pour changer de jour sans attendre ». Le calendrier
    // est une trame de dates : le navigateur la pose sans le serveur.
    let libere: (value: unknown) => void = () => undefined;

    loadAvailabilityAction.mockReturnValue(
      new Promise((resolve) => {
        libere = resolve;
      }),
    );
    renderStep();

    await waitFor(() => {
      expect(screen.getByRole('grid', { name: /Journée/ })).toBeDefined();
    });

    // Septembre 2026 : trente cases, et aucune du mois voisin.
    expect(within(calendrier()).getAllByRole('button')).toHaveLength(30);
    expect(screen.getByText('Chargement des disponibilités…')).toBeDefined();

    await act(async () => {
      libere({ ok: true, data: journeeOrdinaire });
    });

    expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
  });

  it('ne met qu’une journée dans l’ordre de tabulation', async () => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: deuxJournees });
    renderStep();
    await chargee();

    const arrets = [...calendrier().querySelectorAll('button')].filter(
      (bouton) => bouton.getAttribute('tabindex') === '0',
    );

    expect(arrets).toHaveLength(1);
    expect(arrets[0]?.getAttribute('aria-label')).toMatch(/1 septembre 2026/);
  });

  it('change de journée aux flèches, et la grille d’heures suit', async () => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: deuxJournees });
    const user = renderStep();
    await chargee();

    const lundi = within(calendrier()).getByRole('button', { name: /^mardi 1 septembre 2026/ });
    const mardi = within(calendrier()).getByRole('button', { name: /^mercredi 2 septembre 2026/ });

    lundi.focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(mardi);
    expect(mardi.closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe('true');
    // « Changer de jour recharge la grille » — le créneau du lundi a cédé la
    // place à celui du mardi, sans nouvel appel au serveur : le mois entier
    // tient dans une seule réponse.
    expect(screen.getByRole('button', { name: '15 h 00' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '09 h 00' })).toBeNull();
  });

  it('ne boucle pas au bord de la fenêtre de réservation', async () => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: deuxJournees });
    const user = renderStep();
    await chargee();

    const lundi = within(calendrier()).getByRole('button', { name: /^mardi 1 septembre 2026/ });

    // Le 1er septembre **est** aujourd'hui : rien avant lui n'est réservable.
    lundi.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(lundi);
  });

  it('atteint une journée complète sans la retenir', async () => {
    // Elle reste affichée — le serveur la rend vide pour qu'on écrive
    // « complet » plutôt que de laisser un trou — et **atteignable** : dans une
    // grille de dates, une case qu'on ne peut pas atteindre est une case dont on
    // ne peut pas lire l'état.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([
        { date: LUNDI, slots: [slot(MATIN, HERY)] },
        { date: MARDI, slots: [] },
        { date: MERCREDI, slots: [slot('2026-09-03T12:00:00.000Z' as UtcInstant, HERY)] },
      ]),
    });
    const user = renderStep();
    await chargee();

    const lundi = within(calendrier()).getByRole('button', { name: /^mardi 1 septembre 2026/ });

    lundi.focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(
      within(calendrier()).getByRole('button', { name: /^mercredi 2 septembre 2026 — complet/ }),
    );
    // La journée retenue n'a pas bougé : il n'y aurait rien à montrer dessous.
    expect(screen.getByRole('button', { name: '09 h 00' })).toBeDefined();
  });
});

/**
 * Le comportement fixé par `docs/design/appointments/keyboard-navigation.md`.
 *
 * 09:00 tombe au matin, 14:00 à l'après-midi : les deux créneaux du jeu d'essai
 * sont donc sur **deux lignes** de la grille, ce qui exerce les deux axes.
 */
describe('navigation au clavier', () => {
  it('présente les créneaux en grille, une ligne par moment de la journée', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09 h 00' });

    const grille = screen.getByRole('grid', { name: /Créneaux/ });

    expect(within(grille).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('rowheader', { name: 'Matin' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Après-midi' })).toBeDefined();
  });

  it('ne met qu’un créneau dans l’ordre de tabulation', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09 h 00' });

    // Le roving tabindex du document de conception : sans lui, une journée de
    // trente créneaux imposerait trente tabulations pour atteindre le bouton
    // d'après.
    expect(screen.getByRole('button', { name: '09 h 00' })).toHaveProperty('tabIndex', 0);
    expect(screen.getByRole('button', { name: '14 h 00' })).toHaveProperty('tabIndex', -1);
  });

  it('déplace l’arrêt de tabulation sur le dernier créneau visité', async () => {
    renderStep();
    const apresMidi = await screen.findByRole('button', { name: '14 h 00' });

    await act(async () => {
      apresMidi.focus();
    });

    expect(apresMidi).toHaveProperty('tabIndex', 0);
    expect(screen.getByRole('button', { name: '09 h 00' })).toHaveProperty('tabIndex', -1);
  });

  it('circule dans la grille sans jamais boucler', async () => {
    const user = renderStep();
    const matin = await screen.findByRole('button', { name: '09 h 00' });
    const apresMidi = screen.getByRole('button', { name: '14 h 00' });

    matin.focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(apresMidi);

    // Bord de grille : la position ne bouge pas. Un enroulement ramènerait au
    // matin et ferait réserver 09:00 pour 14:00.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(apresMidi);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(matin);

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(matin);
  });

  it('va aux bornes de la ligne, et à celles de la grille avec Ctrl', async () => {
    const user = renderStep();
    const matin = await screen.findByRole('button', { name: '09 h 00' });
    const apresMidi = screen.getByRole('button', { name: '14 h 00' });

    matin.focus();

    // `Fin` sans Ctrl reste dans la ligne : le matin n'a qu'un créneau ici.
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(matin);

    await user.keyboard('{Control>}{End}{/Control}');
    expect(document.activeElement).toBe(apresMidi);

    await user.keyboard('{Control>}{Home}{/Control}');
    expect(document.activeElement).toBe(matin);
  });

  it('rattrape le focus quand une revalidation emporte le créneau focalisé', async () => {
    const user = renderStep();
    const apresMidi = await screen.findByRole('button', { name: '14 h 00' });

    await act(async () => {
      apresMidi.focus();
    });

    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [slot(MATIN, HERY)] }]),
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Sans ce rattrapage, le focus retomberait sur `<body>` et la navigation au
    // clavier repartirait du haut du document, au moment précis où l'on
    // choisissait son heure.
    expect(screen.queryByRole('button', { name: '14 h 00' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '09 h 00' }));

    // La touche laissée au navigateur n'est pas volée pour autant.
    await user.keyboard('{Enter}');
    expect(onChoose).toHaveBeenCalledWith(MATIN);
  });

  it('retient le créneau activé au clavier', async () => {
    const user = renderStep();
    const matin = await screen.findByRole('button', { name: '09 h 00' });

    matin.focus();
    await user.keyboard('{Enter}');

    expect(onChoose).toHaveBeenCalledWith(MATIN);
  });
});

/**
 * On revient sur cette étape, et elle doit s'en souvenir (#947).
 *
 * Le composant se démonte chaque fois qu'on la quitte : le geste retour du
 * navigateur, le fil d'étapes et un lien rouvert le remontent à neuf. Ce qu'il
 * sait du choix déjà fait ne peut donc venir que du brouillon, que le tunnel lui
 * rend par `startsAt`.
 *
 * La référence est `BM-TUNNEL-08` (`docs/design/benchmark/parcours-client.md`) —
 * « la cliente retrouve la même étape avec les mêmes choix » — et la skill
 * `web-frontend` §3, qui exige que l'état de l'étape survive à un
 * rafraîchissement.
 */
describe('retour sur l’étape avec un créneau déjà retenu (#947)', () => {
  /** Un créneau d'octobre : dans la fenêtre de réservation, hors du mois courant. */
  const OCTOBRE = '2026-10-01T06:00:00.000Z' as UtcInstant;
  const PREMIER_OCTOBRE = '2026-10-01' as CalendarDate;

  it('rouvre le mois du créneau retenu, et non le mois courant', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: PREMIER_OCTOBRE, slots: [slot(OCTOBRE, HERY)] }]),
    });

    renderStep({ startsAt: OCTOBRE });

    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    // Sans cela, l'étape reposait au serveur la question de septembre pour un
    // rendez-vous visé en octobre : la journée retenue n'était même pas dans la
    // réponse, et la grille ne pouvait que montrer autre chose.
    expect(loadAvailabilityAction.mock.calls[0]?.[1]).toMatchObject({
      from: PREMIER_OCTOBRE,
      to: PREMIER_OCTOBRE,
    });
    expect(screen.getByText('octobre 2026')).toBeDefined();
  });

  it('marque comme retenu l’horaire que le brouillon porte', async () => {
    renderStep({ startsAt: MATIN });

    // `aria-pressed` et non une classe : c'est l'état qu'un lecteur d'écran
    // annonce, et l'atténuation seule ne porterait pas l'information.
    const matin = await screen.findByRole('button', { name: '09 h 00' });

    expect(matin.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '14 h 00' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('n’annonce aucun état retenu à la première visite', async () => {
    // Rien n'a encore été choisi et le clic avance aussitôt : annoncer « non
    // pressé » sur chaque créneau ferait chercher un état qui n'existe pas.
    renderStep();

    const matin = await screen.findByRole('button', { name: '09 h 00' });

    expect(matin.hasAttribute('aria-pressed')).toBe(false);
  });

  it('laisse changer de mois depuis celui du créneau retenu', async () => {
    // Le mois retenu est un point de départ, pas un verrou : la cliente qui
    // revient pour changer d'avis garde ses chevrons.
    const user = renderStep({ startsAt: MATIN });

    await screen.findByRole('button', { name: '09 h 00' });
    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));

    await waitFor(() => {
      expect(screen.getByText('octobre 2026')).toBeDefined();
    });
  });
});
