import type { Appointment, Service } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';
import { DESK_ROUTE_MISSING_MESSAGE } from '@/lib/admin/appointment-desk';

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
    expect(screen.getByLabelText<HTMLInputElement>(/Heure de début/).value).toBe('08:00');
  });

  it('ouvre en édition sur le rendez-vous cliqué', async () => {
    const user = userEvent.setup();

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadError={null}
        services={[MASSAGE]}
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
    expect(screen.getByLabelText<HTMLInputElement>(/Heure de début/).value).toBe('09:00');
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

    expect(await screen.findByText(/Ce créneau vient d’être réservé/)).toBeDefined();
    // Le planning est relu — le créneau perdu doit se voir occupé…
    await waitFor(() => {
      expect(onReload).toHaveBeenCalledTimes(1);
    });
    // …mais le tiroir reste ouvert, et la saisie avec lui.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>(/Heure de début/).value).toBe('14:30');
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
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText(DESK_ROUTE_MISSING_MESSAGE)).toBeDefined();
  });

  it('dit que le catalogue est vide plutôt que d’offrir un sélecteur muet', () => {
    renderPanel(CREATION, []);

    expect(screen.getByText('Le catalogue est vide')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Créer le rendez-vous' })).toBeNull();
  });
});
