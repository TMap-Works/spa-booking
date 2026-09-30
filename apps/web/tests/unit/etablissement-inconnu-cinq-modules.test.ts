import { ERROR_CODES, LOCALES, errorMessage } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Les cinq autres modules d'actions nomment l'établissement qu'ils ne savent pas
 * lire — #1375, suite de #1372.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * `etablissement-inconnu-cinq-ecrans.test.tsx` monte un écran par module et lui
 * tend le refus : elle prouve qu'il le **nomme**. Elle double les actions, donc
 * elle ne prouve pas qu'elles le **rendent** — et une suite qui tendrait aux
 * écrans un refus qu'aucune action ne produit resterait verte sur un produit
 * resté fautif. Celle-ci s'exerce sur les vraies actions, sans aucun double de
 * leur logique : c'est l'autre moitié de la chaîne.
 *
 * ## Deux refus par module, et c'est tout le sujet
 *
 * Chaque module exige les deux : l'établissement illisible rend
 * `TENANT_NOT_FOUND`, **et** un autre refus que la même action oppose
 * d'elle-même garde `VALIDATION_ERROR`. Le premier seul laisserait passer un
 * module qui aurait remplacé un refus par l'autre ; le second seul, un module
 * qui ne les aurait jamais séparés — c'est précisément ce que faisaient les six
 * `if (!slug.success || !parsed.success)` de l'espace client.
 *
 * ## Pourquoi le jeton d'accès est posé
 *
 * Trois des cinq modules jugent leur charge utile **après** avoir ouvert la
 * session (`openCall`), et un cookie absent leur ferait rendre le refus de
 * session avant d'avoir rien jugé : le second cas de chaque paire ne serait
 * jamais atteint. Le cookie doublé ci-dessous ne prouve rien par lui-même, il
 * ouvre simplement le chemin jusqu'au refus qu'on mesure — aucune de ces actions
 * n'atteint l'API, toutes refusent avant.
 */

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// La langue des actions serveur se lit sur la requête, par `next-intl/server` :
// c'est elle que `unknownTenant()` interroge pour écrire son `message`.
vi.mock('next-intl/server', () => nextIntlServerMobile());

// Les trois modules du back-office qui périment des chemins l'importent ; aucun
// des refus mesurés ici ne va jusque-là, mais le module doit se charger.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import { createServiceAction } from '@/app/(admin)/[tenantSlug]/admin/catalogue/actions';
import { updateCustomerAction } from '@/app/(admin)/[tenantSlug]/admin/clients/actions';
import { inviteStaffAccountAction } from '@/app/(admin)/[tenantSlug]/admin/personnel/actions';
import {
  createReportExportAction,
  refreshReportExportAction,
} from '@/app/(admin)/[tenantSlug]/admin/reporting/actions';
import {
  cancelOwnAppointmentAction,
  loginAction,
  logoutAction,
  registerAction,
  rescheduleOwnAppointmentAction,
  saveAccountLocaleAction,
  updateProfileAction,
} from '@/app/(account)/[tenantSlug]/compte/actions';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';
const SLUG = 'maison-lotus';
const CUSTOMER_ID = 'dddddddd-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FENETRE = { from: '2026-08-31T22:00:00.000Z', to: '2026-09-30T22:00:00.000Z' };

beforeEach(() => {
  // Voir l'en-tête : le chemin doit rester ouvert jusqu'au refus qu'on mesure.
  cookieStore.get.mockReturnValue({ value: 'jeton-d-acces-de-test' });
});

afterEach(() => {
  vi.clearAllMocks();
  fixerLangue('fr');
});

/** Le code d'un refus, ou `'ok'` si l'action a abouti — de quoi comparer sans transtyper. */
function codeDe(result: { readonly ok: boolean } & Partial<{ readonly code: string }>): string {
  return result.ok ? 'ok' : (result.code ?? 'sans code');
}

/** Les refus d'un module ne portent pas de `details` : ils précèdent l'API. */
function detailsDe(
  result: { readonly ok: boolean } & Partial<{ readonly details?: unknown }>,
): unknown {
  return result.ok ? 'aboutie' : result.details;
}

