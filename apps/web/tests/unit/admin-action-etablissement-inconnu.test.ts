import { ERROR_CODES, LOCALES, errorMessage } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Les actions du comptoir nomment l'établissement qu'elles ne savent pas lire —
 * #1372.
 *
 * ## Ce que cette suite prouve, et que la suite des écrans ne prouve pas
 *
 * `admin-etablissement-inconnu.test.tsx` monte les quatre écrans et leur tend le
 * refus : elle prouve qu'ils le **nomment**. Elle double les actions, donc elle
 * ne prouve pas qu'elles le **rendent** — et une suite qui tendrait aux écrans
 * un refus qu'aucune action ne produit resterait verte sur un produit resté
 * fautif. C'est l'autre moitié de la chaîne, et elle s'exerce sur les vraies
 * actions.
 *
 * ## Deux refus par action, et c'est tout le sujet
 *
 * Chaque cas exige les deux : l'établissement illisible rend `TENANT_NOT_FOUND`,
 * **et** la cible illisible de la même action garde `VALIDATION_ERROR`. Le
 * premier seul laisserait passer une action qui aurait remplacé un refus par
 * l'autre ; le second seul, une action qui ne les aurait jamais séparés.
 *
 * Aucune n'atteint l'API : les deux refus sont opposés avant tout appel, et
 * c'est ce qui les rendait indiscernables — même code, même `details` absent.
 */

const cookieStore = { get: vi.fn() };

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// La langue des actions serveur se lit sur la requête, par `next-intl/server` :
// c'est elle que `unknownTenant()` interroge pour écrire son `message`.
vi.mock('next-intl/server', () => nextIntlServerMobile());

import {
  loadCalendarRangeAction,
  searchDeskClientsAction,
} from '@/app/(admin)/[tenantSlug]/admin/calendrier/actions';
import {
  loadReceiptAction,
  openCheckoutTicketAction,
  settleTicketAction,
} from '@/app/(admin)/[tenantSlug]/admin/encaissement/actions';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';
const SLUG = 'maison-lotus';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SERVICE_ID = 'cccccccc-0000-4000-8000-000000000001';
const SALE_ID = '99999999-0000-4000-8000-000000000009';
/** Dans les bornes de l'API — 8 à 128 caractères — pour que seul le reste refuse. */
const CLE = 'cle-idempotence-1372';

afterEach(() => {
  vi.clearAllMocks();
  fixerLangue('fr');
});

/** Le code d'un refus, ou `'ok'` si l'action a abouti — de quoi comparer sans transtyper. */
function codeDe(result: { readonly ok: boolean } & Partial<{ readonly code: string }>): string {
  return result.ok ? 'ok' : (result.code ?? 'sans code');
}

describe('l’établissement illisible a son propre code', () => {
  it('est rendu par la lecture d’une période du planning', async () => {
    const refus = await loadCalendarRangeAction(SLUG_ILLISIBLE, 'jour', '2026-08-26');

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    // Aucun `details` : c'est le refus de l'action, et c'est ce qui le faisait
    // passer pour celui de la saisie du geste avant ce ticket.
    expect(refus.ok ? null : refus.details).toBeUndefined();
  });

  it('est rendu par `deskToken`, donc par tous les gestes du tiroir', async () => {
    const refus = await searchDeskClientsAction(SLUG_ILLISIBLE, 'Rina');

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
  });

  it('est rendu par les trois écritures du comptoir', async () => {
    expect(
      codeDe(await openCheckoutTicketAction(SLUG_ILLISIBLE, APPOINTMENT_ID, SERVICE_ID)),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(
      codeDe(
        await settleTicketAction(
          SLUG_ILLISIBLE,
          SALE_ID,
          { method: 'CASH', amountMinor: 3500 },
          CLE,
        ),
      ),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(codeDe(await loadReceiptAction(SLUG_ILLISIBLE, SALE_ID))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
  });
});

describe('la cible illisible de la même action garde le refus de saisie', () => {
  it('l’ancrage du planning reste un `VALIDATION_ERROR`', async () => {
    const refus = await loadCalendarRangeAction(SLUG, 'jour', 'pas-une-date');

    expect(codeDe(refus)).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('le rendez-vous du comptoir aussi', async () => {
    const refus = await openCheckoutTicketAction(SLUG, 'pas-un-uuid', SERVICE_ID);

    expect(codeDe(refus)).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('le ticket dont on demande le reçu aussi', async () => {
    const refus = await loadReceiptAction(SLUG, 'pas-un-uuid');

    expect(codeDe(refus)).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

/**
 * Le `message` du refus suit la langue de la requête.
 *
 * Les écrans ne l'affichent plus — ils gardent le code et réécrivent la phrase à
 * chaque rendu (#1354) —, mais il reste ce que le contrat d'une action promet, et
 * `unknownTenant()` le tire d'`errorMessage`, comme `failure()` et `expired()`.
 */
describe.each([...LOCALES])('le message du refus, en « %s »', (locale) => {
  it('est la phrase du contrat pour ce code', async () => {
    fixerLangue(locale);

    const refus = await loadCalendarRangeAction(SLUG_ILLISIBLE, 'jour', '2026-08-26');

    expect(refus.ok ? null : refus.message).toBe(
      errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
    );
  });
});
