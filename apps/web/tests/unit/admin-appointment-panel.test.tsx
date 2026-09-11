import type { Appointment, Service } from '@spa/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';
import {
  DESK_NO_SLOT_MESSAGE,
  DESK_ROUTE_MISSING_MESSAGE,
  DESK_SLOTS_UNREADABLE_MESSAGE,
} from '@/lib/admin/appointment-desk';

import { deskSlot, deskSlots } from './admin-desk-fixtures';

/**
 * Le tiroir de rendez-vous du comptoir (#50, les cinq critères).
 *
 * Les actions serveur sont doublées : ce qui est exercé ici est l'écran — ce
 * qu'un clic ouvre, ce qu'un refus affiche, ce qu'un bouton envoie —, pas le
 * transport. Le transport a sa recette.
 *
 * Le cas le plus important est le **créneau perdu** : c'est le seul où l'écran
 * doit se comporter autrement que devant une panne, et le seul que la
 * concurrence produit tous les jours dans un salon à plusieurs postes.
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
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const TIMEZONE = 'Indian/Antananarivo';
const SLUG = 'maison-lotus';

const MASSAGE: Service = {
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
};

const RINA = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  firstName: 'Rina',
  lastName: 'Andriamana',
  email: 'rina@example.com',
  phone: '+261320000000',
  isActive: true,
};

/** 09:00 – 10:00 au salon d'Antananarivo, le mercredi 26 août 2026. */
const CONFIRME: Appointment = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  status: 'confirmed',
  client: { id: RINA.id, firstName: RINA.firstName, lastName: RINA.lastName },
  staff: { id: 'staff-hasina', displayName: 'Hasina' },
  service: { id: MASSAGE.id, name: MASSAGE.name, durationMinutes: 60, price: MASSAGE.price },
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
  price: MASSAGE.price,
  createdAt: '2026-08-01T08:00:00.000Z',
};

function renderPanel(target: DeskTarget, services: readonly Service[] = [MASSAGE]) {
  const onClose = vi.fn();
  const onReload = vi.fn();
  const onExpired = vi.fn();

  render(
    <AppointmentPanel
      onClose={onClose}
      onExpired={onExpired}
      onReload={onReload}
      services={services}
      target={target}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
    />,
  );

  return { onClose, onReload, onExpired };
}

/**
 * Le bouton de validation, une fois que le tiroir a lu ses créneaux (#611).
 *
 * Il reste désactivé tant qu'aucun créneau réel n'est retenu : un clic posé
 * avant la lecture ne déclencherait rien, et le scénario passerait sans avoir
 * rien exercé.
 */
async function enregistrerArme(nom: string): Promise<HTMLElement> {
  const bouton = screen.getByRole('button', { name: nom });

  await waitFor(() => {
    expect(bouton.hasAttribute('disabled')).toBe(false);
  });

  return bouton;
}

