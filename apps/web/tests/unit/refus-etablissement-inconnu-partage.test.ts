import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, LOCALES, errorMessage } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Les trois surfaces rendent **le même** refus d'établissement inconnu — #1395.
 *
 * ## Ce que cette suite prouve, et ce qu'aucune autre ne prouvait
 *
 * Les suites `etablissement-inconnu-*` exercent chaque émetteur de la classe et
 * prouvent qu'il rend `TENANT_NOT_FOUND` plutôt que le refus de saisie de son geste.
 * Aucune ne compare les surfaces **entre elles** : chacune mesure la sienne, et
 * trois copies pouvaient dériver l'une de l'autre sans qu'aucune ne rougisse.
 *
 * C'est précisément ce que l'arbitrage de #1395 a tranché, et sur cet argument-là :
 * une copie qui ne doit jamais diverger n'a aucun bénéfice de l'être. Le corps vit
 * désormais dans `lib/tenant-refusal.ts`, et cette suite est ce qui tient la
 * promesse — elle rougirait le jour où une surface reviendrait à son propre littéral
 * et le ferait dériver.
 *
 * ## Les trois critères du ticket, mesurés là où ils se voient
 *
 * | Critère | Ce qui le mesure ici |
 * |---|---|
 * | le refus rendu n'a pas changé | les trois refus sont **égaux**, dans les deux langues, et leur phrase est lue dans la table du contrat plutôt que recopiée |
 * | le `details` du back-office ne se propage pas | les clés sont relevées sur le refus du back-office, seul des trois dont le type **autorise** ce champ : il n'y est pas, et les deux autres ne l'ont pas gagné |
 * | la question synchrone / asynchrone est tranchée | la fabrique partagée prend la langue et n'interroge jamais la requête — ses imports le disent —, et le back-office est le seul à la lire lui-même, sans qu'on lui passe rien |
 *
 * Les refus sont exercés par les **vraies** actions de chaque surface là où leur
 * fabricant est privé — l'espace client et le tunnel —, et par le fabricant lui-même
 * là où il est exporté. Une suite qui appellerait trois fois la fabrique partagée ne
 * prouverait rien : c'est que les surfaces y recourent encore qui est en jeu.
 */

// `lib/api-client.ts` lit les en-têtes de la requête, et il est importé par les trois
// modules. Aucun des refus mesurés ici ne l'atteint — tous précèdent l'appel.
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
  headers: () => Promise.resolve(new Headers()),
}));

// La langue de la requête, celle que le fabricant du back-office interroge lui-même.
vi.mock('next-intl/server', () => nextIntlServerMobile());

import { logoutAction } from '@/app/(account)/[tenantSlug]/compte/actions';
import { unknownTenant } from '@/app/(admin)/[tenantSlug]/admin/action-result';
import { loadAvailabilityAction } from '@/app/(booking)/[tenantSlug]/reservation/actions';
import { unknownTenantRefusal } from '@/lib/tenant-refusal';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';

/** Une requête de créneaux que le schéma accepte — hors de cause dans ce refus. */
const REQUETE_VALABLE = {
  serviceId: '22222222-2222-4222-8222-222222222222',
  from: '2026-09-01',
  to: '2026-09-07',
};

const FABRIQUE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'lib',
  'tenant-refusal.ts',
);

afterEach(() => {
  vi.clearAllMocks();
  fixerLangue('fr');
});

describe('la fabrique partagée du refus d’établissement inconnu', () => {
  it.each([...LOCALES])('rend le code du contrat et sa phrase, en « %s »', (locale) => {
    expect(unknownTenantRefusal(locale)).toEqual({
      ok: false,
      code: ERROR_CODES.TENANT_NOT_FOUND,
      message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
    });
  });

  it('ne porte rien d’autre que le refus — ni `details`, ni clé de plus', () => {
    expect(Object.keys(unknownTenantRefusal('fr')).sort()).toEqual(['code', 'message', 'ok']);
  });

  it('tient sa langue de son paramètre, et jamais de la requête', () => {
    // La requête est en anglais, la fabrique appelée en français : c'est le paramètre
    // qui l'emporte, parce que rien ici ne va lire la requête.
    fixerLangue('en');

    expect(unknownTenantRefusal('fr').message).toBe(
      errorMessage(ERROR_CODES.TENANT_NOT_FOUND, 'fr'),
    );
  });

  it('ne connaît que le contrat partagé, ce qui est ce qui la garde synchrone', () => {
    // Ni ancré sur la fin de ligne — un retour chariot y suffirait à ne plus rien
    // voir —, ni sur une seule ligne : un import que le formateur aurait replié sur
    // trois lignes doit se compter comme les autres, faute de quoi ce garde cesse de
    // garder sans que rien ne le dise.
    const importes = [
      ...readFileSync(FABRIQUE, 'utf8').matchAll(/^import\b[\s\S]*?from '([^']+)';/gm),
    ];

    // Un import de `next-intl/server` la rendrait asynchrone et la chasserait de
    // `lib/` ; un import d'une surface y ferait descendre le type d'une autre.
    expect(importes.map((trouve) => trouve[1])).toEqual(['@spa/shared']);
  });
});

describe.each([...LOCALES])('les trois surfaces, en « %s »', (locale) => {
  it('rendent le même refus, du même code et de la même phrase', async () => {
    fixerLangue(locale);

    const backOffice = await unknownTenant();
    const espaceClient = await logoutAction(SLUG_ILLISIBLE);
    const tunnel = await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_VALABLE);

    const attendu = {
      ok: false,
      code: ERROR_CODES.TENANT_NOT_FOUND,
      message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
    };

    expect(backOffice).toEqual(attendu);
    expect(espaceClient).toEqual(attendu);
    expect(tunnel).toEqual(attendu);
  });

  it('n’ajoutent pas de `details`, pas même celle dont le type l’autorise', async () => {
    fixerLangue(locale);

    // `AdminActionFailure` a un `details` facultatif, et c'est la seule des trois à en
    // avoir un : si le champ devait se propager, c'est de là qu'il partirait.
    expect(Object.keys(await unknownTenant()).sort()).toEqual(['code', 'message', 'ok']);
    expect(Object.keys(await logoutAction(SLUG_ILLISIBLE)).sort()).toEqual([
      'code',
      'message',
      'ok',
    ]);
    expect(
      Object.keys(await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_VALABLE)).sort(),
    ).toEqual(['code', 'message', 'ok']);
  });
});
