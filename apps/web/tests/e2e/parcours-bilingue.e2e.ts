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
 *
 * ## Et, depuis #1141, la place que le sélecteur occupe
 *
 * Le sélecteur est au pied de la colonne du tunnel, derrière la barre collante
 * du CTA. La barre annulait la gouttière basse de la page par une marge négative
 * — elle fermait la colonne, et c'était son rôle —, et cette marge s'est mise à
 * mordre sur le sélecteur dès que #846 l'a posé derrière elle : 20 px de tête
 * sous une barre opaque, à 360 px, dans les deux langues. La dernière suite
 * ci-dessous relève les boîtes au navigateur et tient les **trois** propriétés à
 * la fois — le sélecteur entièrement dégagé de la barre, la gouttière basse de
 * la page conservée sous lui, et la barre toujours au ras de la fenêtre tant que
 * l'étape déborde. Aucun test unitaire ne peut le faire : `jsdom` n'a pas de
 * moteur de mise en page, et une marge négative n'y a pas de géométrie.
 *
 * Les trois ensemble, parce que chacune seule se satisfait d'une correction qui
 * casse une autre : supprimer la marge et décoller la barre, ou la déplacer d'un
 * cran et coller les deux boutons de langue au bord de l'écran.
 *
 * Elle est ici et non dans une suite à part parce que la mesure se prend dans
 * les **deux** langues : c'est un pied de colonne bilingue, et « Français » et
 * « English » n'ont ni la même largeur ni les mêmes ascendantes.
 */

import type { Page } from '@playwright/test';

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

/** Le pouce : 360 px de large, la mesure de référence des tickets de mise en page. */
const POUCE = { width: 360, height: 640 } as const;

/**
 * La même largeur, une fenêtre trop basse pour l'étape.
 *
 * C'est la seule façon d'observer la barre **collée** sans dépendre du nombre de
 * prestations du jeu d'essai : `.spa-booking` vaut `min-block-size: 100dvh` et
 * `.spa-booking__main` grandit pour la remplir, si bien qu'une étape courte ne
 * fait jamais déborder la page et ne colle jamais rien.
 */
const POUCE_COURT = { width: 360, height: 360 } as const;

interface Boites {
  /** Le bas de la barre collante, dans la fenêtre. */
  readonly barreBas: number;
  /** Le haut du sélecteur de langue, dans la fenêtre. */
  readonly selecteurHaut: number;
  /** Son bas, et celui de la page qui le contient : leur écart est la gouttière basse. */
  readonly selecteurBas: number;
  readonly principalBas: number;
  /** `padding-block-end` de `.spa-booking__main`, lu et non supposé. */
  readonly gouttiere: number;
  readonly fenetre: number;
  readonly document: number;
}

/**
 * Toutes les boîtes en un seul relevé.
 *
 * `getBoundingClientRect` plutôt que `boundingBox()` de Playwright : il faut les
 * trois boîtes, la gouttière calculée et la hauteur de la fenêtre au même
 * instant — quatre appels successifs ne mesureraient pas la même page.
 */
async function releverLesBoites(page: Page): Promise<Boites> {
  return page.evaluate(() => {
    const principal = document.querySelector('.spa-booking__main');
    const barre = document.querySelector('.spa-booking__bar');
    const selecteur = document.querySelector('.spa-booking__content > .spa-locale-switcher');

    if (principal === null || barre === null || selecteur === null) {
      throw new Error('Le pied de colonne du tunnel est incomplet : barre ou sélecteur absent.');
    }

    return {
      barreBas: barre.getBoundingClientRect().bottom,
      selecteurHaut: selecteur.getBoundingClientRect().top,
      selecteurBas: selecteur.getBoundingClientRect().bottom,
      principalBas: principal.getBoundingClientRect().bottom,
      gouttiere: Number.parseFloat(getComputedStyle(principal).paddingBlockEnd),
      fenetre: window.innerHeight,
      document: document.documentElement.scrollHeight,
    };
  });
}

for (const langue of ['fr', 'en'] as const) {
  test.describe(`Le sélecteur de langue au pied du tunnel, à 360 px (${langue})`, () => {
    test.use({ locale: langue === 'fr' ? 'fr-FR' : 'en-US', viewport: POUCE });

    test('reste entièrement visible, sans décoller la barre du bas de la fenêtre', async ({
      page,
    }) => {
      await page.goto(chemins.reservation());

      // Une prestation retenue, sinon le bouton de la barre porte encore le
      // libellé d'attente (`submitDisabled`) et la colonne n'a pas sa hauteur.
      const prestation = page.getByRole('radio').first();
      await expect(prestation).toBeEnabled({ timeout: 20_000 });
      await prestation.locator('xpath=ancestor::label[1]').click();

      await expect(
        page.getByRole('button', { name: libelle(langue, 'booking.tunnel.serviceStep.submit') }),
      ).toBeEnabled();

      // **Au bas du défilement**, et non en haut de page : c'est là, et là
      // seulement, que le chevauchement de #1141 se voit. Tant que l'étape
      // déborde, la barre est collée au bas de la fenêtre et le sélecteur est
      // hors champ, cent pixels plus bas — leurs deux boîtes ne se rencontrent
      // pas, et la comparaison serait vraie même avec la marge fautive rendue à
      // la barre. Une fois en bas, la barre est revenue à sa position de flux,
      // le sélecteur la suit, et l'écart mesuré est celui que la cliente voit.
      await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });

      const boites = await releverLesBoites(page);

      // 1. Le défaut de #1141 : le sélecteur commençait 20 px au-dessus du bas
      //    d'une barre opaque, qui lui mangeait ses ascendantes.
      expect(
        boites.selecteurHaut,
        `Le sélecteur commence à ${boites.selecteurHaut} px, sous une barre qui finit à ${boites.barreBas} px.`,
      ).toBeGreaterThanOrEqual(boites.barreBas);

      // 2. Et la page garde sa gouttière basse **sous** le sélecteur. C'est ce
      //    que l'autre correction possible aurait pris : déplacer la marge
      //    négative de la barre sur le dernier bloc de la colonne découvre le
      //    sélecteur tout aussi bien, et le colle au bord de l'écran.
      //
      //    `>=` et non une égalité : `.spa-booking__main` est `flex: 1 0 auto`
      //    dans une coquille à `min-block-size: 100dvh`, et s'étire donc au-delà
      //    de son contenu dès qu'une étape courte tient dans la fenêtre. La
      //    gouttière est un plancher, jamais un écart exact.
      expect(
        boites.principalBas - boites.selecteurBas,
        `Le sélecteur finit à ${boites.principalBas - boites.selecteurBas} px du bas de la page, pour une gouttière de ${boites.gouttiere} px.`,
      ).toBeGreaterThanOrEqual(boites.gouttiere);

      // 3. Reste à voir la barre **collée**, ce qu'une fenêtre trop basse pour
      //    l'étape garantit. Son bord inférieur est alors celui de la fenêtre.
      await page.setViewportSize(POUCE_COURT);
      await page.evaluate(() => window.scrollTo(0, 0));

      const collee = await releverLesBoites(page);

      expect(
        collee.document,
        'L’étape tient encore dans la fenêtre : la barre n’est pas collée.',
      ).toBeGreaterThan(collee.fenetre);
      expect(
        collee.barreBas,
        `La barre s’arrête à ${collee.barreBas} px pour une fenêtre de ${collee.fenetre} px.`,
      ).toBeCloseTo(collee.fenetre, 0);
    });
  });
}
