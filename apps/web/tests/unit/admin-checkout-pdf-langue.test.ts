// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Le PDF de caisse sort dans la langue de l'**écran**, pas dans celle du salon
 * — #1259, et le doublon #1270 qui en précise les critères.
 *
 * ## Ce qui est éprouvé, et pourquoi jusqu'à `fetch`
 *
 * Le défaut se tenait sur **deux** fichiers : `fetchSaleReceiptPdf()` qui
 * n'écrivait aucun `locale` dans l'URL, et le relais qui n'en avait aucun à lui
 * donner. Doubler le client d'API aurait laissé passer un relais qui résout la
 * langue et un client qui l'ignore — deux moitiés vertes pour un produit
 * toujours en panne. La suite remplace donc `fetch` lui-même et lit l'**URL
 * sortante** : c'est la seule chose que l'API verra.
 *
 * Environnement Node et non jsdom, comme `session-refresh-routes` : la route
 * manipule des `Request` et des `Response` du standard, que jsdom ne fournit
 * pas.
 *
 * ## La langue bouge entre deux appels
 *
 * L'amorce des suites fige `next-intl/server` à `fr`
 * (`tests/support/next-intl.ts`) ; il en faut une qui bouge pour comparer les
 * deux langues sur le **même** relais. C'est la doublure mobile partagée
 * (#1277), la même que celle des actions serveur.
 */

const adminActionAccess = vi.fn();

vi.mock('next-intl/server', () => nextIntlServerMobile());

vi.mock('@/app/(admin)/[tenantSlug]/admin/session', () => ({
  adminActionAccess: (...args: unknown[]) => adminActionAccess(...args),
}));

// `lib/api-client` lit les cookies de la requête pour traduire un refus. Aucun
// chemin éprouvé ici n'y passe, mais l'import doit résoudre hors de Next.
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));

import { GET } from '@/app/(admin)/[tenantSlug]/admin/encaissement/ticket/[saleId]/route';
import { adminReceiptPdfPath } from '@/app/(admin)/[tenantSlug]/admin/paths';

const SLUG = 'maison-lotus';
const SALE_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 'jeton-d-acces';

const fetchStub = vi.fn();

beforeEach(() => {
  adminActionAccess.mockResolvedValue({ ok: true, accessToken: ACCESS_TOKEN });
  fetchStub.mockResolvedValue(
    new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="TIC-2026-000123.pdf"',
      },
    }),
  );
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  adminActionAccess.mockReset();
  fixerLangue('fr');
});

/** Le relais, appelé comme le navigateur l'appelle : par le `href` du bouton. */
async function servirLeTicket(format: 'ticket-80' | 'a4'): Promise<Response> {
  const href = adminReceiptPdfPath(SLUG, SALE_ID, format);

  return GET(new NextRequest(`http://localhost:3000${href}`), {
    params: Promise.resolve({ tenantSlug: SLUG, saleId: SALE_ID }),
  });
}

/** L'URL que le relais a demandée à l'API. */
function urlSortante(): URL {
  expect(fetchStub).toHaveBeenCalledTimes(1);

  return new URL(String(fetchStub.mock.calls[0]?.[0]));
}

describe('le PDF de caisse servi par le back-office', () => {
  it.each([
    ['fr', 'ticket-80'],
    ['fr', 'a4'],
    ['en', 'ticket-80'],
    ['en', 'a4'],
  ] as const)('demande la pièce en %s — mise en page %s', async (langue, format) => {
    fixerLangue(langue);

    const response = await servirLeTicket(format);
    const url = urlSortante();

    expect(response.status).toBe(200);
    expect(url.pathname).toBe(`/api/v1/sales/${SALE_ID}/receipt.pdf`);
    // La langue de l'écran, et la mise en page demandée : ni l'une ni l'autre ne
    // se déduit de la seconde.
    expect(url.searchParams.get('locale')).toBe(langue);
    expect(url.searchParams.get('format')).toBe(format);
  });

  it('ne fait pas dépendre la langue de la pièce du salon, mais de la session', async () => {
    fixerLangue('en');
    await servirLeTicket('ticket-80');
    const anglais = urlSortante().searchParams.get('locale');

    fetchStub.mockClear();
    fixerLangue('fr');
    await servirLeTicket('ticket-80');
    const francais = urlSortante().searchParams.get('locale');

    // Même établissement, même vente, même bouton : seule la langue de l'écran a
    // changé — c'est exactement le cas que `Tenant.defaultLocale` tranchait seul
    // avant #1259.
    expect([anglais, francais]).toEqual(['en', 'fr']);
  });

  it('laisse le `href` du bouton d’impression intact — la langue ne s’y écrit pas', () => {
    // Troisième critère de #1270 : le lien reste celui qu'éprouve
    // `checkout-panel.test.tsx`. La langue est celle de la **requête** que le
    // relais reçoit, pas un paramètre que le rendu aurait à figer — un `href`
    // qui la porterait périmerait au premier changement de langue de l'onglet.
    expect(adminReceiptPdfPath(SLUG, SALE_ID, 'ticket-80')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=ticket-80`,
    );
    expect(adminReceiptPdfPath(SLUG, SALE_ID, 'a4')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=a4`,
    );
  });
});