const CREATION: DeskTarget = {
  kind: 'create',
  day: '2026-08-26',
  time: '14:30',
  staffId: 'staff-hasina',
};

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
  loadDeskServiceStaffAction.mockResolvedValue({
    ok: true,
    data: { staff: [{ id: 'staff-hasina', displayName: 'Hasina', isActive: true }] },
  });
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [RINA] } });
  loadAppointmentNotificationsAction.mockResolvedValue({ ok: true, data: { notifications: [] } });
  // Les créneaux que le moteur rend vraiment : au quart d'heure, alignés sur
  // 07:10, donc aucun à la minute 00 (#611). Celui de 09:00 au salon s'y ajoute
  // — c'est celui du rendez-vous de `CONFIRME`, que `excludeAppointmentId` rend
  // à nouveau libre dès qu'on ouvre le tiroir pour le déplacer (#442).
  loadDeskAvailabilityAction.mockResolvedValue({
    ok: true,
    data: { slots: [deskSlot('2026-08-26T06:00:00.000Z'), ...deskSlots('2026-08-26')] },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('premier critère — le tiroir s’ouvre sur le créneau cliqué', () => {
  it('amorce la date et l’heure du créneau libre choisi dans le planning', async () => {
    const user = userEvent.setup();

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadError={null}
        services={[MASSAGE]}
        // Ces deux cas partent d'une journée déjà occupée : la colonne vient du
        // rendez-vous posé, pas du répertoire (#507).
        staff={[]}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        view="jour"
      />,
    );

    // Le premier créneau libre de la colonne d'Hasina — 08 h 00, la grille
    // s'ouvrant par défaut à 8 h.
    await user.click(screen.getByRole('button', { name: /08 h 00.*poser un rendez-vous/ }));

    expect(screen.getByRole('heading', { name: 'Nouveau rendez-vous' })).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>(/^Date/).value).toBe('2026-08-26');
    // 08:10 et non 08:00 : la rangée cliquée est une intention, et le tiroir la
    // résout sur le premier créneau que le moteur propose réellement (#611).
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('08:10');
    });
  });

  it('ouvre en édition sur le rendez-vous cliqué', async () => {
    const user = userEvent.setup();

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadError={null}
        services={[MASSAGE]}
        // Ces deux cas partent d'une journée déjà occupée : la colonne vient du
        // rendez-vous posé, pas du répertoire (#507).
        staff={[]}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        view="jour"
      />,
    );

    // Le bloc lui-même, désigné par son heure : depuis #51 il a une poignée pour
    // sœur — « Déplacer Rina Andriamana » —, et le seul nom du client ne suffit
    // plus à les distinguer.
    await user.click(screen.getByRole('button', { name: /^09:00 – 10:00 Rina Andriamana/ }));

    expect(screen.getByRole('heading', { name: 'Rina Andriamana' })).toBeDefined();
    // 06:00 UTC = 09:00 au salon : c'est l'heure du salon qui doit s'afficher.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('09:00');
    });
  });
});

