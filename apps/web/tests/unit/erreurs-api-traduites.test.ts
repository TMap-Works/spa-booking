// @vitest-environment node
import { ERROR_CODES, errorMessage, type Locale } from '@spa/shared';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Aucun message écrit par l'API n'arrive à l'écran — #1298.
 *
 * ## Le défaut que cette suite referme
 *
 * L'API n'a pas de langue de requête : ses `DomainError` sont rédigées **une
 * fois**, en français, pour le journal et le diagnostic (en-tête de
 * `packages/shared/src/errors/error-messages.ts`). Trois chemins les
 * réaffichaient tels quels, et redevenaient donc français au premier incident :
 *
 * 1. `reservation/actions.ts` — le refus que `slot-step.tsx` peint sous le
 *    calendrier quand le chargement des créneaux est refusé (limite de débit,
 *    fenêtre trop large) ;
 * 2. `lib/admin/calendar-failure.ts` — tout refus du planning autre que le 404,
 *    sur le chemin du **premier rendu**, qui appelle l'API directement et n'a
 *    donc que son corps d'erreur. Le chemin de l'action serveur, lui, apporte
 *    une phrase déjà traduite, et la retraduire par son code l'écraserait sous
 *    la phrase générique de `VALIDATION_ERROR` : les deux sont éprouvés ici,
 *    parce que corriger le premier sans regarder le second est précisément la
 *    régression que la revue de ce ticket a attrapée ;
 * 3. le relais PDF du comptoir — une phrase **nue dans un onglet**, sans écran
 *    autour pour en rattraper le sens.
 *
 * ## Ce qui est éprouvé, et jusqu'où
 *
 * Jusqu'à `fetch`, pour les deux chemins qui passent par l'API. Doubler
 * `lib/api-client` aurait laissé passer un client qui cesserait de rendre le
 * `code` : c'est le corps d'erreur **servi par l'API** qui doit être neutralisé,
 * et la seule façon de le prouver est de le faire traverser le vrai client.
 *
 * Chaque cas exige donc deux choses à la fois : que la phrase soit **celle du
 * contrat** pour la langue demandée, et que le message français de l'API ne s'y
 * trouve pas. La première seule resterait verte si les deux se ressemblaient ;
 * la seconde seule le resterait si l'écran n'affichait plus rien du tout.
 *
 * Les phrases attendues sont **lues** dans `errorMessage`, jamais recopiées —
 * un littéral resterait vert le jour où ces chemins cesseraient de lire la table.
 *
 * ## Environnement Node, et une langue mobile
 *
 * Node plutôt que jsdom, comme `admin-checkout-pdf-langue` : le relais manipule
 * des `Request` et des `Response` du standard. La langue vient de la doublure
 * mobile partagée (#1277) : le même refus est exigé dans les deux langues à la
 * suite, ce qui distingue « la phrase est traduite » de « la phrase est
 * anglaise ».
 */

const adminActionAccess = vi.fn();

vi.mock('next-intl/server', () => nextIntlServerMobile());

// `lib/api-client` lit les signaux de langue de la requête quand il doit
// fabriquer un refus lui-même. Aucun cas éprouvé ici n'y passe — tous les refus
// viennent d'un corps d'erreur conforme —, mais l'import doit résoudre hors de
// Next.
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: vi.fn() }),
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/session', () => ({
  adminActionAccess: (...args: unknown[]) => adminActionAccess(...args),
}));

const { loadAvailabilityAction } = await import(
  '@/app/(booking)/[tenantSlug]/reservation/actions'
);
const { GET } = await import(
  '@/app/(admin)/[tenantSlug]/admin/encaissement/ticket/[saleId]/route'
);
const { calendarApiFailureMessage, calendarFailureMessage } = await import(
  '@/lib/admin/calendar-failure'
);

const SLUG = 'maison-lotus';
const SALE_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';

/** Les deux langues du produit, dans l'ordre où le front les sert. */
const LANGUES: readonly Locale[] = ['en', 'fr'];

/**
 * Un code que `ERROR_CODES` ne connaît pas.
 *
 * Ce n'est pas une hypothèse d'école : le filtre d'exception de l'API fabrique
 * des `HTTP_<statut>` pour les statuts qu'il ne sait pas nommer, et une version
 * d'API plus récente que le front peut introduire un code de domaine que
 * celui-ci ignore — c'est la raison pour laquelle `apiErrorSchema` type `code`
 * en `z.string()` et non en `z.enum`.
 */
const CODE_INCONNU = 'HTTP_418';

/** Ce que l'API écrit dans son corps d'erreur : du français, pour le journal. */
const MESSAGE_DE_L_API = 'Trop de tentatives, patientez un instant.';

const fetchStub = vi.fn();

