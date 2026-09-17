import type { Service, StaffMemberSummary } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';
import { calendarStartState } from '@/lib/admin/calendar-start';

/**
 * L'amorce de démarrage d'un établissement neuf (#751).
 *
 * Le planning ne tenait qu'un discours pour deux situations : la journée creuse
 * d'un salon installé, et le premier jour d'un salon qui n'a ni prestation ni
 * praticien. Au second, il proposait « Aller au jour suivant » — un lendemain
 * vide à l'identique, indéfiniment. `docs/design/appointments/states.md`,
 * « Règles générales », exige au contraire **une action pour sortir de
 * l'impasse**.
 *
 * Ce qui s'éprouve ici : la décision — ce qui manque —, et les deux écrans qui
 * la rendent, le planning et le tiroir. Le reste du planning a sa propre suite.
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

// Le module d'actions est doublé en entier : le planning et le tiroir en
// importent neuf, et un module simulé partiel échoue à l'import.
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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';
const CATALOGUE_HREF = '/maison-lotus/admin/catalogue';
const PERSONNEL_HREF = '/maison-lotus/admin/personnel';
const CHEMINS = { catalog: CATALOGUE_HREF, staff: PERSONNEL_HREF };

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
  assignedStaffCount: 1,
};

const HASINA: StaffMemberSummary = { id: 'staff-hasina', displayName: 'Hasina' };

const CREATION: DeskTarget = {
  kind: 'create',
  day: '2026-08-26',
  time: '14:30',
  staffId: HASINA.id,
};

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
  loadDeskAvailabilityAction.mockResolvedValue({ ok: true, data: { slots: [] } });
  loadDeskServiceStaffAction.mockResolvedValue({ ok: true, data: { staff: [] } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Le planning d'un établissement, tel que la page l'amorce. */
function renderBoard(options: {
  readonly services: readonly Service[];
  readonly staff: readonly StaffMemberSummary[];
  readonly setupKnown?: boolean;
  readonly loadError?: string | null;
}): void {
  render(
    <CalendarBoard
      date="2026-08-26"
      initialPeriods={{ 'jour:2026-08-26': [] }}
      loadError={options.loadError ?? null}
      services={options.services}
      setupKnown={options.setupKnown ?? true}
      staff={options.staff}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
      view="jour"
    />,
  );
}

describe('ce qui manque, et ce qu’on en dit', () => {
  it('nomme l’établissement neuf et propose les deux amorces, catalogue d’abord', () => {
    const etat = calendarStartState({ serviceCount: 0, staffCount: 0 }, CHEMINS);

    expect(etat.title).toBe('Ce salon n’est pas encore installé');
    // Le catalogue en premier : une prestation existe avant l'agenda qui la vend.
    expect(etat.links.map((lien) => lien.key)).toEqual(['catalogue', 'personnel']);
    expect(etat.links.map((lien) => lien.href)).toEqual([CATALOGUE_HREF, PERSONNEL_HREF]);
  });

  it('ne propose que le personnel quand le catalogue est déjà garni', () => {
    const etat = calendarStartState({ serviceCount: 3, staffCount: 0 }, CHEMINS);

    expect(etat.title).toBe('Aucune fiche praticien n’est ouverte');
    expect(etat.links.map((lien) => lien.key)).toEqual(['personnel']);
  });

  it('ne propose que le catalogue quand c’est lui qui manque', () => {
    const etat = calendarStartState({ serviceCount: 0, staffCount: 2 }, CHEMINS);

    // Le même énoncé que le tiroir : une seule cause, une seule formulation.
    expect(etat.title).toBe('Le catalogue est vide');
    expect(etat.links.map((lien) => lien.key)).toEqual(['catalogue']);
  });

  it('rend la période creuse sans amorce quand rien ne manque au salon', () => {
    // C'est ce qui laisse au planning sa flèche « jour suivant » : le conseil de
    // changer de période n'est faux que pour un salon qui n'est pas installé.
    const etat = calendarStartState({ serviceCount: 3, staffCount: 2 }, CHEMINS);

    expect(etat.title).toBe('Aucun rendez-vous sur cette période');
    expect(etat.links).toEqual([]);
  });
});

describe('le planning d’un salon neuf', () => {
  it('offre deux liens, vers le catalogue et vers le personnel', () => {
    renderBoard({ services: [], staff: [] });

    expect(screen.getByText('Ce salon n’est pas encore installé')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Ouvrir le catalogue' }).getAttribute('href')).toBe(
      CATALOGUE_HREF,
    );
    expect(screen.getByRole('link', { name: 'Ouvrir le personnel' }).getAttribute('href')).toBe(
      PERSONNEL_HREF,
    );
  });

  it('ne renvoie plus au lendemain, qui serait vide à l’identique', () => {
    renderBoard({ services: [], staff: [] });

    expect(screen.queryByRole('button', { name: 'Aller au jour suivant' })).toBeNull();
  });

  it('dit le praticien manquant quand le catalogue, lui, est prêt', () => {
    renderBoard({ services: [MASSAGE], staff: [] });

    expect(screen.getByText('Aucune fiche praticien n’est ouverte')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Ouvrir le personnel' })).toBeDefined();
    // Le catalogue est fait : le proposer quand même ferait deux pistes là où il
    // n'en reste qu'une.
    expect(screen.queryByRole('link', { name: 'Ouvrir le catalogue' })).toBeNull();
  });

  it('ne diagnostique rien quand le catalogue ou le répertoire n’a pas répondu', () => {
    // Les deux listes arrivent vides pour deux raisons opposées, et la page ne
    // fait pas tomber l'agenda pour une liste annexe : dire « ce salon n'est pas
    // encore installé » à un salon de quarante prestations parce que
    // `GET /v1/users` a rendu 500 serait une contrevérité affirmée.
    renderBoard({ services: [], staff: [], setupKnown: false });

    expect(screen.queryByText('Ce salon n’est pas encore installé')).toBeNull();
    expect(screen.getByText('Aucun rendez-vous sur cette période')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Aller au jour suivant' })).toBeDefined();
  });

  it('ne diagnostique rien non plus quand la période elle-même a échoué', () => {
    renderBoard({ services: [], staff: [], loadError: 'L’agenda n’a pas répondu.' });

    expect(screen.queryByText('Ce salon n’est pas encore installé')).toBeNull();
    expect(screen.getByText('Aucun rendez-vous sur cette période')).toBeDefined();
  });

  it('rend sa grille — et aucune amorce — dès qu’une fiche praticien existe', () => {
    renderBoard({ services: [MASSAGE], staff: [HASINA] });

    expect(screen.queryByText('Ce salon n’est pas encore installé')).toBeNull();
    expect(screen.getByRole('list', { name: /^Hasina/ })).toBeDefined();
  });
});

describe('le tiroir devant un catalogue vide', () => {
  it('mène au catalogue au lieu de s’arrêter sur le constat', () => {
    render(
      <AppointmentPanel
        onClose={vi.fn()}
        onExpired={vi.fn()}
        onReload={vi.fn()}
        services={[]}
        target={CREATION}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Le catalogue est vide')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Ouvrir le catalogue' }).getAttribute('href')).toBe(
      CATALOGUE_HREF,
    );
  });
});
