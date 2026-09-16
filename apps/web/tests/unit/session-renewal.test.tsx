import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAdminSessionRenewal } from '@/app/(admin)/[tenantSlug]/admin/components/use-admin-session-renewal';
import { useAccountSessionRenewal } from '@/app/(account)/[tenantSlug]/compte/components/use-account-session-renewal';
import { currentReturnTo, isSessionExpired, useSessionRenewal } from '@/lib/session-renewal';

/**
 * Le helper commun par lequel un écran part se renouveler (#856).
 *
 * Il remplace quatre copies, et quinze écrans qui affichaient « Reconnectez-vous »
 * à la place : ce qui est tenu ici est donc ce que tous ces écrans font
 * désormais d'un `UNAUTHORIZED`.
 */

const replace = vi.fn();

/**
 * Un routeur **neuf à chaque rendu**, comme les doublures des autres suites :
 * c'est ce qui prouve que le helper ne rend pas une fonction différente à
 * chaque rendu, et qu'un écran peut la placer dans les dépendances d'un effet.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace }),
}));

afterEach(() => {
  replace.mockReset();
  globalThis.history.replaceState(null, '', '/');
});

describe('isSessionExpired', () => {
  it('ne reconnaît que le refus faute de session', () => {
    expect(isSessionExpired({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(isSessionExpired({ code: 'FORBIDDEN' })).toBe(false);
    expect(isSessionExpired({ code: 'VALIDATION_ERROR' })).toBe(false);
    expect(isSessionExpired({ code: 'SERVICE_UNAVAILABLE' })).toBe(false);
  });
});

describe('currentReturnTo', () => {
  it('rend le chemin et la requête de la page affichée', () => {
    expect(currentReturnTo({ pathname: '/lotus/admin/catalogue', search: '?actives=1' })).toBe(
      '/lotus/admin/catalogue?actives=1',
    );
    expect(currentReturnTo({ pathname: '/lotus/admin/reglages', search: '' })).toBe(
      '/lotus/admin/reglages',
    );
  });

  it('lit la barre d’adresse par défaut', () => {
    globalThis.history.replaceState(null, '', '/lotus/admin/reporting?periode=mois');
    expect(currentReturnTo()).toBe('/lotus/admin/reporting?periode=mois');
  });
});

describe('useSessionRenewal', () => {
  const refreshPath = (returnTo: string): string => `/renouveler?next=${returnTo}`;

  it('part vers la route de renouvellement sur une session expirée, avec la page affichée', () => {
    globalThis.history.replaceState(null, '', '/lotus/admin/reglages');
    const { result } = renderHook(() => useSessionRenewal(refreshPath));

    expect(result.current.renewIfExpired({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(replace).toHaveBeenCalledWith('/renouveler?next=/lotus/admin/reglages');
  });

  it('laisse l’écran traiter tout autre refus', () => {
    const { result } = renderHook(() => useSessionRenewal(refreshPath));

    expect(result.current.renewIfExpired({ code: 'CONFLICT' })).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('revient sur la destination que l’écran désigne, quand il en désigne une', () => {
    const { result } = renderHook(() => useSessionRenewal(refreshPath));

    result.current.renew('/lotus/admin/calendrier?vue=semaine&date=2026-09-14');
    expect(replace).toHaveBeenCalledWith(
      '/renouveler?next=/lotus/admin/calendrier?vue=semaine&date=2026-09-14',
    );
  });

  it('rend les mêmes fonctions d’un rendu à l’autre', () => {
    const { result, rerender } = renderHook(() => useSessionRenewal(refreshPath));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.renew).toBe(first.renew);
  });
});

describe('les deux surfaces', () => {
  it('le back-office part vers sa propre route, bornée à l’établissement', () => {
    globalThis.history.replaceState(null, '', '/maison-lotus/admin/personnel');
    const { result } = renderHook(() => useAdminSessionRenewal('maison-lotus'));

    expect(result.current.renewIfExpired({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(replace).toHaveBeenCalledWith(
      `/maison-lotus/admin/session/refresh?next=${encodeURIComponent('/maison-lotus/admin/personnel')}`,
    );
  });

  it('l’espace client part vers la sienne', () => {
    globalThis.history.replaceState(null, '', '/maison-lotus/compte/coordonnees');
    const { result } = renderHook(() => useAccountSessionRenewal('maison-lotus'));

    expect(result.current.renewIfExpired({ code: 'UNAUTHORIZED' })).toBe(true);
    expect(replace).toHaveBeenCalledWith(
      `/maison-lotus/compte/session/refresh?next=${encodeURIComponent('/maison-lotus/compte/coordonnees')}`,
    );
  });

  it('garde les fonctions stables tant que l’établissement ne change pas', () => {
    const { result, rerender } = renderHook(
      ({ slug }: { slug: string }) => useAdminSessionRenewal(slug),
      { initialProps: { slug: 'maison-lotus' } },
    );
    const first = result.current;

    rerender({ slug: 'maison-lotus' });
    expect(result.current).toBe(first);

    rerender({ slug: 'salon-des-lilas' });
    expect(result.current).not.toBe(first);
  });
});
