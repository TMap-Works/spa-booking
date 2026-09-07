import type { Appointment, Notification as NotificationTrace, Service } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { NotificationStatusList } from '@/app/(admin)/[tenantSlug]/admin/components/notification-status-list';

/**
 * Le statut d'envoi dans le back-office — cinquième critère d'acceptation de
 * #70.
 *
 * Deux niveaux, et il faut les deux : la **section** rend correctement ce qu'on
 * lui donne, et le **tiroir** va bien la chercher. Une section parfaite jamais
 * montée n'aurait rien prouvé.
 *
 * L'action serveur est doublée : ce qui est exercé ici est l'écran, pas le
 * transport — le transport a sa recette et ses suites d'intégration.
 */

const loadCalendarRangeAction = vi.fn();
const loadDeskServiceStaffAction = vi.fn();
const loadAppointmentNotificationsAction = vi.fn();
const createDeskAppointmentAction = vi.fn();
const rescheduleDeskAppointmentAction = vi.fn();
const markDeskAppointmentStatusAction = vi.fn();
const searchDeskClientsAction = vi.fn();
const createDeskClientAction = vi.fn();

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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

/** UTC+3, sans heure d'été — la convention des suites admin. */
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

const CONFIRME: Appointment = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  status: 'confirmed',
  client: { id: 'dddddddd-0000-4000-8000-000000000001', firstName: 'Rina', lastName: 'Andriamana' },
  staff: { id: 'staff-hasina', displayName: 'Hasina' },
  service: { id: MASSAGE.id, name: MASSAGE.name, durationMinutes: 60, price: MASSAGE.price },
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
  price: MASSAGE.price,
  createdAt: '2026-08-01T08:00:00.000Z',
};

/** L'e-mail parti — 08:00 UTC, donc 11:00 au salon d'Antananarivo. */
const EMAIL_ENVOYE: NotificationTrace = {
  id: 'eeeeeeee-0000-4000-8000-000000000001',
  appointmentId: CONFIRME.id,
  type: 'booking_confirmation',
  channel: 'email',
  status: 'sent',
  sentAt: '2026-08-01T08:00:00.000Z',
  attemptCount: 1,
  createdAt: '2026-08-01T08:00:00.000Z',
};

/** Le SMS en échec — l'information qui justifie tout cet écran. */
const SMS_ECHOUE: NotificationTrace = {
  id: 'ffffffff-0000-4000-8000-000000000002',
  appointmentId: CONFIRME.id,
  type: 'booking_confirmation',
  channel: 'sms',
  status: 'failed',
  attemptCount: 2,
  failureReason: 'Aucun expéditeur n’est configuré pour ce canal de notification.',
  createdAt: '2026-08-01T08:00:01.000Z',
};

const EDITION: DeskTarget = { kind: 'edit', appointment: CONFIRME };

function renderPanel(target: DeskTarget = EDITION) {
  render(
    <AppointmentPanel
      onClose={vi.fn()}
      onExpired={vi.fn()}
      onReload={vi.fn()}
      services={[MASSAGE]}
      target={target}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
    />,
  );
}

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
  loadDeskServiceStaffAction.mockResolvedValue({
    ok: true,
    data: { staff: [{ id: 'staff-hasina', displayName: 'Hasina', isActive: true }] },
  });
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
  loadAppointmentNotificationsAction.mockResolvedValue({ ok: true, data: { notifications: [] } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('le statut d’envoi est visible dans le back-office', () => {
  it('affiche chaque message avec son canal et son statut', async () => {
    loadAppointmentNotificationsAction.mockResolvedValue({
      ok: true,
      data: { notifications: [SMS_ECHOUE, EMAIL_ENVOYE] },
    });

    renderPanel();

    expect(await screen.findByText(/Confirmation · SMS/)).toBeDefined();
    expect(screen.getByText(/Confirmation · E-mail/)).toBeDefined();
    expect(screen.getByText('Échec')).toBeDefined();
    expect(screen.getByText('Envoyé')).toBeDefined();
  });

  it('montre le motif d’échec — sans quoi la seule trace est la cliente absente', async () => {
    loadAppointmentNotificationsAction.mockResolvedValue({
      ok: true,
      data: { notifications: [SMS_ECHOUE] },
    });

    renderPanel();

    expect(await screen.findByText(/Aucun expéditeur n’est configuré/)).toBeDefined();
  });

  it('demande le journal du rendez-vous ouvert, et de lui seul', async () => {
    renderPanel();

    await screen.findByText(/Aucun message n’a encore été émis/);
    expect(loadAppointmentNotificationsAction).toHaveBeenCalledWith(SLUG, CONFIRME.id);
  });

  it('ne demande rien à la création — le rendez-vous n’existe pas encore', () => {
    renderPanel({ kind: 'create', day: '2026-08-26', time: '14:30', staffId: 'staff-hasina' });

    expect(loadAppointmentNotificationsAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Messages envoyés')).toBeNull();
  });

  it('renouvelle la session plutôt que d’afficher une panne quand le jeton a expiré', async () => {
    loadAppointmentNotificationsAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Session expirée.',
    });
    const onExpired = vi.fn();

    render(
      <AppointmentPanel
        onClose={vi.fn()}
        onExpired={onExpired}
        onReload={vi.fn()}
        services={[MASSAGE]}
        target={EDITION}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    await waitFor(() => {
      expect(onExpired).toHaveBeenCalled();
    });
  });

  it('dit que le journal n’a pas pu être lu, plutôt que d’afficher « aucun message »', async () => {
    loadAppointmentNotificationsAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Panne.',
    });

    renderPanel();

    expect(await screen.findByText(/n’a pas pu être lu/)).toBeDefined();
  });
});

