/**
 * Le parcours public dans les deux langues — #846, huitième et quatrième
 * critères d'acceptation.
 *
 * ## Ce que cette suite ajoute au parcours critique
 *
 * `parcours-critique.e2e.ts` traverse `réserver → confirmer → encaisser` en
 * **français** : c'est la langue du projet Playwright par défaut
 * (`playwright.config.ts`, `locale: 'fr-FR'`). Il n'y a donc aucune raison de le
 * rejouer ici. Ce qui manquait est ailleurs, et tient en deux propriétés :
 *
 * 1. *« Le test E2E "réserver → confirmer" passe en `fr` et en `en` »* — le même
 *    scénario, servi à un navigateur qui annonce l'anglais. Il n'y a qu'un jeu
 *    de gestes (`support/scene.ts`), désigné par clés de catalogue depuis #846 :
 *    ce qui est éprouvé ici est donc bien le **produit** en anglais, et non un
 *    second scénario qui pourrait diverger du premier.
 * 2. *« Changer de langue au milieu du tunnel conserve la prestation, le
 *    praticien et le créneau déjà choisis »* — la seule de ces exigences qu'un
 *    test unitaire ne peut pas tenir : elle met en jeu une action serveur, le
 *    rejeu de la route par Next, `sessionStorage` et l'adresse du navigateur.
 *
 * ## `test.use({ locale })` plutôt qu'un second projet Playwright
 *
 * La langue se résout sur `Accept-Language` (`i18n/resolve.ts`, étape 3), que
 * Playwright dérive de `locale`. Le poser au niveau du fichier suffit, et
 * `playwright.config.ts` — qui fixe le fuseau, les serveurs et les délais —
 * reste inchangé : un projet de plus aurait rejoué **toutes** les suites dans
 * les deux langues, dont le back-office, qui n'est pas encore traduit.
 *
 * Le fuseau, lui, reste celui du salon : la langue ne le touche pas, et c'est
 * précisément ce que le ticket demande de vérifier.
 */

import { connecter, trouverRendezVous } from './support/api';
import { COMPTES, chemins } from './support/environnement';
import { debuteParLibelle, libelle } from './support/libelles';
import { expect, reserverParLeTunnel, test } from './support/scene';

test.describe('Le parcours public servi en anglais', () => {
  // `en-US` et non `en` : c'est la forme qu'envoie un navigateur réel, et elle
  // éprouve au passage que la négociation retient bien la **langue** d'une
  // étiquette régionale (`negotiateLocale`).
  test.use({ locale: 'en-US' });

  test('réserver puis confirmer, sans une ligne de français', async ({ page, request }) => {
    await page.goto(chemins.salon());

    // La langue du document avant toute autre chose : si elle n'est pas celle
    // attendue, tout ce qui suit échouerait sur des libellés introuvables, et
    // le rapport accuserait un bouton absent plutôt qu'une langue mal résolue.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const { identifiant } = await reserverParLeTunnel(page, 'en');

    // Et le rendez-vous existe vraiment, du côté du salon : la confirmation
    // n'est pas qu'un écran. Il naît « en attente » — la confirmation est un
    // geste du salon (`parcours-critique.e2e.ts`), et le back-office n'étant pas
    // encore traduit, c'est l'API qui en fait foi ici.
    const jetonComptoir = await connecter(request, COMPTES.manager);
    const rendezVous = await trouverRendezVous(request, jetonComptoir, identifiant);

    expect(rendezVous.status.toLowerCase()).toBe('pending');
  });

  test('la console du parcours anglais ne porte aucune erreur', async ({ page }) => {
    const erreurs: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        erreurs.push(message.text());
      }
    });
    page.on('pageerror', (erreur) => erreurs.push(erreur.message));

    await reserverParLeTunnel(page, 'en');

    const fautives = erreurs.filter((message) => !message.includes('favicon.ico'));
    expect(
      fautives,
      `Erreurs de console pendant la réservation en anglais :\n${fautives.join('\n')}`,
    ).toEqual([]);
  });
});