describe('l’établissement illisible a son propre code, sur les cinq modules', () => {
  it('le catalogue le rend, donc ses six gestes', async () => {
    const refus = await createServiceAction(SLUG_ILLISIBLE, { name: 'Massage' });

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    // Aucun `details` : c'est le refus de l'action, et c'est ce qui le rendait
    // indiscernable du refus de saisie de son geste avant ce ticket.
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('les fiches clientes le rendent', async () => {
    const refus = await updateCustomerAction(SLUG_ILLISIBLE, CUSTOMER_ID, { firstName: 'Fara' });

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('le personnel le rend, donc ses onze gestes', async () => {
    const refus = await inviteStaffAccountAction(SLUG_ILLISIBLE, {
      email: 'hanta@example.mg',
      role: 'STAFF',
    });

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('les deux actions du reporting le rendent', async () => {
    expect(codeDe(await createReportExportAction(SLUG_ILLISIBLE, FENETRE, 'fr'))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
    expect(
      codeDe(await refreshReportExportAction(SLUG_ILLISIBLE, '33333333-3333-4333-8333-333333333333')),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
  });

  /**
   * Les sept actions de l'espace client, et non une seule.
   *
   * Six d'entre elles jugeaient le slug **dans le même `if`** que leur charge
   * utile : le refus dépendait donc de l'ordre des tests d'un `||`, et rien
   * n'aurait dit qu'une septième reprise à moitié le rendait encore sous la
   * phrase de son geste. Elles sont toutes exercées, avec un corps par ailleurs
   * **valide** — sans quoi le cas resterait vrai d'une action qui n'aurait
   * jamais séparé les deux.
   */
  it('les sept actions de l’espace client le rendent', async () => {
    expect(
      codeDe(
        await loginAction(SLUG_ILLISIBLE, {
          email: 'camille@example.test',
          password: 'mot-de-passe-solide',
        }),
      ),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(
      codeDe(
        await registerAction(SLUG_ILLISIBLE, {
          email: 'camille@example.test',
          password: 'mot-de-passe-solide',
          firstName: 'Camille',
          lastName: 'Rakoto',
        }),
      ),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(codeDe(await logoutAction(SLUG_ILLISIBLE))).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(codeDe(await updateProfileAction(SLUG_ILLISIBLE, { firstName: 'Camille' }))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
    expect(codeDe(await saveAccountLocaleAction(SLUG_ILLISIBLE, 'en'))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
    expect(codeDe(await cancelOwnAppointmentAction(SLUG_ILLISIBLE, APPOINTMENT_ID))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
    expect(
      codeDe(
        await rescheduleOwnAppointmentAction(SLUG_ILLISIBLE, APPOINTMENT_ID, {
          startsAt: '2026-08-26T06:00:00.000Z',
        }),
      ),
    ).toBe(ERROR_CODES.TENANT_NOT_FOUND);
  });
});

describe('le refus de saisie de la même action garde `VALIDATION_ERROR`', () => {
  it('la prestation mal formée du catalogue', async () => {
    expect(codeDe(await createServiceAction(SLUG, { name: '' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('la fiche cliente illisible', async () => {
    expect(codeDe(await updateCustomerAction(SLUG, 'pas-un-uuid', { firstName: 'Fara' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('l’invitation mal formée du personnel', async () => {
    expect(codeDe(await inviteStaffAccountAction(SLUG, { email: 'pas-une-adresse' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('la fenêtre d’export illisible, et l’export inconnu', async () => {
    expect(codeDe(await createReportExportAction(SLUG, { from: 1, to: 2 }, 'fr'))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(codeDe(await refreshReportExportAction(SLUG, 'pas-un-uuid'))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('les identifiants absents et le report illisible de l’espace client', async () => {
    expect(codeDe(await loginAction(SLUG, {}))).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(codeDe(await rescheduleOwnAppointmentAction(SLUG, 'pas-un-uuid', {}))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });
});

/**
 * Le `message` du refus suit la langue de la requête.
 *
 * Les écrans ne l'affichent plus — ils gardent le code et réécrivent la phrase à
 * chaque rendu (#1354) —, mais il reste ce que le contrat d'une action promet.
 * Les deux surfaces sont mesurées : le back-office le tire d'`unknownTenant()`
 * d'`action-result.ts`, l'espace client de son jumeau local, et rien ne dirait
 * que l'un des deux a cessé de consulter la table du contrat.
 */
describe.each([...LOCALES])('le message du refus, en « %s »', (locale) => {
  it('est la phrase du contrat, des deux côtés de la frontière', async () => {
    fixerLangue(locale);

    const backOffice = await createServiceAction(SLUG_ILLISIBLE, { name: 'Massage' });
    const espaceClient = await logoutAction(SLUG_ILLISIBLE);
    const attendue = errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);

    expect(backOffice.ok ? null : backOffice.message).toBe(attendue);
    expect(espaceClient.ok ? null : espaceClient.message).toBe(attendue);
  });
});
