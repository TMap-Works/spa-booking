/**
 * La fenêtre de créneaux de l'écran de report (#738, #827).
 *
 * Le mois regardé passe par l'adresse, et c'est le rendu serveur de la page qui
 * le traduit en bornes de requête. La traduction est précisément ce qui s'est
 * trompé à la recette de #738 : `calendarDaysBetween` compte **les deux
 * bornes**, si bien qu'un `to` posé à `from + 31` demande trente-deux journées —
 * que `availabilityQuerySchema` refuse par un 400, rendu à l'écran en page
 * d'erreur, sur le bouton même qui venait d'être cliqué.
 *
 * Le contrat est donc éprouvé avec le schéma lui-même plutôt qu'avec un compte
 * de journées réécrit ici : c'est la seule façon que les deux ne puissent pas
 * diverger.
 */

import { MAX_AVAILABILITY_RANGE_DAYS, availabilityQuerySchema } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchAvailability = vi.fn();
const fetchMyAppointments = vi.fn();
const fetchPublicServices = vi.fn();

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const SERVICE_ID = 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59';
const STAFF_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

vi.mock('@/lib/api-client', () => ({
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
  fetchMyAppointments: (...args: unknown[]) => fetchMyAppointments(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/tenant', () => ({
  accountTenant: () => Promise.resolve({ slug: 'spa-lumiere', name: 'Spa Lumière', timezone: 'UTC' }),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccountData: (
    _tenantSlug: string,
    _here: string,
    read: (accessToken: string) => Promise<unknown>,
  ) => read('jeton'),
}));

/**
 * Le jour « aujourd'hui » est piloté par le test.
 *
 * Les bornes de la requête dérivent maintenant du **mois** qu'on regarde, et un
 * mois n'a pas la même longueur selon la date où la suite tourne : sans cette
 * horloge fixe, l'essai serait vert quinze jours par mois. Le 17 septembre 2026
 * est un mois entamé — le cas courant — et sa fenêtre de trente et un jours
 * déborde sur octobre, ce qui donne deux mois à parcourir.
 */
const AUJOURDHUI = '2026-09-17';

vi.mock('@/lib/booking/calendar', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/booking/calendar')>();

  return { ...actual, calendarDateInTimeZone: () => AUJOURDHUI };
});

/**
 * Le formulaire est remplacé par une sonde : ce qui se prouve ici est ce que la
 * **page** demande au calendrier, pas ce que le client component en fait —
 * `reschedule-form.test.tsx` s'en charge déjà.
 */
vi.mock('@/app/(account)/[tenantSlug]/compte/components/reschedule-form', () => ({
  RescheduleForm: () => null,
}));

const { default: ReschedulePage } = await import(
  '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/report/page'
);

afterEach(() => {
  fetchAvailability.mockReset();
  fetchMyAppointments.mockReset();
  fetchPublicServices.mockReset();
});

/** Rend la page avec les paramètres d'adresse donnés, et rend la requête envoyée. */
async function queryFor(search: Record<string, string> = {}): Promise<{
  from: string;
  to: string;
  serviceId: string;
  staffId: string;
}> {
  fetchPublicServices.mockResolvedValue([{ id: SERVICE_ID, name: 'Massage suédois 60 min' }]);
  fetchMyAppointments.mockResolvedValue([
    {
      id: APPOINTMENT_ID,
      serviceId: SERVICE_ID,
      staffId: STAFF_ID,
      startsAt: '2026-09-17T08:40:00.000Z',
    },
  ]);
  fetchAvailability.mockResolvedValue({ serviceId: SERVICE_ID, timezone: 'UTC', days: [] });

  await ReschedulePage({
    params: Promise.resolve({ tenantSlug: 'spa-lumiere', appointmentId: APPOINTMENT_ID }),
    searchParams: Promise.resolve(search),
  });

  return fetchAvailability.mock.calls.at(-1)?.[1] as {
    from: string;
    to: string;
    serviceId: string;
    staffId: string;
  };
}

/** Le nombre de journées que la requête couvre, bornes comprises. */
function span(query: { from: string; to: string }): number {
  return Math.round((Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86_400_000) + 1;
}

describe('la fenêtre de créneaux du report', () => {
  it('demande le mois courant, rogné sur aujourd’hui', async () => {
    // Personne ne réserve dans le passé, et l'agenda de la première quinzaine
    // coûterait au moteur de disponibilité un calcul que rien n'affiche.
    const query = await queryFor();

    expect(query.from).toBe(AUJOURDHUI);
    expect(query.to).toBe('2026-09-30');
    expect(availabilityQuerySchema.safeParse(query).success).toBe(true);
  });

  it('ouvre le mois que l’adresse demande, rogné sur la fin de la fenêtre', async () => {
    const query = await queryFor({ mois: '2026-10' });

    expect(query.from).toBe('2026-10-01');
    // Trente et un jours bornes comprises depuis aujourd'hui : la borne du
    // contrat, pas une journée de plus.
    expect(query.to).toBe('2026-10-17');
    expect(availabilityQuerySchema.safeParse(query).success).toBe(true);
  });

  it('ne dépasse jamais le plafond du contrat, quel que soit le mois', async () => {
    for (const mois of ['2026-09', '2026-10']) {
      const query = await queryFor({ mois });

      expect(span(query)).toBeLessThanOrEqual(MAX_AVAILABILITY_RANGE_DAYS);
      // Le schéma fait foi : c'est lui qui rendait 400 sur une journée de trop.
      expect(availabilityQuerySchema.safeParse(query).success).toBe(true);
    }
  });

  it('ignore un mois que la visiteuse aurait écrit elle-même', async () => {
    // Le paramètre vient de l'adresse, donc du visiteur. Tout ce qui n'est pas
    // atteignable retombe sur le mois courant, plutôt que de devenir une plage
    // hors contrat — ou vide — que l'API refuserait.
    for (const mois of ['2026-11', '2026-08', '1970-01', 'septembre', '2026-9', '']) {
      const query = await queryFor({ mois });

      expect(query.from).toBe(AUJOURDHUI);
      expect(query.to).toBe('2026-09-30');
    }
  });
});