test.describe('Changer de langue au milieu du tunnel', () => {
  test('garde la prestation, le praticien et le créneau déjà choisis', async ({ page }) => {
    await page.goto(chemins.reservation());

    // Étape 1 — la première prestation, praticien laissé à « premier
    // disponible ». Par rang et non par libellé : le nom accessible d'une ligne
    // porte la durée et le prix formatés, dont l'espace insécable varie d'une
    // version d'ICU à l'autre.
    const prestation = page.getByRole('radio').first();
    await expect(prestation).toBeEnabled({ timeout: 20_000 });
    await prestation.locator('xpath=ancestor::label[1]').click();
    await page
      .getByRole('button', { name: libelle('fr', 'booking.tunnel.serviceStep.submit') })
      .click();

    // Étape 2 — le premier jour ouvert, puis son premier créneau.
    const etape = page.getByRole('region', {
      name: libelle('fr', 'booking.tunnel.slotStep.label'),
    });
    // Les deux grilles de l'étape se désignent par leur nom accessible, et les
    // journées fermées par `aria-disabled` — mêmes repères que `scene.ts`, pour
    // la même raison : ni le rang ni un décompte pluriel ne survivent au
    // changement de langue.
    const bande = etape.getByRole('grid', {
      name: debuteParLibelle('fr', 'booking.tunnel.dateBand.gridLabel'),
    });
    await expect(bande).toBeVisible({ timeout: 20_000 });

    const jourOuvert = bande.locator('button:not([aria-disabled="true"])').first();
    await expect(jourOuvert).toBeVisible({ timeout: 20_000 });
    await jourOuvert.click();

    const creneau = etape
      .getByRole('grid', { name: debuteParLibelle('fr', 'booking.tunnel.slotPicker.dayHeading') })
      .getByRole('gridcell')
      .locator('button')
      .first();
    await expect(creneau).toBeVisible();
    await creneau.click();

    // L'écran qui suit rappelle les choix : c'est lui qu'on va relire après la
    // bascule. L'adresse, elle, porte l'étape et les trois choix (#733).
    await expect(
      page.getByRole('heading', { level: 1, name: libelle('fr', 'booking.tunnel.gateStep.title') }),
    ).toBeVisible({ timeout: 20_000 });

    const avant = new URL(page.url()).searchParams;
    const prestationChoisie = avant.get('prestation');
    const creneauChoisi = avant.get('creneau');

    expect(prestationChoisie, 'L’adresse ne porte pas la prestation retenue.').not.toBeNull();
    expect(creneauChoisi, 'L’adresse ne porte pas le créneau retenu.').not.toBeNull();

    // La bascule — le sélecteur du pied de colonne du tunnel (#846). Chaque
    // langue y est nommée dans la sienne, et les deux catalogues portent les
    // mêmes valeurs : « English » se cherche donc de la même façon quelle que
    // soit la langue affichée.
    await page
      .getByRole('button', { name: libelle('fr', 'locale.names.en'), exact: true })
      .click();

    // L'écran est passé à l'anglais…
    await expect(
      page.getByRole('heading', { level: 1, name: libelle('en', 'booking.tunnel.gateStep.title') }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // … et les trois choix sont toujours là, à la même étape. C'est l'adresse
    // qui en fait foi : elle est écrite par le tunnel à partir de son état, et
    // elle survivrait à un rechargement comme à un lien partagé.
    const apres = new URL(page.url()).searchParams;

    expect(apres.get('prestation')).toBe(prestationChoisie);
    expect(apres.get('creneau')).toBe(creneauChoisi);
    expect(apres.get('praticien')).toBe(avant.get('praticien'));
    expect(apres.get('etape')).toBe(avant.get('etape'));
  });
});
