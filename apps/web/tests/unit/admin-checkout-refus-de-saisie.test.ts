import { ERROR_CODES, LOCALES, type Locale, type SettleSaleRequest } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Chaque refus de saisie du comptoir nomme ce qu'il refuse — #1378.
 *
 * ## Ce que cette suite prouve, et que celle du panneau ne prouve pas
 *
 * `checkout-panel.test.tsx` double les actions : elle prouve que l'écran affiche
 * la phrase du geste, pas que l'action la **rende**. Or c'est l'action qui juge
 * les cibles, et c'est elle qui les confondait — trois `safeParse` dans un seul
 * `if`, sous « Rendez-vous inconnu. » Cette suite s'exerce donc sur les vraies
 * actions, comme `admin-action-etablissement-inconnu` le fait pour le code de
 * l'établissement.
 *
 * Aucun de ces refus n'atteint l'API : ils sont tous opposés avant l'appel, ce
 * qui est précisément ce qui les rendait indiscernables — même code, même
 * `details` absent. Ce ticket ne change ni l'un ni l'autre, et {@link attendre}
 * le vérifie sur chaque cas : il n'y a que la phrase qui se précise.
 *
 * ## Pourquoi la langue est mobile
 *
 * La phrase vient du catalogue `admin-checkout`, lu par `getTranslations` — donc
 * dans la langue de la requête. Une suite qui ne l'exercerait qu'en français
 * laisserait passer une clé absente du catalogue anglais, qui s'afficherait en
 * clair sous la forme `admin-checkout.failure.…`.
 */

const cookieStore = { get: vi.fn() };

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

vi.mock('next-intl/server', () => nextIntlServerMobile());

import type {
  AdminActionFailure,
  AdminActionResult,
} from '@/app/(admin)/[tenantSlug]/admin/action-result';
import {
  loadReceiptAction,
  openCheckoutTicketAction,
  settleTicketAction,
} from '@/app/(admin)/[tenantSlug]/admin/encaissement/actions';
import { checkoutWords } from '@/lib/admin/checkout-summary';

const SLUG = 'maison-lotus';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SERVICE_ID = 'cccccccc-0000-4000-8000-000000000001';
const SALE_ID = '99999999-0000-4000-8000-000000000009';
/** Ce qu'`uuidSchema` refuse — et la seule chose que ces cas font varier. */
const PAS_UN_UUID = 'pas-un-uuid';
/** Dans les bornes de l'API — 8 à 128 caractères — pour que seul le reste refuse. */
const CLE = 'cle-idempotence-1378';
/** Sous le plancher de huit caractères de l'API, et seul fautif de son cas. */
const CLE_TROP_COURTE = 'trop-co';
const CORPS = { method: 'CASH', amountMinor: 3500 } as const satisfies SettleSaleRequest;
/** Un corps que `settleSaleRequestSchema` refuse : ce moyen n'existe pas au comptoir. */
const CORPS_ILLISIBLE = { method: 'CHEQUE', amountMinor: 3500 } as unknown as SettleSaleRequest;

afterEach(() => {
  vi.clearAllMocks();
  fixerLangue('fr');
});

/**
 * Le refus rendu — et l'échec du test si l'action a abouti.
 *
 * Aucun de ces appels ne peut aboutir : leur cible est illisible par
 * construction. Le dire ici plutôt que dans chaque cas évite autant de
 * transtypages, et fait échouer bruyamment une action qui cesserait de refuser.
 */
async function refusDe(appel: Promise<AdminActionResult<unknown>>): Promise<AdminActionFailure> {
  const result = await appel;

  if (result.ok) {
    throw new Error('l’action a abouti là où elle devait refuser');
  }

  return result;
}