describe('l’heure affichée est celle du salon', () => {
  it('convertit l’instant UTC au fuseau de l’établissement', () => {
    // 08:00 UTC = 11:00 à Antananarivo (UTC+3). Afficher l'instant tel quel
    // décalerait la trace de trois heures — le même bug, au bout de la chaîne,
    // que celui qu'on refuse dans l'e-mail lui-même.
    render(<NotificationStatusList notifications={[EMAIL_ENVOYE]} timeZone={TIMEZONE} />);

    expect(screen.getByText(/Envoyé le .*11:00/)).toBeDefined();
  });

  it('affiche l’instant d’inscription, en le disant, quand rien n’est encore parti', () => {
    const enAttente: NotificationTrace = { ...EMAIL_ENVOYE, status: 'pending', sentAt: undefined };

    render(<NotificationStatusList notifications={[enAttente]} timeZone={TIMEZONE} />);

    expect(screen.getByText(/Inscrit le/)).toBeDefined();
    expect(screen.queryByText(/Envoyé le/)).toBeNull();
  });
});

describe('les états que la section sait rendre', () => {
  it('annonce la lecture en cours plutôt qu’un écran vide trompeur', () => {
    render(<NotificationStatusList loading notifications={null} timeZone={TIMEZONE} />);

    expect(screen.getByText(/Lecture du journal/)).toBeDefined();
  });

  it('distingue « aucun message » de « la lecture a échoué »', () => {
    // Les deux se ressemblent à l'écran et ne veulent pas du tout dire la même
    // chose pour la personne qui a la cliente au téléphone.
    render(<NotificationStatusList notifications={[]} timeZone={TIMEZONE} />);
    expect(screen.getByText(/Aucun message n’a encore été émis/)).toBeDefined();

    cleanup();

    render(
      <NotificationStatusList
        failure="Le journal d’envois n’a pas pu être lu."
        notifications={null}
        timeZone={TIMEZONE}
      />,
    );
    expect(screen.getByText(/n’a pas pu être lu/)).toBeDefined();
    expect(screen.queryByText(/Aucun message/)).toBeNull();
  });

  it('n’offre aucun bouton de renvoi — la reprise appartient à la file', () => {
    // Un bouton au comptoir doublerait la file et masquerait la profondeur de
    // DLQ sur laquelle repose l'alarme de supervision (notifications §4).
    render(<NotificationStatusList notifications={[SMS_ECHOUE]} timeZone={TIMEZONE} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ne montre ni destinataire ni contenu de message', () => {
    // L'API n'en rend pas — la table n'en porte pas (CDC §5.1). L'assertion
    // garde la propriété visible si la projection s'élargissait un jour.
    const { container } = render(
      <NotificationStatusList notifications={[EMAIL_ENVOYE, SMS_ECHOUE]} timeZone={TIMEZONE} />,
    );

    expect(container.textContent).not.toContain('@');
  });

  it('écrit toujours le libellé du statut, jamais la couleur seule', () => {
    // WCAG 1.4.1 : la couleur ne porte jamais l'information à elle seule.
    render(
      <NotificationStatusList
        notifications={[EMAIL_ENVOYE, SMS_ECHOUE, { ...EMAIL_ENVOYE, id: 'x', status: 'pending' }]}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Envoyé')).toBeDefined();
    expect(screen.getByText('Échec')).toBeDefined();
    expect(screen.getByText('En attente')).toBeDefined();
  });
});
