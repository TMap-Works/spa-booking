import type { PublicService, PublicTenant } from '@spa/shared';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RETURN_QUERY_KEY,
  safeReturnPath,
} from '@/app/(account)/[tenantSlug]/compte/connexion/return-path';
import BookingPage from '@/app/(booking)/[tenantSlug]/reservation/page';

/**
 * Ce que le tunnel écrit dans « Déjà cliente ? Se connecter » (#1087).
 *
 * Le lien est composé par la page — les composants ne connaissent pas
 * l'arborescence des routes — et il porte désormais le chemin du tunnel en
 * paramètre de retour. Ce qui se vérifie ici tient en deux choses : le paramètre
 * est bien là, et il est **acceptable pour le garde-fou de l'écran d'arrivée**,
 * qui a le dernier mot (`connexion/return-path.ts`).
 *
 * Et une troisième, qui est une décision et non un oubli : le retour ne porte
 * **aucune clé de progression**. Un `href` rendu côté serveur ignore l'étape que
 * le tunnel a atteinte depuis par `history.replaceState`, et l'URL fait foi dès
 * qu'elle porte une de nos clés (`draftFromSearch`) : un `?etape=` rapporté du
 * chargement effacerait la prestation et le créneau que le brouillon conserve.
 */

/*
 * Les doubles vivent dans `vi.hoisted` et non dans `./fixtures` : les fabriques
 * de `vi.mock` sont hissées au-dessus des importations, et une fabrique qui lit
 * un module importé plus bas le trouverait parfois non initialisé.
 */
const doubles = vi.hoisted(() => {
  const tenant = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'maison-lotus',
    name: 'Maison Lotus',
    timezone: 'Indian/Antananarivo',
    defaultCurrency: 'EUR',
  };
  const service = {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: { id: '33333333-3333-4333-8333-333333333333', slug: 'massages', name: 'Massages' },
    durationMinutes: 60,
    price: { amountMinor: 3500, currency: 'EUR' },
    staff: [{ id: '44444444-4444-4444-8444-444444444444', displayName: 'Hery' }],
  };

  return { tenant, service, tunnelProps: vi.fn() };
});

vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-tunnel', () => ({
  BookingTunnel: (props: Record<string, unknown>) => {
    doubles.tunnelProps(props);

    return null;
  },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicTenant: () => Promise.resolve(doubles.tenant as PublicTenant),
  fetchPublicServices: () => Promise.resolve([doubles.service as PublicService]),
}));

// Hors requête HTTP, `cookies()` n'existe pas : la présence est remplacée en
// entier, et ce ticket ne dit rien d'elle.
vi.mock('@/lib/account-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-presence')>()),
  readAccountPresence: () => Promise.resolve(null),
}));

const SLUG = doubles.tenant.slug;

afterEach(() => {
  doubles.tunnelProps.mockReset();
});

async function loginHrefFor(
  search: Record<string, string | string[] | undefined>,
): Promise<string> {
  render(
    await BookingPage({
      params: Promise.resolve({ tenantSlug: SLUG }),
      searchParams: Promise.resolve(search),
    }),
  );

  const props = doubles.tunnelProps.mock.calls[0]?.[0] as
    | { readonly loginHref: string }
    | undefined;

  if (props === undefined) {
    throw new Error('le tunnel n’a pas été monté');
  }

  return props.loginHref;
}

/** Ce que le paramètre de retour porte, une fois relu comme une query string. */
function retourFrom(href: string): string | null {
  return new URLSearchParams(href.slice(href.indexOf('?'))).get(RETURN_QUERY_KEY);
}

describe('tunnel — le lien de connexion porte le retour', () => {
  it('mène à la connexion du salon avec le tunnel en retour', async () => {
    const href = await loginHrefFor({});

    expect(href.startsWith(`/${SLUG}/compte/connexion?`)).toBe(true);
    expect(retourFrom(href)).toBe(`/${SLUG}/reservation`);
  });

  it('écrit un retour que le garde-fou de l’écran d’arrivée accepte tel quel', async () => {
    const href = await loginHrefFor({});

    expect(safeReturnPath(retourFrom(href), SLUG)).toBe(`/${SLUG}/reservation`);
  });

  it('ne recopie pas la progression du chargement, qui serait périmée au clic', async () => {
    const href = await loginHrefFor({ etape: 'creneau', prestation: doubles.service.id });
    const retour = new URLSearchParams((retourFrom(href) ?? '').split('?')[1] ?? '');

    expect(retour.has('etape')).toBe(false);
    expect(retour.has('prestation')).toBe(false);
  });
});