describe.each([...LOCALES])('les refus de saisie du comptoir, en « %s »', (locale: Locale) => {
  /**
   * Les phrases de refus du comptoir dans cette langue, telles que le catalogue
   * les écrit.
   *
   * `checkoutWords` plutôt qu'un littéral : une phrase recopiée dans une suite
   * cesse d'être celle du produit au premier mot qu'on y corrige.
   */
  const mots = checkoutWords(locale).failure;

  /**
   * Ce que chacun de ces refus a en commun, et que #1378 ne touche pas : le code
   * du refus de saisie du geste, et l'absence de `details` par laquelle les
   * quatre écrans reconnaissent « le refus que l'action a opposé elle-même »
   * (#1367, #1369, troisième critère de #1378).
   */
  function attendre(refus: AdminActionFailure, phrase: string): void {
    expect(refus.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(refus.details).toBeUndefined();
    expect(refus.message).toBe(phrase);
  }

  it('nomme le rendez-vous quand c’est lui qu’on ne sait pas lire', async () => {
    fixerLangue(locale);

    attendre(
      await refusDe(openCheckoutTicketAction(SLUG, PAS_UN_UUID, SERVICE_ID)),
      mots.unknownTarget,
    );
  });

  it('nomme la prestation quand c’est elle, et non plus le rendez-vous', async () => {
    fixerLangue(locale);

    const refus = await refusDe(openCheckoutTicketAction(SLUG, APPOINTMENT_ID, PAS_UN_UUID));

    attendre(refus, mots.unknownServiceTarget);
    expect(refus.message).not.toBe(mots.unknownTarget);
  });

  it('nomme le ticket de caisse que le règlement visait', async () => {
    fixerLangue(locale);

    attendre(
      await refusDe(settleTicketAction(SLUG, PAS_UN_UUID, CORPS, CLE)),
      mots.unknownSaleTarget,
    );
  });

  it('nomme le règlement quand c’est le corps qui est illisible', async () => {
    fixerLangue(locale);

    attendre(
      await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS_ILLISIBLE, CLE)),
      mots.unreadableSettlement,
    );
  });

  it('nomme la panne d’écran quand c’est la clé du geste qui est hors bornes', async () => {
    fixerLangue(locale);

    // Personne ne saisit cette clé — l'écran l'engendre au montage (#835) —,
    // d'où une phrase qui ne demande rien à corriger à la main.
    attendre(
      await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS, CLE_TROP_COURTE)),
      mots.unusableGestureKey,
    );
  });

  /**
   * `loadReceiptAction` n'a pas été reprise, et c'est ce cas qui l'établit —
   * deuxième critère de #1378. Elle ne juge qu'une chose après l'établissement,
   * et sa phrase nomme déjà le ticket : il n'y avait aucune cause à séparer.
   */
  it('nomme le ticket dont la pièce est demandée, comme avant', async () => {
    fixerLangue(locale);

    attendre(
      await refusDe(loadReceiptAction(SLUG, PAS_UN_UUID)),
      mots.unknownReceiptTarget,
    );
  });

  /**
   * Le premier critère, pris par son autre bout : l'écriture du règlement ne
   * reçoit **aucun** identifiant de rendez-vous, et aucun de ses trois refus ne
   * doit donc en nommer un. C'est cette assertion-là qu'un retour en arrière
   * ferait rougir, quelle que soit la phrase choisie pour la remplacer.
   */
  it('ne nomme aucun rendez-vous dans les trois refus du règlement', async () => {
    fixerLangue(locale);
    const rendezVous = locale === 'fr' ? /rendez-vous/i : /appointment/i;

    for (const refus of [
      await refusDe(settleTicketAction(SLUG, PAS_UN_UUID, CORPS, CLE)),
      await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS_ILLISIBLE, CLE)),
      await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS, CLE_TROP_COURTE)),
    ]) {
      expect(refus.message, `« ${refus.message} » nomme un rendez-vous`).not.toMatch(rendezVous);
    }
  });

  it('dit trois phrases distinctes pour les trois causes', async () => {
    fixerLangue(locale);

    const dites = new Set([
      (await refusDe(settleTicketAction(SLUG, PAS_UN_UUID, CORPS, CLE))).message,
      (await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS_ILLISIBLE, CLE))).message,
      (await refusDe(settleTicketAction(SLUG, SALE_ID, CORPS, CLE_TROP_COURTE))).message,
    ]);

    expect(dites.size).toBe(3);
  });
});
