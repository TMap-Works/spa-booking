import type { AvailabilityResponse } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RescheduleForm } from '@/app/(account)/[tenantSlug]/compte/components/reschedule-form';

/**
 * L'écran de report.
 *
 * Deux choses s'y prouvent, et rien d'autre — ce que la page serveur envoie à
 * l'API (`excludeAppointmentId`) se prouve à l'intégration, côté API :
 *
 * - **#442** — la liste ainsi élargie contient les créneaux qui *chevauchent* le
 *   rendez-vous, son heure actuelle comprise, et cette heure-là ne doit pas
 *   pouvoir être choisie : l'écran proposerait sinon de déplacer un rendez-vous
 *   là où il est déjà ;
 * - **#622** — le choix passe par le sélecteur du tunnel : une bande de journées,
 *   puis la grille d'**une seule** journée. L'écran dépliait auparavant toutes
 *   les journées d'un coup, 4 960 px de haut à 360 px, le bouton de validation
 *   deux mille pixels sous le créneau qu'on venait de choisir.
 */

const rescheduleOwnAppointmentAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  rescheduleOwnAppointmentAction: (...args: unknown[]) => rescheduleOwnAppointmentAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
}));

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const STAFF_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SERVICE_ID = 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59';

/** L'heure actuelle du rendez-vous — 14:00 UTC, un soin d'une heure. */
const CURRENT_STARTS_AT = '2026-09-01T14:00:00.000Z';

/**
 * La journée telle que l'API la rend **avec** l'exclusion : le créneau actuel,
 * et les deux quarts d'heure qui le chevauchent de part et d'autre.
 *
 * Sans l'exclusion, aucun des trois n'y figurerait — c'est tout le propos de
 * #442, et c'est ce qui rend ce jeu d'essai représentatif.
 */
const availability: AvailabilityResponse = {
  serviceId: SERVICE_ID,
  timezone: 'UTC',
  days: [
    {
      date: '2026-09-01',
      slots: [
        { startsAt: '2026-09-01T13:45:00.000Z', endsAt: '2026-09-01T14:45:00.000Z', staffId: STAFF_ID },
        { startsAt: CURRENT_STARTS_AT, endsAt: '2026-09-01T15:00:00.000Z', staffId: STAFF_ID },
        { startsAt: '2026-09-01T14:15:00.000Z', endsAt: '2026-09-01T15:15:00.000Z', staffId: STAFF_ID },
      ],
    },
  ],
};

/** Deux journées ouvertes et une complète — de quoi éprouver la bande de journées. */
const troisJournees: AvailabilityResponse = {
  ...availability,
  days: [
    ...availability.days,
    { date: '2026-09-02', slots: [] },
    {
      date: '2026-09-03',
      slots: [
        { startsAt: '2026-09-03T09:30:00.000Z', endsAt: '2026-09-03T10:30:00.000Z', staffId: STAFF_ID },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  rescheduleOwnAppointmentAction.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

function renderForm(days: AvailabilityResponse = availability): ReturnType<typeof userEvent.setup> {
  render(
    <RescheduleForm
      tenantSlug="salon-des-lilas"
      appointmentId={APPOINTMENT_ID}
      currentStartsAt={CURRENT_STARTS_AT}
      serviceName="Massage suédois"
      availability={days}
      timeZone="UTC"
    />,
  );

  return userEvent.setup();
}

describe('report — les créneaux qui chevauchent le rendez-vous déplacé', () => {
  it('propose les quarts d’heure qui chevauchent le rendez-vous', () => {
    renderForm();

    // Le geste que #442 rend atteignable : décaler d'un quart d'heure un soin
    // d'une heure, ce que le calendrier refusait tant qu'il comptait le
    // rendez-vous comme occupant.
    expect(screen.getByRole('button', { name: '13 h 45' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('button', { name: '14 h 15' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('montre l’heure actuelle, la nomme, et ne la laisse pas choisir', async () => {
    const user = renderForm();

    const current = screen.getByRole('button', { name: '14 h 00 (actuel)' });

    // Rendu — le retirer ferait un trou inexplicable dans la journée — mais
    // inerte : « déplacer au 1er septembre 14:00 » un rendez-vous déjà fixé au
    // 1er septembre 14:00 est une phrase qui se contredit.
    expect(current.getAttribute('aria-disabled')).toBe('true');
    // `aria-disabled` et non `disabled` : un bouton désactivé pour de bon ferait
    // un trou dans le parcours des flèches de la grille, et le créneau suivant
    // deviendrait inatteignable au clavier.
    expect(current).toHaveProperty('disabled', false);
    // Le mot est écrit sous l'heure : l'atténuation ne porte pas seule
    // l'information (WCAG 1.4.1).
    expect(current.textContent).toContain('actuel');

    await user.click(current);

    expect(screen.getByRole('button', { name: /Choisissez un créneau/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('n’envoie rien tant qu’aucun créneau n’est retenu', () => {
    renderForm();

    expect(screen.getByRole('button', { name: /Choisissez un créneau/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(rescheduleOwnAppointmentAction).not.toHaveBeenCalled();
  });

  it('reporte sur le créneau chevauchant retenu', async () => {
    rescheduleOwnAppointmentAction.mockResolvedValue({ ok: true });
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: '14 h 15' }));

    const confirm = screen.getByRole('button', { name: /Déplacer au/ });
    await user.click(confirm);

    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledTimes(1);
    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledWith(
      'salon-des-lilas',
      APPOINTMENT_ID,
      { startsAt: '2026-09-01T14:15:00.000Z' },
    );
  });
});

/**
 * #622 — le report emploie le sélecteur du tunnel, et non une liste dépliée.
 */
describe('report — le sélecteur est celui du tunnel', () => {
  it('présente les créneaux en grille, une ligne par moment de la journée', () => {
    renderForm();

    // La grille composite de `keyboard-navigation.md`, et non une suite de
    // boutons : c'est elle qui donne au clavier son axe vertical.
    expect(screen.getByRole('grid')).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Après-midi' })).toBeDefined();
  });

  it('ne déplie qu’une journée à la fois sous une bande de journées', () => {
    renderForm(troisJournees);

    const barre = screen.getByRole('radiogroup', { name: 'Journée' });

    // Les trois journées de la fenêtre sont dans la bande — la complète
    // comprise, faute de quoi on croirait le salon fermé ce jour-là —, mais une
    // seule grille est dépliée.
    expect(within(barre).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '13 h 45' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '09 h 30' })).toBeNull();
  });

  it('change de journée sans recharger la page', async () => {
    const user = renderForm(troisJournees);

    await user.click(screen.getByRole('radio', { name: /3 septembre 2026 — 1 créneau/ }));

    expect(screen.getByRole('button', { name: '09 h 30' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '13 h 45' })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('n’ouvre pas une journée complète', async () => {
    const user = renderForm(troisJournees);

    const complet = screen.getByRole('radio', { name: /2 septembre 2026 — complet/ });

    expect(complet.getAttribute('aria-disabled')).toBe('true');

    await user.click(complet);

    // Rien à montrer dessous : la journée du 1er reste dépliée.
    expect(screen.getByRole('button', { name: '13 h 45' })).toBeDefined();
  });

  it('explique l’agenda vide plutôt que de laisser une grille sans rien', () => {
    renderForm({ ...availability, days: [{ date: '2026-09-01', slots: [] }] });

    expect(screen.getByText('Aucun créneau disponible')).toBeDefined();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});
