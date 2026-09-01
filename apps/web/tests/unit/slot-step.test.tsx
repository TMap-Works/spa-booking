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
  UtcInstant,
} from '@spa/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlotStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/slot-step';

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

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;
const APRES_MIDI = '2026-09-01T11:00:00.000Z' as UtcInstant;
const LUNDI = '2026-09-01' as CalendarDate;
const MARDI = '2026-09-02' as CalendarDate;

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
  overrides: Partial<{ service: PublicService; staffId: string | null }> = {},
): ReturnType<typeof userEvent.setup> {
  render(
    <SlotStep
      tenant={tenant}
      service={overrides.service ?? service}
      staffId={overrides.staffId ?? null}
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
    expect(await screen.findByRole('button', { name: '09:00' })).toBeDefined();
    expect(screen.getByRole('button', { name: '14:00' })).toBeDefined();
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

    expect(await screen.findByRole('button', { name: '09:00' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: '09:00' })).toHaveLength(1);
  });

  it('garde les journées complètes dans le sélecteur, inertes', async () => {
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

    const journees = await screen.findByLabelText('Journée');
    const complet = screen.getByRole('option', { name: /1 septembre 2026 — complet/ });

    // La journée ouverte est retenue d'office, la journée pleine reste lisible.
    expect(journees).toHaveProperty('value', MARDI);
    expect(complet).toHaveProperty('disabled', true);
  });
});

describe('choix du praticien', () => {
  it('propose « premier disponible » et chaque praticien de la prestation', async () => {
    renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09:00' });

    expect(screen.getByRole('option', { name: 'Premier disponible' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Hery' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Nivo' })).toBeDefined();
    // Aucune préférence : c'est l'option retenue, et non un sélecteur vide.
    expect(screen.getByLabelText('Praticien')).toHaveProperty('value', '');
  });

  it('remonte le praticien choisi au brouillon plutôt que de le garder pour lui', async () => {
    const user = renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09:00' });

    await user.selectOptions(screen.getByLabelText('Praticien'), NIVO);

    // Le brouillon porte le praticien : il survit au rafraîchissement de page et
    // c'est lui que la réservation enverra.
    expect(onStaffChange).toHaveBeenCalledWith(NIVO);
  });

  it('n’interroge l’agenda d’un praticien que lorsqu’il est demandé', async () => {
    renderStep({ service: deuxPraticiens, staffId: NIVO });
    await screen.findByRole('button', { name: '09:00' });

    expect(loadAvailabilityAction.mock.calls[0]?.[1]).toMatchObject({
      serviceId: service.id,
      staffId: NIVO,
    });

    cleanup();
    loadAvailabilityAction.mockClear();
    renderStep({ service: deuxPraticiens });
    await screen.findByRole('button', { name: '09:00' });

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
        onBack={onBack}
        onStaffChange={onStaffChange}
        onChoose={onChoose}
      />,
    );

    await screen.findByRole('button', { name: '09:00' });

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
        onBack={onBack}
        onStaffChange={onStaffChange}
        onChoose={onChoose}
      />,
    );

    // Les créneaux affichés répondaient à une autre question : les garder à
    // l'écran le temps de l'aller-retour proposerait l'agenda de quelqu'un d'autre.
    expect(screen.queryByRole('button', { name: '09:00' })).toBeNull();
    expect(screen.getByText('Chargement des disponibilités…')).toBeDefined();

    await act(async () => {
      libere({ ok: true, data: availability([{ date: LUNDI, slots: [slot(APRES_MIDI, NIVO)] }]) });
    });

    expect(screen.getByRole('button', { name: '14:00' })).toBeDefined();
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

    expect(screen.getByRole('button', { name: '09:00' })).toBeDefined();
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

    expect(await screen.findByText(/^Aucun créneau sur les 14 prochains jours$/)).toBeDefined();
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
});

describe('rafraîchissement des disponibilités', () => {
  it('recharge au retour sur l’onglet', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09:00' });

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
        expect(screen.getByRole('button', { name: '09:00' })).toBeDefined();
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
    await screen.findByRole('button', { name: '09:00' });

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
    expect(screen.getByRole('button', { name: '09:00' })).toBeDefined();
    expect(screen.getByText('Service indisponible.')).toBeDefined();
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
    await screen.findByRole('button', { name: '09:00' });

    expect(screen.getByRole('grid')).toBeDefined();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('rowheader', { name: 'Matin' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Après-midi' })).toBeDefined();
  });

  it('ne met qu’un créneau dans l’ordre de tabulation', async () => {
    renderStep();
    await screen.findByRole('button', { name: '09:00' });

    // Le roving tabindex du document de conception : sans lui, une journée de
    // trente créneaux imposerait trente tabulations pour atteindre le bouton
    // d'après.
    expect(screen.getByRole('button', { name: '09:00' })).toHaveProperty('tabIndex', 0);
    expect(screen.getByRole('button', { name: '14:00' })).toHaveProperty('tabIndex', -1);
  });

  it('déplace l’arrêt de tabulation sur le dernier créneau visité', async () => {
    renderStep();
    const apresMidi = await screen.findByRole('button', { name: '14:00' });

    await act(async () => {
      apresMidi.focus();
    });

    expect(apresMidi).toHaveProperty('tabIndex', 0);
    expect(screen.getByRole('button', { name: '09:00' })).toHaveProperty('tabIndex', -1);
  });

  it('circule dans la grille sans jamais boucler', async () => {
    const user = renderStep();
    const matin = await screen.findByRole('button', { name: '09:00' });
    const apresMidi = screen.getByRole('button', { name: '14:00' });

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
    const matin = await screen.findByRole('button', { name: '09:00' });
    const apresMidi = screen.getByRole('button', { name: '14:00' });

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
    const apresMidi = await screen.findByRole('button', { name: '14:00' });

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
    expect(screen.queryByRole('button', { name: '14:00' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '09:00' }));

    // La touche laissée au navigateur n'est pas volée pour autant.
    await user.keyboard('{Enter}');
    expect(onChoose).toHaveBeenCalledWith(MATIN);
  });

  it('retient le créneau activé au clavier', async () => {
    const user = renderStep();
    const matin = await screen.findByRole('button', { name: '09:00' });

    matin.focus();
    await user.keyboard('{Enter}');

    expect(onChoose).toHaveBeenCalledWith(MATIN);
  });
});