describe('deuxième critère — la fiche cliente', () => {
  it('cherche, laisse choisir, et n’autorise la création qu’une fois choisie', async () => {
    const user = userEvent.setup();
    renderPanel(CREATION);

    const enregistrer = screen.getByRole('button', { name: 'Créer le rendez-vous' });
    expect(enregistrer.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));

    expect(searchDeskClientsAction).toHaveBeenCalledWith(SLUG, 'Rina');
    expect(
      screen.getByRole('button', { name: 'Créer le rendez-vous' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('propose de créer la fiche quand la recherche ne rend rien', async () => {
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Zafy');

    expect(await screen.findByText(/Aucune fiche pour/)).toBeDefined();
  });
});

describe('quatrième critère — le créneau perdu n’est pas une panne', () => {
  it('avertit, redemande le planning et conserve toutes les autres saisies', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Ce créneau vient d’être réservé.',
    });

    const { onReload, onClose } = renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    await user.click(screen.getByRole('button', { name: 'Créer le rendez-vous' }));

    // Le message ne nomme plus de cause : le 409 en couvre cinq et n'en
    // distingue aucune (#611).
    expect(await screen.findByText(/n’est pas — ou n’est plus — réservable/)).toBeDefined();
    expect(screen.queryByText(/vient d’être pris depuis un autre poste/)).toBeNull();
    // Le planning est relu — le créneau perdu doit se voir occupé…
    await waitFor(() => {
      expect(onReload).toHaveBeenCalledTimes(1);
    });
    // …mais le tiroir reste ouvert, et la saisie avec lui.
    expect(onClose).not.toHaveBeenCalled();
    // 14:40 : le premier créneau réel à partir de la rangée cliquée à 14:30.
    expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('14:40');
    expect(screen.getByText(/Rina Andriamana/)).toBeDefined();
  });
});

describe('cinquième critère — marquer honoré et non présenté', () => {
  it('n’offre les deux gestes que depuis un rendez-vous confirmé', () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(screen.getByRole('button', { name: 'Marquer honoré' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Marquer non présenté' })).toBeDefined();
  });

  it('n’en offre aucun sur un rendez-vous déjà soldé', () => {
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, status: 'completed' } });

    expect(screen.queryByRole('button', { name: 'Marquer honoré' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marquer non présenté' })).toBeNull();
  });

  it('envoie le statut du contrat, puis referme et relit le planning', async () => {
    const user = userEvent.setup();
    markDeskAppointmentStatusAction.mockResolvedValue({
      ok: true,
      data: { ...CONFIRME, status: 'no_show' },
    });

    const { onReload, onClose } = renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Marquer non présenté' }));

    await waitFor(() => {
      expect(markDeskAppointmentStatusAction).toHaveBeenCalledWith(SLUG, CONFIRME.id, {
        status: 'no_show',
      });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('la dégradation, tant que l’API ne sert pas l’écriture', () => {
  it('nomme la route absente au lieu de recracher le cadre HTTP', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'HTTP_404',
      message: 'Cannot POST /api/v1/appointments/…/reschedule',
    });

    renderPanel({ kind: 'edit', appointment: CONFIRME });
    // Le bouton ne s'arme qu'une fois les créneaux lus (#611) : cliquer avant
    // ne déclencherait rien, et le test passerait sans rien prouver.
    await user.click(await enregistrerArme('Enregistrer'));

    expect(await screen.findByText(DESK_ROUTE_MISSING_MESSAGE)).toBeDefined();
  });

  it('dit que le catalogue est vide plutôt que d’offrir un sélecteur muet', () => {
    renderPanel(CREATION, []);

    expect(screen.getByText('Le catalogue est vide')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Créer le rendez-vous' })).toBeNull();
  });
});

/**
 * L'écran ne propose plus que ce que le moteur peut honorer (#611).
 *
 * C'était le défaut le plus coûteux de cet écran : la grille du planning trace
 * des heures rondes, le moteur n'en rend aucune, et chaque case « libre » menait
 * donc à un `409 SLOT_NO_LONGER_AVAILABLE` — six refus d'affilée relevés au
 * comptoir sur une journée qui ne portait pas un seul rendez-vous.
 */
describe('#611 — le tiroir n’offre que des créneaux réservables', () => {
  it('n’offre que les créneaux de la journée interrogée — pas une seule heure ronde', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { slots: deskSlots('2026-08-26') },
    });
    renderPanel(CREATION);

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    // La journée, la prestation et le praticien retenus — les trois font la liste.
    expect(loadDeskAvailabilityAction).toHaveBeenCalledWith(SLUG, {
      serviceId: MASSAGE.id,
      day: '2026-08-26',
      staffId: 'staff-hasina',
    });

    const proposees = [...heures.options].map((option) => option.value);
    expect(proposees).toContain('14:40');
    // Le cœur du ticket : la grille de 30 minutes du planning n'a rien à voir
    // avec le pas de 15 minutes du moteur, aligné sur 07:10.
    expect(proposees.filter((heure) => heure.endsWith(':00'))).toEqual([]);
  });

  it('envoie l’instant exact rendu par le moteur, et non une reconversion de l’heure civile', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({ ok: true, data: CONFIRME });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    await user.click(await enregistrerArme('Créer le rendez-vous'));

    await waitFor(() => {
      expect(createDeskAppointmentAction).toHaveBeenCalledWith(
        SLUG,
        // 14:40 au salon d'Antananarivo, qui est à UTC+3 — c'est bien la chaîne
        // que le moteur a rendue qui repart, à l'identique.
        expect.objectContaining({ startsAt: '2026-08-26T11:40:00.000Z' }),
      );
    });
  });

  it('dit la journée complète et refuse d’envoyer plutôt que de provoquer un 409', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({ ok: true, data: { slots: [] } });
    renderPanel(CREATION);

    expect(await screen.findByText(DESK_NO_SLOT_MESSAGE)).toBeDefined();
    // Le bouton reste hors d'atteinte : ce qui manque est un créneau, et aucune
    // saisie ne peut y remédier.
    expect(
      screen.getByRole('button', { name: 'Créer le rendez-vous' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(createDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('retombe sur la saisie libre quand la disponibilité n’a pas pu être lue', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Une erreur inattendue est survenue.',
    });
    renderPanel(CREATION);

    expect(await screen.findByText(DESK_SLOTS_UNREADABLE_MESSAGE)).toBeDefined();

    // Un champ de saisie, et non un sélecteur vide : une disponibilité illisible
    // ne ferme pas le comptoir, et c'est l'API qui juge le créneau.
    const heure = screen.getByLabelText<HTMLInputElement>(/Heure de début/);
    expect(heure.tagName).toBe('INPUT');
    expect(heure.value).toBe('14:30');
  });

  it('relit les créneaux quand l’API refuse celui qu’on vient d’envoyer', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Ce créneau vient d’être réservé.',
    });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    const appelsAvant = loadDeskAvailabilityAction.mock.calls.length;
    await user.click(await enregistrerArme('Créer le rendez-vous'));

    // Le créneau refusé n'a plus à figurer dans la liste : sans cette relecture,
    // l'opératrice renvoie la même heure et reçoit le même refus (#611).
    await waitFor(() => {
      expect(loadDeskAvailabilityAction.mock.calls.length).toBeGreaterThan(appelsAvant);
    });
  });

  it('exclut le rendez-vous déplacé de sa propre disponibilité', async () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await waitFor(() => {
      expect(loadDeskAvailabilityAction).toHaveBeenCalledWith(
        SLUG,
        expect.objectContaining({ excludeAppointmentId: CONFIRME.id }),
      );
    });
  });

  it('garde l’heure d’un rendez-vous posé que le moteur n’offre plus', async () => {
    // Le cas courant : les horaires du praticien ont changé depuis la
    // réservation, et 09:00 n'est plus un créneau. Le tiroir ne doit pas pour
    // autant afficher une **autre** heure que celle du rendez-vous — le
    // récapitulatif suivrait, et un « Enregistrer » cliqué de confiance
    // déplacerait un rendez-vous que personne n'a demandé à déplacer.
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { slots: deskSlots('2026-08-26') },
    });
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    expect(heures.value).toBe('09:00');
    // Affichée, mais pas réservable : c'est bien un créneau de la liste qu'il
    // faut choisir pour envoyer le report.
    expect(screen.getByRole('button', { name: 'Enregistrer' }).hasAttribute('disabled')).toBe(true);
  });

  it('dit encore l’heure du rendez-vous sur une journée sans créneau', async () => {
    // La journée d'un rendez-vous **passé** n'offre rien : le moteur filtre le
    // passé et le préavis. Ouvrir le tiroir pour marquer « honoré » ne doit pas
    // effacer de l'écran l'heure à laquelle ce rendez-vous a eu lieu.
    loadDeskAvailabilityAction.mockResolvedValue({ ok: true, data: { slots: [] } });
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(await screen.findByText(DESK_NO_SLOT_MESSAGE)).toBeDefined();

    const heures = screen.getByLabelText<HTMLSelectElement>(/Heure de début/);
    expect(heures.value).toBe('09:00');
  });

  it('n’interroge pas la disponibilité sur une date en cours de frappe', async () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    const appelsAvant = loadDeskAvailabilityAction.mock.calls.length;
    // Un `<input type="date">` rend une valeur vide tant que ses trois segments
    // ne sont pas tous saisis. L'interroger là-dessus ne rapporterait qu'un
    // refus de validation, que l'écran traduirait en « disponibilité illisible »
    // — donc en retour à la saisie libre, c'est-à-dire au 409 qu'on supprime.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(/^Date/), { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/Lecture des créneaux disponibles/)).toBeDefined();
    });
    expect(loadDeskAvailabilityAction.mock.calls.length).toBe(appelsAvant);
    expect(screen.queryByText(DESK_SLOTS_UNREADABLE_MESSAGE)).toBeNull();
  });
});
