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
import { act, cleanup, render, screen, within } from '@testing-library/react';
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

  it('garde les journées complètes dans la barre de dates, inertes', async () => {
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

    const complet = await screen.findByRole('radio', { name: /1 septembre 2026 — complet/ });
    const ouverte = screen.getByRole('radio', { name: /2 septembre 2026 — 1 créneau/ });

    // La journée ouverte est retenue d'office, la journée pleine reste lisible
    // mais hors du parcours du clavier — `keyboard-navigation.md`.
    expect(ouverte.getAttribute('aria-checked')).toBe('true');
    expect(complet.getAttribute('aria-disabled')).toBe('true');
    expect(complet).toHaveProperty('tabIndex', -1);
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

  it('élargit la fenêtre au-delà des quatorze jours sur demande', async () => {
    // `states.md` étape 3 : « Vide (aucune dispo sur toute la plage) : proposer
    // d'élargir la plage ». Le contrat en autorise trente et un.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    expect(await screen.findByText(/^Aucun créneau sur les 14 prochains jours$/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Voir plus de jours' }));

    expect(await screen.findByText(/^Aucun créneau sur les 31 prochains jours$/)).toBeDefined();

    const query = loadAvailabilityAction.mock.calls.at(-1)?.[1] as {
      from: CalendarDate;
      to: CalendarDate;
    };

    // Trente et une journées, bornes comprises — la borne du contrat, pas une
    // de plus : `availabilityQuerySchema` refuserait la requête.
    expect(addCalendarDays(query.from, 30)).toBe(query.to);
    // Une fois la fenêtre élargie, le bouton n'a plus rien à élargir.
    expect(screen.queryByRole('button', { name: 'Voir plus de jours' })).toBeNull();
  });

  it('rattrape le focus que le bouton emporte en disparaissant', async () => {
    // Le clic efface l'état vide qui portait le bouton : sans rattrapage, le
    // focus retombe sur `<body>` et le clavier repart du haut du document juste
    // après un geste délibéré.
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    await screen.findByRole('button', { name: 'Voir plus de jours' });
    await user.click(screen.getByRole('button', { name: 'Voir plus de jours' }));

    const vide = await screen.findByText(/^Aucun créneau sur les 31 prochains jours$/);

    // Le focus se pose sur l'état vide lui-même, qui dit en `role="status"` ce
    // que l'élargissement a donné — et non sur le squelette d'attente, qu'un
    // second rendu emporterait aussitôt.
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).contains(vide)).toBe(true);
  });

  it('rattrape le focus sur la barre de dates quand l’élargissement rend des créneaux', async () => {
    loadAvailabilityAction.mockResolvedValue({
      ok: true,
      data: availability([{ date: LUNDI, slots: [] }]),
    });
    const user = renderStep();

    await screen.findByRole('button', { name: 'Voir plus de jours' });
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: journeeOrdinaire });
    await user.click(screen.getByRole('button', { name: 'Voir plus de jours' }));

    await screen.findByRole('grid');

    expect(document.activeElement).toBe(screen.getByRole('radio', { checked: true }));
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
 * La barre de dates — `keyboard-navigation.md`, « Barre de dates », et
 * `states.md` étape 3 pour son maintien pendant le chargement.
 */
describe('barre de dates', () => {
  /**
   * La barre est là **avant** la réponse — c'est tout l'objet de `states.md`
   * étape 3 —, et elle porte alors la fenêtre civile calculée depuis
   * *aujourd'hui*. Interroger une journée du jeu d'essai sans attendre la
   * réponse tomberait donc sur une pastille de cette fenêtre-là, et le test
   * dépendrait du jour où la suite tourne. La grille, elle, n'existe qu'une fois
   * la réponse reçue : elle fait un point d'attente sûr.
   */
  const chargee = async (): Promise<HTMLElement> => screen.findByRole('grid');

  const deuxJournees = availability([
    { date: LUNDI, slots: [slot(MATIN, HERY)] },
    { date: MARDI, slots: [slot(MARDI_APRES_MIDI, HERY)] },
  ]);

  it('reste à l’écran et opérable pendant le chargement', async () => {
    // `states.md` : « grille de créneaux en squelette, **en gardant la barre de
    // dates interactive** pour changer de jour sans attendre ». La fenêtre est
    // une suite de dates civiles : le navigateur la pose sans le serveur.
    let libere: (value: unknown) => void = () => undefined;

    loadAvailabilityAction.mockReturnValue(
      new Promise((resolve) => {
        libere = resolve;
      }),
    );
    renderStep();

    const barre = screen.getByRole('radiogroup', { name: 'Journée' });

    expect(within(barre).getAllByRole('radio')).toHaveLength(14);
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

    const lundi = screen.getByRole('radio', { name: /1 septembre 2026/ });
    const mardi = screen.getByRole('radio', { name: /2 septembre 2026/ });

    expect(lundi).toHaveProperty('tabIndex', 0);
    expect(mardi).toHaveProperty('tabIndex', -1);
  });

  it('change de journée aux flèches, et la grille suit', async () => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: deuxJournees });
    const user = renderStep();
    await chargee();

    const lundi = screen.getByRole('radio', { name: /1 septembre 2026/ });
    const mardi = screen.getByRole('radio', { name: /2 septembre 2026/ });

    lundi.focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(mardi);
    expect(mardi.getAttribute('aria-checked')).toBe('true');
    // « Changer de jour recharge la grille » — le créneau du lundi a cédé la
    // place à celui du mardi, sans nouvel appel au serveur : la fenêtre entière
    // tient dans une seule réponse.
    expect(screen.getByRole('button', { name: '15 h 00' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '09 h 00' })).toBeNull();
  });

  it('ne boucle pas aux bords de la barre', async () => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: deuxJournees });
    const user = renderStep();
    await chargee();

    const lundi = screen.getByRole('radio', { name: /1 septembre 2026/ });
    const mardi = screen.getByRole('radio', { name: /2 septembre 2026/ });

    lundi.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(lundi);

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(mardi);
  });

  it('saute les journées complètes', async () => {
    // Elles restent affichées — le serveur les rend vides pour qu'on écrive
    // « complet » plutôt que de laisser un trou —, mais le clavier ne s'y pose
    // jamais : `keyboard-navigation.md`, « jamais focus, jamais sélectionnables ».
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

    const lundi = screen.getByRole('radio', { name: /1 septembre 2026/ });

    lundi.focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /3 septembre 2026/ }));
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

    expect(screen.getByRole('grid')).toBeDefined();
    expect(screen.getAllByRole('row')).toHaveLength(2);
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
