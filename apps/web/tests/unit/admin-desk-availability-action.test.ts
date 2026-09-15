import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L'action qui alimente le tiroir de rendez-vous en créneaux — premier et
 * deuxième critères d'acceptation de #642.
 *
 * Le fichier client est mocké **en entier** : ce qui se prouve ici n'est pas ce
 * qui part sur le fil — `admin-availability-api.test.ts` s'en charge —, mais
 * **laquelle des deux lectures l'action choisit**, et ce qu'elle lui passe. La
 * distinction compte : les deux fonctions rendent la même charge utile, et seule
 * la porte les sépare.
 */

const fetchAdminAvailability = vi.fn();
const fetchAvailability = vi.fn();
const cookieStore = { get: vi.fn() };

// Le module réel est repris et **deux fonctions seulement** sont remplacées :
// `ApiClientError` doit rester la vraie classe, faute de quoi le `instanceof`
// d'`action-result.ts` ne reconnaîtrait plus les refus de l'API.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchAdminAvailability: (...args: unknown[]) => fetchAdminAvailability(...args),
  // La lecture publique reste exportée — c'est celle du tunnel de réservation —,
  // et elle est doublée ici précisément pour pouvoir affirmer que le comptoir ne
  // l'appelle plus.
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// Importé après les `vi.mock`, que Vitest hisse de toute façon au-dessus des
// imports : l'ordre est ici une commodité de lecture, pas une contrainte.
import { loadDeskAvailabilityAction } from '@/app/(admin)/[tenantSlug]/admin/calendrier/actions';

const TOKEN = 'jeton-du-salon-lotus';
const SLUG = 'salon-lotus';
const SERVICE = '11111111-1111-4111-8111-111111111111';
const PRATICIENNE = '33333333-3333-4333-8333-333333333333';

const VUE = {
  serviceId: SERVICE,
  timezone: 'Indian/Antananarivo',
  days: [
    {
      date: '2026-09-15',
      slots: [
        {
          startsAt: '2026-09-15T06:00:00.000Z',
          endsAt: '2026-09-15T07:00:00.000Z',
          staffId: PRATICIENNE,
        },
      ],
    },
  ],
};

beforeEach(() => {
  cookieStore.get.mockImplementation((name: string) =>
    name === 'spa_admin_access' ? { value: TOKEN } : undefined,
  );
  fetchAdminAvailability.mockResolvedValue(VUE);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadDeskAvailabilityAction', () => {
  it('lit par la route gardée et lui passe le jeton de session', async () => {
    const result = await loadDeskAvailabilityAction(SLUG, { serviceId: SERVICE, day: '2026-09-15' });

    expect(fetchAdminAvailability).toHaveBeenCalledWith(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
    });
    // Le slug ne part plus vers l'API : il ne sert qu'à retrouver le cookie.
    expect(fetchAdminAvailability.mock.calls[0]).not.toContain(SLUG);
    expect(result).toEqual({ ok: true, data: { slots: VUE.days[0]?.slots } });
  });

  it('n’appelle plus aucune route publique', async () => {
    await loadDeskAvailabilityAction(SLUG, { serviceId: SERVICE, day: '2026-09-15' });

    expect(fetchAvailability).not.toHaveBeenCalled();
  });

  it('transmet les facultatifs du tiroir — praticienne et rendez-vous déplacé', async () => {
    const enCoursDeDeplacement = '44444444-4444-4444-8444-444444444444';

    await loadDeskAvailabilityAction(SLUG, {
      serviceId: SERVICE,
      day: '2026-09-15',
      staffId: PRATICIENNE,
      excludeAppointmentId: enCoursDeDeplacement,
    });

    expect(fetchAdminAvailability).toHaveBeenCalledWith(TOKEN, {
      serviceId: SERVICE,
      from: '2026-09-15',
      to: '2026-09-15',
      staffId: PRATICIENNE,
      excludeAppointmentId: enCoursDeDeplacement,
    });
  });

  it('ne lit rien sans session — le tiroir part au renouvellement', async () => {
    cookieStore.get.mockReturnValue(undefined);

    const result = await loadDeskAvailabilityAction(SLUG, {
      serviceId: SERVICE,
      day: '2026-09-15',
    });

    expect(fetchAdminAvailability).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
  });

  it('refuse une interrogation malformée avant d’atteindre l’API', async () => {
    const result = await loadDeskAvailabilityAction(SLUG, {
      serviceId: 'pas-un-uuid',
      day: '2026-09-15',
    });

    expect(fetchAdminAvailability).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });
});
