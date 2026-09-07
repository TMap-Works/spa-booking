/**
 * Le parcours critique — `réserver → confirmer → encaisser`.
 *
 * C'est la boucle de valeur du MVP (CLAUDE.md), celle dont le CDC dit qu'elle ne
 * doit jamais casser. Un seul test, volontairement long : découpé en trois, il
 * exigerait de reconstituer l'état entre chacun, et le lien de cause à effet —
 * ce que la réservation produit, ce que l'encaissement consomme — cesserait
 * d'être éprouvé.
 *
 * Les trois maillons sont trois `test.step` de premier niveau. C'est ce
 * découpage que le rapport d'échec restitue : quand cette suite rougit, la
 * première ligne du journal dit lequel des trois a cédé.
 */

import {
  changerStatut,
  connecter,
  trouverRendezVous,
} from './support/api';
import { CLIENTE, COMPTES, chemins, dateDuSalon, heureDuSalon } from './support/environnement';
import { assertAucunAppelStripe } from './support/stripe-garde';
import {
  blocRendezVous,
  connexionComptoir,
  expect,
  reserverParLeTunnel,
  test,
} from './support/scene';

test.describe('Parcours critique', () => {
  test('réserver, confirmer, puis encaisser en espèces', async ({ page, request, traficReseau }) => {
    let identifiant = '';
    let dateSalon = '';
    let heureSalon = '';

    await test.step('Réserver — le tunnel client, du premier au dernier écran', async () => {
      ({ identifiant } = await reserverParLeTunnel(page));
    });

    const jetonComptoir = await connecter(request, COMPTES.staff);

    await test.step('Confirmer — le salon accepte le rendez-vous', async () => {
      const avant = await trouverRendezVous(request, jetonComptoir, identifiant);
      expect(
        avant.status.toLowerCase(),
        'Un rendez-vous pris en ligne naît « en attente » : ' +
          'la confirmation est un geste du salon, pas un effet de bord de la réservation.',
      ).toBe('pending');

      dateSalon = dateDuSalon(new Date(avant.startsAt));
      heureSalon = heureDuSalon(new Date(avant.startsAt));

      // Passage par la route et non par le tiroir : `DESK_STATUS_LABELS`
      // n'expose que « Marquer honoré » et « Marquer non présenté », si bien
      // qu'un rendez-vous en attente n'affiche aucun bouton de statut. Le manque
      // est côté IHM, la route est servie — voir support/api.ts.
      const apres = await changerStatut(request, jetonComptoir, identifiant, 'confirmed');
      expect(apres.status.toLowerCase()).toBe('confirmed');
    });

    await test.step('Confirmer — le comptoir voit le rendez-vous confirmé', async () => {
      await connexionComptoir(page, COMPTES.staff);
      await page.goto(chemins.calendrier(dateSalon));

      // Le bloc est désigné par son **heure**, et non pris au premier venu.
      // Une reprise de `retries` rejoue le tunnel : la tentative précédente a
      // laissé sa propre réservation, au nom de la même cliente et le plus
      // souvent le même jour. Un `.first()` serait alors tombé sur elle — en
      // attente, faute d'avoir été confirmée — et l'assertion aurait accusé le
      // planning de ne pas voir une confirmation qui, elle, avait bien eu lieu.
      // En vue jour, le libellé du bloc est « HH:MM – HH:MM » : le tiret est ce
      // qui distingue une heure de début de l'heure de fin d'un voisin.
      const bloc = blocRendezVous(page, CLIENTE.nom).filter({ hasText: `${heureSalon} –` });
      await expect(bloc).toHaveCount(1, { timeout: 20_000 });
      await expect(bloc).toHaveAccessibleName(/Statut : confirmé/);
    });

    await test.step('Encaisser — régler la prestation en espèces au comptoir', async () => {
      await page.goto(chemins.encaissement(dateSalon, identifiant));

      await expect(page.getByRole('heading', { name: 'Encaissement' })).toBeVisible();
      await expect(page.getByText(`${CLIENTE.prenom} ${CLIENTE.nom}`).first()).toBeVisible();

      // Les boutons radio du moyen de paiement sont `spa-visually-hidden` : ils
      // se cochent de force, comme le ferait le clic sur leur étiquette.
      await page.locator('#moyen-cash').check({ force: true });

      // Le libellé porte le montant formaté : la borne de départ suffit à le
      // désigner sans dépendre du rendu de la monnaie.
      await page.getByRole('button', { name: /^Encaisser .* en espèces/ }).click();

      await expect(page.getByRole('heading', { name: 'Reçu' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/^Encaissement enregistré/)).toBeVisible();
    });

    await test.step('Encaisser — aucun appel au prestataire sur le chemin espèces', async () => {
      // La contre-épreuve, côté navigateur, de ce qu'affirment `payments-stripe`
      // §4 et `counter-payments.controller.ts` : le règlement en espèces ne
      // touche aucun prestataire. Le test unitaire de l'API le montre par
      // l'absence de la passerelle dans les dépendances du service ; ceci le
      // montre par l'absence de requête.
      assertAucunAppelStripe(traficReseau, 'Règlement en espèces');
    });
  });

  test("la console du parcours ne porte aucune erreur", async ({ page }) => {
    const erreurs: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        erreurs.push(message.text());
      }
    });
    page.on('pageerror', (erreur) => erreurs.push(erreur.message));

    await reserverParLeTunnel(page);

    // Le 404 de `favicon.ico` est le seul bruit toléré — il ne vient d'aucun
    // composant et n'a pas de correctif dans le périmètre du MVP.
    const fautives = erreurs.filter((message) => !message.includes('favicon.ico'));
    expect(fautives, `Erreurs de console pendant la réservation :\n${fautives.join('\n')}`).toEqual(
      [],
    );
  });
});