/** La réponse d'erreur de l'API, corps du contrat compris. */
function refusDeLApi(code: string, status: number): Response {
  return new Response(JSON.stringify({ code, message: MESSAGE_DE_L_API, details: {} }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  adminActionAccess.mockResolvedValue({ ok: true, accessToken: 'jeton-d-acces' });
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  adminActionAccess.mockReset();
  fixerLangue('fr');
});

/** Le chargement des créneaux du tunnel, tel que `slot-step.tsx` l'appelle. */
async function chargerLesCreneaux(): Promise<{ code: string; message: string }> {
  const result = await loadAvailabilityAction(SLUG, {
    serviceId: SERVICE_ID,
    from: '2026-09-01',
    to: '2026-09-07',
  });

  // Un `ok: true` ici voudrait dire que la doublure de `fetch` n'a pas servi le
  // refus, et les assertions qui suivent ne mesureraient plus rien.
  expect(result.ok).toBe(false);

  return result as { code: string; message: string };
}

/** Le relais PDF, appelé comme le navigateur l'appelle : par le `href` du bouton. */
function servirLeTicket(): Promise<Response> {
  return GET(
    new NextRequest(`http://localhost:3000/${SLUG}/admin/encaissement/ticket/${SALE_ID}`),
    { params: Promise.resolve({ tenantSlug: SLUG, saleId: SALE_ID }) },
  );
}

describe('le chargement des créneaux du tunnel', () => {
  it.each(LANGUES)('dit un refus nommé par l’API dans la langue de la session — %s', async (langue) => {
    fixerLangue(langue);
    fetchStub.mockResolvedValue(refusDeLApi(ERROR_CODES.TOO_MANY_REQUESTS, 429));

    const refus = await chargerLesCreneaux();

    expect(refus.code).toBe(ERROR_CODES.TOO_MANY_REQUESTS);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.TOO_MANY_REQUESTS, langue));
    expect(refus.message).not.toBe(MESSAGE_DE_L_API);
  });

  it.each(LANGUES)('retombe sur la phrase générique quand le code est inconnu — %s', async (langue) => {
    fixerLangue(langue);
    fetchStub.mockResolvedValue(refusDeLApi(CODE_INCONNU, 418));

    const refus = await chargerLesCreneaux();

    // Le code traverse tel quel — c'est lui que l'écran trie —, mais la phrase
    // est celle d'`INTERNAL_ERROR`, dans la langue de la session.
    expect(refus.code).toBe(CODE_INCONNU);
    expect(refus.message).toBe(errorMessage(ERROR_CODES.INTERNAL_ERROR, langue));
    expect(refus.message).not.toBe(MESSAGE_DE_L_API);
  });
});

describe('le refus du planning du back-office', () => {
  it.each(LANGUES)('traduit tout refus autre que l’agenda non servi — %s', (langue) => {
    expect(calendarApiFailureMessage(ERROR_CODES.APPOINTMENT_RANGE_TOO_WIDE, langue)).toBe(
      errorMessage(ERROR_CODES.APPOINTMENT_RANGE_TOO_WIDE, langue),
    );
  });

  it.each(LANGUES)('retombe sur la phrase générique quand le code est inconnu — %s', (langue) => {
    expect(calendarApiFailureMessage(CODE_INCONNU, langue)).toBe(
      errorMessage(ERROR_CODES.INTERNAL_ERROR, langue),
    );
  });

  it.each(LANGUES)('garde le diagnostic propre au 404 — %s', (langue) => {
    // Sur cette route, un 404 ne peut vouloir dire qu'une chose : `GET
    // /appointments` n'est pas servie. Ce message-là reste celui du catalogue du
    // planning, et la phrase générique du contrat ne doit pas l'avoir avalé.
    const dit = calendarApiFailureMessage(ERROR_CODES.NOT_FOUND, langue);

    expect(dit).not.toBe(errorMessage(ERROR_CODES.NOT_FOUND, langue));
    expect(dit).not.toBe(MESSAGE_DE_L_API);
  });

  it.each(LANGUES)('laisse intacte la phrase que le planning a lui-même écrite — %s', (langue) => {
    // L'autre chemin : l'action serveur rend un refus dont le message est déjà
    // dans la langue de la session — `invalid(t('actions.invalidDate'))`. Le
    // traduire une seconde fois par le code l'écraserait sous la phrase
    // générique de `VALIDATION_ERROR`, qui ne dit plus quelle date a été refusée.
    const ecritParLePlanning = 'That date could not be read.';

    expect(
      calendarFailureMessage(ERROR_CODES.VALIDATION_ERROR, ecritParLePlanning, langue),
    ).toBe(ecritParLePlanning);
  });
});

describe('le relais du ticket de caisse en PDF', () => {
  it.each(LANGUES)('rend le refus de l’API dans la langue du poste — %s', async (langue) => {
    fixerLangue(langue);
    fetchStub.mockResolvedValue(refusDeLApi(ERROR_CODES.SALE_ALREADY_SETTLED, 409));

    const response = await servirLeTicket();

    // Le statut reste celui de l'API : c'est lui qui porte la nature du refus.
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(errorMessage(ERROR_CODES.SALE_ALREADY_SETTLED, langue));
  });

  it.each(LANGUES)('retombe sur la phrase générique quand le code est inconnu — %s', async (langue) => {
    fixerLangue(langue);
    fetchStub.mockResolvedValue(refusDeLApi(CODE_INCONNU, 418));

    const response = await servirLeTicket();
    const texte = await response.text();

    expect(texte).toBe(errorMessage(ERROR_CODES.INTERNAL_ERROR, langue));
    expect(texte).not.toBe(MESSAGE_DE_L_API);
  });
});
