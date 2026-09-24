/**
 * Le règlement au comptoir — huitième critère de #835, ADR 0015.
 *
 * ## Ce que ce fichier remplace, et pourquoi
 *
 * `paiement-carte.e2e.ts` montait le formulaire de carte de Stripe dans la page
 * du back-office et y saisissait la carte de test 4242. Ce parcours n'existe
 * plus : au comptoir, la carte se règle sur le **TPE autonome** de la banque du
 * salon, l'application ne lui parle pas, et elle n'enregistre que l'issue que le
 * caissier déclare. Il n'y a donc plus ni iframe à attendre, ni clé de test à
 * poser — et plus aucune raison de sauter la suite quand elle manque.
 *
 * ## Les deux choses que ce fichier prouve
 *
 * 1. **La frontière PCI**, qui ne dépend plus d'aucune configuration : aucun
 *    champ de carte dans la page, et aucune requête vers un prestataire de
 *    paiement pendant tout le parcours d'encaissement. C'est la contrepartie
 *    exacte de ce que l'ancienne suite prouvait à l'envers.
 * 2. **Le règlement mixte** : un ticket de 78,00 € réglé par 50,00 € d'espèces
 *    puis 28,00 € au terminal, et un ticket imprimé qui porte les deux
 *    règlements. Le prix de la prestation du jeu d'essai est calé sur ce
 *    scénario (`fixtures/seed.mjs`), et l'établissement n'a pas de taux de taxe :
 *    le total du ticket est ce prix.
 *
 * Aucune des deux ne demande de secret de dépôt. C'est ce qui permet à cette
 * suite d'être verte partout, tout le temps — là où la précédente se sautait
 * d'elle-même faute de clés, c'est-à-dire presque toujours.
 */

import { changerStatut, connecter, poserRendezVous } from './support/api';
import { COMPTES, chemins } from './support/environnement';
import { compteClient } from './support/jeu-dessai';
import { connexionComptoir, expect, jourDuScenario, test } from './support/scene';
import {
  assertAucunAppelStripe,
  inspecterStripe,
  refuserCleLive,
} from './support/stripe-garde';

test.describe('Frontière Stripe', () => {
  test("aucune clé Stripe live n'est posée dans cet environnement", () => {
    // Volontairement sans `skip` : une suite qui encaisse et qui ne saurait pas
    // dire dans quel monde elle tourne est une suite dangereuse. Ce test est le
    // seul de la suite qui n'a besoin de rien pour être utile — et il survit à
    // la disparition du formulaire de carte, parce que le module Stripe reste en
    // place pour un éventuel paiement **en ligne** (ADR 0015, décision 3).
    refuserCleLive(inspecterStripe(process.env));
  });
});

test.describe('Encaissement au comptoir', () => {
  test('règle un ticket de 78,00 € en deux fois : espèces puis TPE', async ({
    page,
    request,
    jeu,
    traficReseau,
  }) => {
    const jour = jourDuScenario(4);
    const jeton = await connecter(request, COMPTES.manager);
    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    await changerStatut(request, jeton, rendezVous.id, 'confirmed');

    await connexionComptoir(page, COMPTES.manager);

    await test.step('Le comptoir offre deux moyens, et aucun champ de carte', async () => {
      await page.goto(chemins.encaissement(jour, rendezVous.id));

      await expect(page.getByRole('heading', { name: 'Encaissement' })).toBeVisible();
      await expect(page.getByRole('radio', { name: /Espèces/ })).toHaveCount(1);
      await expect(page.getByRole('radio', { name: /Carte bancaire \(TPE\)/ })).toHaveCount(1);

      // Sixième critère : la mention qui promettait des champs servis par Stripe
      // a disparu avec eux.
      await expect(page.getByText(/Stripe/i)).toHaveCount(0);
    });

    await test.step('Une première part de 50,00 € en espèces', async () => {
      // Les boutons radio du moyen de paiement sont `spa-visually-hidden` : ils
      // se cochent de force, comme le ferait le clic sur leur étiquette.
      await page.locator('#moyen-cash').check({ force: true });
      await page.getByLabel('Régler une partie').check();
      await page.getByLabel('Montant de ce règlement').fill('50,00');
      await page.getByRole('button', { name: /^Encaisser .* en espèces/ }).click();

      // Le reste dû est celui que le serveur a recalculé sous verrou — l'écran
      // l'affiche, il ne le compose pas.
      await expect(page.getByText('Reste dû')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Règlements enregistrés')).toBeVisible();
    });

    await test.step('Le solde de 28,00 € sur le terminal du salon', async () => {
      await page.locator('#moyen-card').check({ force: true });
      await page.getByRole('button', { name: /^Régler .* au TPE/ }).click();

      // Le montant à recopier sur le terminal est annoncé en grand : c'est le
      // deuxième critère, et c'est le chiffre que l'opérateur lit à voix haute.
      await expect(page.getByText('Saisissez ce montant sur le TPE')).toBeVisible();
      await expect(page.locator('.spa-admin-checkout__callout-amount')).toContainText('28');

      // La référence est facultative ; celle-ci est un numéro d'opération, pas
      // une donnée de carte — 32 caractères alphanumériques au plus, et l'API
      // refuse en 400 tout ce qui vérifierait la clé de Luhn.
      await page.getByLabel('N° de ticket TPE').fill('TPE7788A');
      await page.getByRole('button', { name: 'Paiement accepté sur le TPE' }).click();
    });

    await test.step('Le ticket imprimé porte les deux règlements', async () => {
      await expect(page.getByRole('heading', { name: 'Ticket de caisse' })).toBeVisible({
        timeout: 20_000,
      });

      const ticket = page.getByRole('article', { name: /^Ticket n° / });
      await expect(ticket).toBeVisible({ timeout: 20_000 });

      // Quatrième critère, dernier point : « le ticket les liste tous ». Les
      // deux lignes viennent de la pièce que l'API compose — le front n'en
      // fabrique aucune.
      await expect(ticket).toContainText('50,00');
      await expect(ticket).toContainText('28,00');
    });

    await test.step("Aucun prestataire de paiement n'a été appelé", async () => {
      // La contre-épreuve, côté navigateur, de ce qu'affirment l'ADR 0015 et
      // `payments-stripe` §4 : ni les espèces ni le TPE ne touchent un tiers.
      // L'ancienne suite prouvait l'inverse — qu'une iframe de `js.stripe.com`
      // se montait bien dans cette page.
      assertAucunAppelStripe(traficReseau, 'Règlement mixte au comptoir');
    });
  });

  test('un paiement refusé sur le terminal n’enregistre rien', async ({ page, request, jeu }) => {
    const jour = jourDuScenario(5);
    const jeton = await connecter(request, COMPTES.manager);
    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    await changerStatut(request, jeton, rendezVous.id, 'confirmed');

    await connexionComptoir(page, COMPTES.manager);
    await page.goto(chemins.encaissement(jour, rendezVous.id));

    await page.locator('#moyen-card').check({ force: true });
    await page.getByRole('button', { name: /^Régler .* au TPE/ }).click();
    await page.getByRole('button', { name: 'Paiement refusé' }).click();

    // Retour au choix du moyen, et rien d'inscrit : la cliente paie autrement.
    await expect(page.getByRole('radio', { name: /Espèces/ })).toHaveCount(1);
    await expect(page.getByText(/refusé sur le terminal/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ticket de caisse' })).toHaveCount(0);
  });
});
