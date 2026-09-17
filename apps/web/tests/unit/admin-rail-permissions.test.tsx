import type { Permission } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminRail } from '@/app/(admin)/[tenantSlug]/admin/components/admin-rail';

/*
 * Le sommaire construit sur les **permissions servies**, et non sur une matrice
 * recopiée — #812, cinquième critère.
 *
 * Ce que la suite protège : qu'une praticienne ne se voie plus proposer le
 * planning du salon, l'annuaire des comptes ni l'encaissement (captures 1 et 2
 * du ticket), et qu'une gérante garde son sommaire entier.
 *
 * Elle ne prouve aucune frontière : le rail ne garde rien, un menu qui masque une
 * entrée n'interdit pas d'en taper l'URL, et la seule garde qui compte est celle
 * de l'API (`identity/__tests__/route-permissions.spec.ts`). Ce qui se joue ici
 * est de ne pas **proposer** un écran qui répondra 403.
 */

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLogoutAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/maison-lotus/admin/calendrier',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const LOTUS = { slug: 'maison-lotus', name: 'Maison Lotus' };

/** Ce que l'API sert à une praticienne depuis #812 — la ligne `STAFF` de l'ADR 0013. */
const PRATICIENNE: readonly Permission[] = [
  'agenda:read:own',
  'appointment:write:own',
  'customers:read:own',
];

/** Ce qu'elle sert à une gérante. */
const GERANTE: readonly Permission[] = [
  'agenda:read:own',
  'agenda:read:all',
  'appointment:write:own',
  'appointment:write:all',
  'customers:read:own',
  'customers:read:all',
  'customers:write',
  'accounts:read',
  'checkout:collect',
  'reporting:read',
];

afterEach(cleanup);

function renderRail(overrides: Partial<Parameters<typeof AdminRail>[0]> = {}) {
  return render(
    <AdminRail
      establishments={[LOTUS]}
      role="staff"
      tenantSlug="maison-lotus"
      timeZone="Indian/Antananarivo"
      userName="Claire R."
      {...overrides}
    />,
  );
}

function sections(): string[] {
  return screen
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
    .map((label) => label.replace(/\s+/g, ' ').trim());
}

describe('le sommaire d’une praticienne', () => {
  it('n’annonce ni le planning du salon, ni le personnel, ni l’encaissement', () => {
    renderRail({ permissions: PRATICIENNE });

    const annoncees = sections();

    expect(annoncees).not.toContain('Planning');
    expect(annoncees).not.toContain('Personnel');
    expect(annoncees).not.toContain('Encaissement');
  });

  it('lui laisse ce qu’elle a le droit d’ouvrir', () => {
    renderRail({ permissions: PRATICIENNE });

    const annoncees = sections();

    // Le fichier client s'ouvre avec `customers:read:own` — l'API le borne
    // ensuite à sa propre clientèle, et l'écran est le même.
    expect(annoncees).toContain('Clients');
    // `GET /v1/services` n'a pas changé de garde : l'entrée n'exige aucune
    // permission particulière, son rang suffit.
    expect(annoncees).toContain('Prestations');
  });
});

describe('le sommaire d’une gérante', () => {
  it('reste entier — le ticket referme une porte, pas deux', () => {
    renderRail({ role: 'manager', permissions: GERANTE });

    const annoncees = sections();

    for (const section of ['Planning', 'Clients', 'Prestations', 'Personnel', 'Encaissement', 'Reporting']) {
      expect(annoncees).toContain(section);
    }
  });

  it('n’annonce pas les réglages, qu’elle n’a pas le droit d’ouvrir', () => {
    renderRail({ role: 'manager', permissions: GERANTE });

    // Le rang l'écartait déjà ; la permission le dit désormais aussi, et les deux
    // doivent tomber d'accord.
    expect(sections()).not.toContain('Réglages');
  });
});

describe('quand le serveur n’a rien dit', () => {
  it('rend le sommaire du rang, et non un rail vide', () => {
    // `null` — `/auth/me` n'a pas répondu, ou le layout ne relaie pas encore la
    // liste. Un rail effacé ferait croire à une session dégradée ; un rail large
    // ne fait que proposer un écran qui répondra 403.
    renderRail({ role: 'manager', permissions: null });

    expect(sections()).toContain('Planning');
  });

  it('se comporte de même quand la prop est absente', () => {
    renderRail({ role: 'manager' });

    expect(sections()).toContain('Planning');
  });
});
