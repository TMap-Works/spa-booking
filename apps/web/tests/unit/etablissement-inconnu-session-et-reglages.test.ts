import { ERROR_CODES, LOCALES, errorMessage } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Les deux derniers modules d'actions nomment l'établissement qu'ils ne savent
 * pas lire — #1379, fin de la classe ouverte par #1372 et poursuivie par #1375.
 *
 * ## Ce que cette suite prouve
 *
 * Les six sites qui jugeaient le slug de l'URL sous `VALIDATION_ERROR` rendent
 * `TENANT_NOT_FOUND`. Elle s'exerce sur les **vraies** actions, sans aucun double
 * de leur logique : une suite qui tendrait aux écrans un refus qu'aucune action ne
 * produit resterait verte sur un produit resté fautif.
 * `etablissement-inconnu-session-et-reglages-ecrans.test.tsx` fait l'autre moitié —
 * l'écran qui reçoit ce refus le **nomme**, dans la langue de son rendu.
 *
 * ## Deux refus par site, sauf là où il n'y en a qu'un
 *
 * L'établissement illisible rend `TENANT_NOT_FOUND`, **et** le refus de saisie que
 * la même action oppose d'elle-même garde `VALIDATION_ERROR`. Le premier seul
 * laisserait passer une action qui aurait remplacé un refus par l'autre ; le second
 * seul, une action qui ne les aurait jamais séparés — c'est précisément ce que
 * faisaient quatre de ces six `if`.
 *
 * `adminLogoutAction` est la seule sans second cas : elle n'a pas de charge utile,
 * le slug est sa seule entrée.
 *
 * ## Le cas tranché par ce ticket
 *
 * `adminAcceptInvitationAction` jugeait les deux d'un même `if`, et c'était le seul
 * emploi de l'`undefined` d'`invalidFromZod`. Les deux cas sont exigés ici avec une
 * charge utile **valable** pour le premier et un slug **lisible** pour le second :
 * l'ordre choisi — l'établissement d'abord — ne se mesure pas autrement. La suite
 * `server-validation-i18n.test.ts` le garde aussi, côté langue du refus.
 *
 * ## Pourquoi le jeton d'accès est posé
 *
 * Aucun des refus mesurés ici n'atteint `adminActionAccess` — tous précèdent
 * l'ouverture de la session. Le cookie doublé ne prouve donc rien par lui-même ; il
 * évite qu'un refus de session vienne s'interposer le jour où l'un de ces sites
 * changerait d'ordre, ce qui ferait tomber le test sur le bon motif plutôt que de
 * le faire passer pour une autre raison.
 */

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// La langue des actions serveur se lit sur la requête, par `next-intl/server` :
// c'est elle que `unknownTenant()` interroge pour écrire son `message`.
vi.mock('next-intl/server', () => nextIntlServerMobile());

import {
  adminAcceptInvitationAction,
  adminLoginAction,
  adminLogoutAction,
  openBillingPortalAction,
  startBillingCheckoutAction,
  updateTenantSettingsAction,
} from '@/app/(admin)/[tenantSlug]/admin/actions';
import { saveMemberLocaleAction } from '@/app/(admin)/[tenantSlug]/admin/reglages/actions';
import { isSessionExpired } from '@/lib/session-renewal';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';
const SLUG = 'maison-lotus';

/** Des identifiants que `loginRequestSchema` accepte — la charge utile est hors de cause. */
const IDENTIFIANTS = { email: 'claire@maison-lotus.test', password: 'mot-de-passe-solide' };

/** Une acceptation d'invitation que le schéma accepte : mot de passe au-delà du minimum. */
const INVITATION = { token: 'jeton-de-test', password: 'mot-de-passe-de-test' };

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

/** Les refus de ces six sites ne portent pas de `details` : ils précèdent l'API. */
function detailsDe(
  result: { readonly ok: boolean } & Partial<{ readonly details?: unknown }>,
): unknown {
  return result.ok ? 'aboutie' : result.details;
}

