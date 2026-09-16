/**
 * La fenêtre de créneaux de l'écran de report (#738).
 *
 * « Voir plus de jours » élargit cette fenêtre par l'adresse, et c'est le rendu
 * serveur de la page qui la traduit en bornes de requête. La traduction est
 * précisément ce qui s'est trompé à la recette : `calendarDaysBetween` compte
 * **les deux bornes**, si bien qu'un `to` posé à `from + 31` demande
 * trente-deux journées — que `availabilityQuerySchema` refuse par un 400, rendu
 * à l'écran en page d'erreur, sur le bouton même qui venait d'être cliqué.
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
  it('reste à quinze journées quand rien ne la demande plus large', async () => {
    const query = await queryFor();

    expect(span(query)).toBe(15);
    expect(availabilityQuerySchema.safeParse(query).success).toBe(true);
  });

  it('s’élargit à la borne du contrat, et pas d’une journée de plus', async () => {
    const query = await queryFor({ jours: String(MAX_AVAILABILITY_RANGE_DAYS) });

    expect(span(query)).toBe(MAX_AVAILABILITY_RANGE_DAYS);
    // Le schéma fait foi : c'est lui qui rendait 400 sur une journée de trop.
    expect(availabilityQuerySchema.safeParse(query).success).toBe(true);
  });

  it('ignore une profondeur que la visiteuse aurait écrite elle-même', async () => {
    // Le paramètre vient de l'adresse, donc du visiteur. Tout ce qui n'est pas
    // la valeur attendue retombe sur la fenêtre par défaut, plutôt que de
    // devenir une plage hors contrat que l'API refuserait.
    for (const jours of ['999', '0', '-31', 'trente-et-un', '']) {
      const query = await queryFor({ jours });

      expect(span(query)).toBe(15);
    }
  });
});
