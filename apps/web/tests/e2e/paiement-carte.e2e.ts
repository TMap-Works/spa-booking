/**
 * L'encaissement par carte au comptoir — quatrième critère de #80.
 *
 * ## Deux choses très différentes, dans un seul fichier
 *
 * 1. **La garde**, qui s'exécute toujours : cet environnement ne doit porter
 *    aucune clé Stripe live. Elle ne dépend d'aucune configuration et ne se
 *    saute jamais — c'est le seul test de ce dépôt dont l'absence de
 *    configuration ne diminue pas la portée.
 * 2. **La scène carte**, qui exige des clés de test. Sans elles, elle se saute
 *    en disant pourquoi ; avec des clés live, elle ne se saute pas : la garde a
 *    déjà arrêté la suite.
 *
 * ## Pourquoi le parcours critique, lui, encaisse en espèces
 *
 * Parce qu'il doit être vert partout, tout le temps, sans secret de dépôt.
 * `payments-stripe` §4 le permet sans rien concéder : le règlement en espèces
 * est un encaissement de plein droit du POS, et il n'appelle aucun prestataire —
 * ce que `parcours-critique.e2e.ts` vérifie en propre. Faire dépendre la boucle
 * de valeur du MVP d'une clé de test tierce reviendrait à la rendre rouge le
 * jour où cette clé tourne, pour une raison qui n'est pas un défaut du produit.
 *
 * La scène carte couvre ce que les espèces ne peuvent pas couvrir : que la
 * frontière PCI tient — champs servis par Stripe, clé publiable venue de l'API,
 * numéro jamais saisi dans notre DOM (`payments-stripe` §1).
 */

import { changerStatut, connecter, poserRendezVous } from './support/api';
import { BASE_API, COMPTES, SLUG, chemins } from './support/environnement';
import { compteClient } from './support/jeu-dessai';
import { connexionComptoir, expect, jourDuScenario, test } from './support/scene';
import {
  CARTES_DE_TEST,
  CVC_DE_TEST,
  EXPIRATION_DE_TEST,
  assertAucuneCleLiveEnVol,
  inspecterStripe,
  motifDeSaut,
  refuserCleLive,
} from './support/stripe-garde';

const diagnostic = inspecterStripe(process.env);
const motif = motifDeSaut(diagnostic);

test.describe('Frontière Stripe', () => {
  test("aucune clé Stripe live n'est posée dans cet environnement", () => {
    // Volontairement sans `skip` : une suite qui encaisse et qui ne saurait pas
    // dire dans quel monde elle tourne est une suite dangereuse. Ce test est le
    // seul de la suite qui n'a besoin de rien pour être utile.
    refuserCleLive(diagnostic);
  });
});

test.describe('Encaissement par carte', () => {
  test.skip(motif !== null, motif ?? '');

  // L'iframe de Stripe se monte à travers le réseau public : une tentative
  // supplémentaire absorbe une lenteur passagère du prestataire sans rendre le
  // verdict complaisant.
  test.describe.configure({ retries: 2 });

  test("la clé publiable rendue par l'API est en mode test", async ({ request, jeu }) => {
    const jeton = await connecter(request, COMPTES.staff);
    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jourDuScenario(4),
    });

    const reponse = await request.post(`${BASE_API}/public/${SLUG}/payments/intents`, {
      data: { appointmentId: rendezVous.id },
    });
    expect(
      reponse.status(),
      "L'intention de paiement n'a pas été créée : vérifier STRIPE_SECRET_KEY.",
    ).toBe(201);

    const corps = (await reponse.json()) as {
      readonly publishableKey?: string;
      readonly clientSecret?: string;
    };

    // La clé publiable est la seule valeur Stripe qui a le droit d'atteindre le
    // navigateur (`payments-stripe` §7) — et elle doit être de test.
    expect(corps.publishableKey ?? '').toMatch(/^pk_test_/);
    expect(corps.clientSecret ?? '').not.toBe('');
  });

  test('le comptoir règle avec une carte de test Stripe', async ({
    page,
    request,
    jeu,
    traficReseau,
  }) => {
    const jour = jourDuScenario(5);
    const jeton = await connecter(request, COMPTES.staff);
    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    await changerStatut(request, jeton, rendezVous.id, 'confirmed');

    await connexionComptoir(page, COMPTES.staff);

    await test.step('Choisir le règlement par carte', async () => {
      await page.goto(chemins.encaissement(jour, rendezVous.id));
      await page.locator('#moyen-card').check({ force: true });
      await page.getByRole('button', { name: /^Payer .* par carte/ }).click();
    });

    const champsStripe = await test.step('Stripe monte ses propres champs', async () => {
      const hote = page.getByTestId('stripe-payment-element');
      await expect(hote).toBeVisible({ timeout: 30_000 });

      // L'iframe est la frontière PCI elle-même : le numéro se saisit chez
      // Stripe, jamais dans notre DOM (`payments-stripe` §1). Qu'elle existe est
      // donc une assertion de conformité, pas un détail d'implémentation.
      const cadre = hote.frameLocator('iframe').first();
      await expect(hote.locator('iframe').first()).toBeAttached({ timeout: 30_000 });
      return cadre;
    });

    await test.step('Saisir la carte de test 4242', async () => {
      // Les libellés de Stripe suivent la langue du navigateur : le contexte est
      // fixé en `fr-FR` par `playwright.config.ts`, et l'anglais reste accepté
      // en repli le jour où Stripe change ses traductions.
      const numero = champsStripe.getByRole('textbox', {
        name: /Num[ée]ro de carte|Card number/i,
      });
      await expect(numero).toBeVisible({ timeout: 30_000 });
      await numero.fill(CARTES_DE_TEST.succes);

      await champsStripe
        .getByRole('textbox', { name: /Date d.expiration|Expiration|MM ?\/ ?YY|Expiry/i })
        .fill(EXPIRATION_DE_TEST);
      await champsStripe.getByRole('textbox', { name: /CVC|CVV|Code de s[ée]curit[ée]/i }).fill(CVC_DE_TEST);
    });

    await test.step('Le prestataire accepte le règlement', async () => {
      await page.getByRole('button', { name: /^Encaisser .* par carte/ }).click();

      // Reçu **provisoire** : la capture ne vaut qu'à l'arrivée du webhook
      // signé (`payments-stripe` §2, point 4). L'écran le dit, et c'est cette
      // formulation-là qui doit tenir — un reçu qui affirmerait la capture
      // serait un reçu qui ment.
      await expect(page.getByRole('heading', { name: 'Reçu' })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText('Paiement accepté par le prestataire')).toBeVisible();
    });

    await test.step("Rien n'est parti vers l'environnement live", async () => {
      assertAucuneCleLiveEnVol(traficReseau);
    });
  });
});