describe('l’établissement illisible a son propre code, sur les six derniers sites', () => {
  it('la connexion au back-office le rend, identifiants valables', async () => {
    const refus = await adminLoginAction(SLUG_ILLISIBLE, IDENTIFIANTS);

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    // Aucun `details` : c'est le refus de l'action, et c'est ce qui le distingue
    // d'un refus rapporté du corps d'erreur de l'API.
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('l’acceptation d’invitation le rend, charge utile valable — le cas tranché par ce ticket', async () => {
    const refus = await adminAcceptInvitationAction(SLUG_ILLISIBLE, INVITATION);

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('la déconnexion le rend, et ne révoque rien au passage', async () => {
    const refus = await adminLogoutAction(SLUG_ILLISIBLE);

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    // Le refus précède la lecture du jeton de rafraîchissement : un slug illisible
    // ne doit pas faire effacer les cookies d'une session par ailleurs valable.
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it('les réglages de l’établissement le rendent, charge utile valable', async () => {
    const refus = await updateTenantSettingsAction(SLUG_ILLISIBLE, { name: 'Maison Lotus' });

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(detailsDe(refus)).toBeUndefined();
  });

  it('les deux ouvertures de page Stripe le rendent, langue valable', async () => {
    expect(codeDe(await startBillingCheckoutAction(SLUG_ILLISIBLE, 'fr'))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
    expect(codeDe(await openBillingPortalAction(SLUG_ILLISIBLE, 'fr'))).toBe(
      ERROR_CODES.TENANT_NOT_FOUND,
    );
  });

  it('la langue du compte connecté le rend, choix valable', async () => {
    const refus = await saveMemberLocaleAction(SLUG_ILLISIBLE, 'en');

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(detailsDe(refus)).toBeUndefined();
  });
});

describe('le refus de saisie de la même action garde `VALIDATION_ERROR`', () => {
  it('les identifiants absents de la connexion', async () => {
    expect(codeDe(await adminLoginAction(SLUG, {}))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('le mot de passe trop court de l’invitation', async () => {
    expect(
      codeDe(await adminAcceptInvitationAction(SLUG, { token: 'jeton-de-test', password: 'court' })),
    ).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('l’adresse de contact mal formée des réglages', async () => {
    expect(codeDe(await updateTenantSettingsAction(SLUG, { contactEmail: 'pas-une-adresse' }))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
  });

  it('la langue hors contrat des deux ouvertures de page Stripe', async () => {
    expect(codeDe(await startBillingCheckoutAction(SLUG, 'kl'))).toBe(
      ERROR_CODES.VALIDATION_ERROR,
    );
    expect(codeDe(await openBillingPortalAction(SLUG, 'kl'))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('le choix de langue hors contrat du compte connecté', async () => {
    expect(codeDe(await saveMemberLocaleAction(SLUG, 'kl'))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

/**
 * Le `message` du refus suit la langue de la requête.
 *
 * Les écrans ne l'affichent plus — ils gardent le code et réécrivent la phrase à
 * chaque rendu (#1354) —, mais il reste ce que le contrat d'une action promet, et
 * un appelant qui n'aurait que le résultat doit y trouver une phrase déjà dans sa
 * langue. Les deux modules sont mesurés : rien ne dirait que l'un des deux a cessé
 * de consulter la table du contrat.
 */
describe.each([...LOCALES])('le message du refus, en « %s »', (locale) => {
  it('est la phrase du contrat, dans les deux modules', async () => {
    fixerLangue(locale);

    const session = await adminLoginAction(SLUG_ILLISIBLE, IDENTIFIANTS);
    const reglages = await saveMemberLocaleAction(SLUG_ILLISIBLE, 'en');
    const attendue = errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);

    expect(session.ok ? null : session.message).toBe(attendue);
    expect(reglages.ok ? null : reglages.message).toBe(attendue);
    // La garde qui rend l'égalité non vide : ce n'est pas la tournure du refus de
    // saisie, qui est ce que ces deux modules disaient avant ce ticket.
    expect(attendue).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });
});

/**
 * Le chemin de renouvellement de session, vérifié plutôt que supposé — troisième
 * critère de #1379.
 *
 * Deux des écrans concernés sont ceux de la session, et leur refus passe par
 * `useAdminSessionRenewal` avant d'être affiché : un code nouveau ne doit pas faire
 * passer un refus d'établissement pour un refus de session, ni l'inverse. Ce qui en
 * décide est `isSessionExpired`, et lui seul — le crochet n'en est que l'habillage
 * React. C'est donc lui qu'on mesure, avec les deux codes que ces actions opposent
 * désormais, plus celui que l'API rapporte.
 *
 * Le second cas est la moitié qu'on oublie : il exige que le refus de session
 * **reste** reconnu. Le premier seul resterait vert sur un `isSessionExpired` qui
 * rendrait `false` partout, c'est-à-dire sur un back-office qui ne renouvellerait
 * plus jamais rien.
 */
describe('le refus d’établissement et le refus de session ne se confondent pas', () => {
  it('l’établissement inconnu ne part pas vers le renouvellement', async () => {
    const refus = await adminLoginAction(SLUG_ILLISIBLE, IDENTIFIANTS);

    expect(refus.ok).toBe(false);
    expect(isSessionExpired({ code: codeDe(refus) })).toBe(false);
  });

  it('le refus de session, lui, y part toujours', () => {
    expect(isSessionExpired({ code: ERROR_CODES.UNAUTHORIZED })).toBe(true);
  });

  it('et le refus de saisie n’y part pas davantage', async () => {
    expect(isSessionExpired({ code: codeDe(await adminLoginAction(SLUG, {})) })).toBe(false);
  });
});
